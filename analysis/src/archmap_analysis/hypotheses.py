"""
Decisions on the hypotheses from the paired file bootstrap. Each check ends
confirmed, refuted, or undetermined when the interval allows no conclusion.
"""

from dataclasses import dataclass, field

import numpy as np

from .bootstrap import Bootstrap, interval
from .stats import holm

CONFIRMED = "confirmed"
REFUTED = "refuted"
UNDETERMINED = "undetermined"
PARTIAL = "partially confirmed"


@dataclass
class Decision:
    verdict: str
    details: dict = field(default_factory=dict)


def _share(values: np.ndarray, condition) -> float:
    finite = values[np.isfinite(values)]
    return float(np.mean(condition(finite))) if finite.size else float("nan")


def main_hypothesis(boot: Bootstrap, run: str, threshold: float = 0.90, level: float = 0.95) -> Decision:
    """Confirmed when the lower bounds of R₁₋₇ and P are at least the threshold; refuted when an upper bound is below it."""
    r = interval(boot.recall17(run), level)
    p = interval(boot.precision(run), level)
    if r[0] >= threshold and p[0] >= threshold:
        verdict = CONFIRMED
    elif r[1] < threshold or p[1] < threshold:
        verdict = REFUTED
    else:
        verdict = UNDETERMINED
    return Decision(verdict, {"run": run, "threshold": threshold, "recall17": r, "precision": p})


def hypothesis1(
    boot: Bootstrap,
    full: str,
    without: dict[str, str],
    shares: dict[str, float] | None = None,
    ratio_min: float = 0.8,
    small_share: float = 0.05,
    tolerance: float = 0.03,
    alpha: float = 0.05,
) -> Decision:
    """
    For each component j: the drop of R₁₋₇ when j is removed, divided by the
    predicted share (cases only j resolves), must be at least `ratio_min`;
    for a share below `small_share` the drop itself must stay within
    `tolerance`. Precision without j may rise by at most `tolerance`.
    One-sided bootstrap p-values, Holm-adjusted over the components, decide.

    The share is measured on the same draws as the drop, so the ratio
    reflects substitution between components, not the sampling noise of the
    share; `shares` fixes it instead (the values sent before the test run).
    """
    rows = {}
    for j, run in without.items():
        drop = boot.recall17(full) - boot.recall17(run)
        rise = boot.precision(run) - boot.precision(full)
        replicate_share = np.full_like(drop, shares[j]) if shares is not None else boot.share(j)
        finite = replicate_share[np.isfinite(replicate_share)]
        share = shares[j] if shares is not None else float(np.median(finite)) if finite.size else 0.0
        if share >= small_share:
            stat = drop / replicate_share
            p_confirm = _share(stat, lambda x: x < ratio_min)
            p_refute = _share(stat, lambda x: x >= ratio_min)
            measure = {"ratio": interval(stat), "ratio_bonferroni": interval(stat, 1 - alpha / len(without))}
        else:
            p_confirm = _share(drop, lambda x: x > tolerance)
            p_refute = _share(drop, lambda x: x <= tolerance)
            measure = {"drop_only": True}
        rows[j] = {
            "run": run,
            "share": share,
            "drop": interval(drop),
            "precision_rise": interval(rise),
            "p_confirm": p_confirm,
            "p_refute": p_refute,
            "p_precision_ok": _share(rise, lambda x: x > tolerance),
            "p_precision_bad": _share(rise, lambda x: x <= tolerance),
            **measure,
        }
    names = list(rows)
    confirm, _ = holm([rows[j]["p_confirm"] for j in names], alpha)
    refute, _ = holm([rows[j]["p_refute"] for j in names], alpha)
    precision_ok, _ = holm([rows[j]["p_precision_ok"] for j in names], alpha)
    precision_bad, _ = holm([rows[j]["p_precision_bad"] for j in names], alpha)
    for i, j in enumerate(names):
        if refute[i] or precision_bad[i]:
            rows[j]["verdict"] = REFUTED
        elif confirm[i] and precision_ok[i]:
            rows[j]["verdict"] = CONFIRMED
        else:
            rows[j]["verdict"] = UNDETERMINED
    verdicts = [rows[j]["verdict"] for j in names]
    verdict = REFUTED if REFUTED in verdicts else CONFIRMED if all(v == CONFIRMED for v in verdicts) else UNDETERMINED
    return Decision(verdict, {"components": rows, "ratio_min": ratio_min, "small_share": small_share, "tolerance": tolerance})


def hypothesis2(boot: Bootstrap, no_llm: str, select: str, free: str, tolerance: float = 0.03) -> Decision:
    """
    Confirmed when select mode loses at most `tolerance` of precision against
    the method without the model and free mode is significantly less precise
    than select mode. Refuted when select mode loses more, or when free mode
    is no less precise than select mode within `tolerance`.
    """
    d_select = interval(boot.precision(select) - boot.precision(no_llm))
    d_free = interval(boot.precision(free) - boot.precision(select))
    select_ok = d_select[0] >= -tolerance
    free_worse = d_free[1] < 0
    if d_select[1] < -tolerance or (d_free[0] >= -tolerance and not free_worse):
        verdict = REFUTED
    elif select_ok and free_worse:
        verdict = CONFIRMED
    else:
        verdict = UNDETERMINED
    return Decision(
        verdict,
        {
            "precision_select_minus_no_llm": d_select,
            "precision_free_minus_select": d_free,
            "recall17_select_minus_no_llm": interval(boot.recall17(select) - boot.recall17(no_llm)),
            "recall17_free_minus_select": interval(boot.recall17(free) - boot.recall17(select)),
            "tolerance": tolerance,
        },
    )
