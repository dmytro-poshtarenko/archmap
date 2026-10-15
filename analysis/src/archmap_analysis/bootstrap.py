"""
Bootstrap over files. Calls in one file depend on each other (the same
wrapper, the same base address), so whole files are drawn with replacement,
and every run of the method is evaluated on the same draws (paired).
"""

from dataclasses import dataclass

import numpy as np
import pandas as pd

DEFAULT_REPLICATES = 10_000

#: Hypothesis 1: the cases only one component resolves.
CASE_GROUPS = {"rules": (1, 2, 3), "infra": (4, 7), "llm": (5, 6)}


@dataclass
class Bootstrap:
    """Replicate values of the sums every rate is built from, per file draw."""

    runs: list[str]
    #: replicate sums of the reference: |C*|, |C*₁₋₇|, |C*₈| (weighted)
    cstar: np.ndarray
    cstar17: np.ndarray
    cstar8: np.ndarray
    #: replicate sums per run: linked, correct, correct among cases 1–7
    predicted: dict[str, np.ndarray]
    correct: dict[str, np.ndarray]
    correct17: dict[str, np.ndarray]
    #: replicate sums of C* in each group of cases of hypothesis 1
    groups: dict[str, np.ndarray]

    def recall17(self, run: str) -> np.ndarray:
        return _div(self.correct17[run], self.cstar17)

    def recall(self, run: str) -> np.ndarray:
        return _div(self.correct[run], self.cstar)

    def precision(self, run: str) -> np.ndarray:
        return _div(self.correct[run], self.predicted[run])

    def theta(self) -> np.ndarray:
        return _div(self.cstar8, self.cstar)

    def share(self, group: str) -> np.ndarray:
        """Share of the recoverable links (cases 1–7) in a group of cases."""
        return _div(self.groups[group], self.cstar17)


def _div(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(b > 0, a / np.where(b > 0, b, 1), np.nan)


def file_draws(n_files: int, replicates: int, seed: int) -> np.ndarray:
    """How often each file is drawn in each replicate: a (replicates × files) matrix of counts."""
    rng = np.random.default_rng(seed)
    return rng.multinomial(n_files, np.full(n_files, 1.0 / n_files), size=replicates)


def cluster_bootstrap(wide: pd.DataFrame, runs: list[str], replicates: int = DEFAULT_REPLICATES, seed: int = 11, weighted: bool = True) -> Bootstrap:
    """
    `wide` is `data.paired(...)`: one row per unit with `predicted@<run>` and
    `correct@<run>` columns. Each replicate draws as many files as the sample
    has, with replacement; a file drawn k times counts k times.
    """
    w = wide["weight"].to_numpy(float) if weighted else np.ones(len(wide))
    in_c = wide["in_cstar"].to_numpy(int) == 1
    case8 = (wide["label_case"] == 8).to_numpy()
    files, index = np.unique(wide["file"].to_numpy(str), return_inverse=True)
    sums = lambda values: np.bincount(index, weights=values, minlength=len(files))  # noqa: E731
    draws = file_draws(len(files), replicates, seed)
    rep = lambda values: draws @ sums(values)  # noqa: E731
    out = Bootstrap(
        runs=runs,
        cstar=rep(w * in_c),
        cstar17=rep(w * (in_c & ~case8)),
        cstar8=rep(w * (in_c & case8)),
        predicted={},
        correct={},
        correct17={},
        groups={g: rep(w * (in_c & wide["label_case"].isin(cases).to_numpy())) for g, cases in CASE_GROUPS.items()},
    )
    for run in runs:
        pred = wide[f"predicted@{run}"].to_numpy(int) == 1
        corr = wide[f"correct@{run}"].to_numpy(int) == 1
        out.predicted[run] = rep(w * pred)
        out.correct[run] = rep(w * corr)
        out.correct17[run] = rep(w * (corr & ~case8))
    return out


def interval(values: np.ndarray, level: float = 0.95) -> tuple[float, float]:
    """Percentile interval of replicate values, ignoring replicates where the rate is undefined."""
    tail = (1 - level) / 2 * 100
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return (float("nan"), float("nan"))
    lo, hi = np.percentile(finite, [tail, 100 - tail])
    return (float(lo), float(hi))
