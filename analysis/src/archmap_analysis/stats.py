"""Intervals and tests that ignore the dependence within files, reported for comparison."""

import numpy as np
from statsmodels.stats.contingency_tables import mcnemar as _mcnemar
from statsmodels.stats.multitest import multipletests
from statsmodels.stats.proportion import proportion_confint


def wilson(k: int, n: int, level: float = 0.95) -> tuple[float, float]:
    """Wilson score interval of a proportion k/n."""
    if n == 0:
        return (float("nan"), float("nan"))
    lo, hi = proportion_confint(k, n, alpha=1 - level, method="wilson")
    return (float(lo), float(hi))


def mcnemar(first: np.ndarray, second: np.ndarray) -> dict:
    """
    McNemar's test of two runs on the same units: `first` and `second` are
    0/1 correctness. Exact (binomial) when fewer than 25 units disagree.
    """
    a = np.asarray(first, dtype=bool)
    b = np.asarray(second, dtype=bool)
    only_first = int(np.sum(a & ~b))
    only_second = int(np.sum(~a & b))
    table = [[int(np.sum(a & b)), only_first], [only_second, int(np.sum(~a & ~b))]]
    exact = only_first + only_second < 25
    result = _mcnemar(table, exact=exact, correction=not exact)
    return {"only_first": only_first, "only_second": only_second, "statistic": float(result.statistic), "pvalue": float(result.pvalue), "exact": exact}


def holm(pvalues: list[float], alpha: float = 0.05) -> tuple[list[bool], list[float]]:
    """Holm's step-down adjustment: which hypotheses are rejected, and the adjusted p-values."""
    reject, adjusted, _, _ = multipletests(pvalues, alpha=alpha, method="holm")
    return [bool(x) for x in reject], [float(x) for x in adjusted]


def cohens_kappa(first: list[str], second: list[str]) -> float:
    """Cohen's kappa of two annotators over the same items."""
    if len(first) != len(second) or not first:
        raise ValueError("kappa needs two equally long, non-empty lists")
    categories = sorted(set(first) | set(second))
    pos = {c: i for i, c in enumerate(categories)}
    table = np.zeros((len(categories), len(categories)))
    for x, y in zip(first, second, strict=True):
        table[pos[x], pos[y]] += 1
    n = table.sum()
    observed = np.trace(table) / n
    expected = float(np.sum(table.sum(axis=0) * table.sum(axis=1))) / n**2
    return 1.0 if expected == 1 else float((observed - expected) / (1 - expected))
