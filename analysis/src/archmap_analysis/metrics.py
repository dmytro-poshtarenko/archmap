"""Recall, precision and the case-8 share, as formulas (5.1)–(5.3) of the plan define them."""

from dataclasses import asdict, dataclass

import pandas as pd


@dataclass(frozen=True)
class Rates:
    cstar: float
    cstar17: float
    cstar8: float
    predicted: float
    correct: float
    correct17: float
    recall: float | None
    recall17: float | None
    precision: float | None
    theta: float | None

    def as_dict(self) -> dict:
        return asdict(self)


def _ratio(a: float, b: float) -> float | None:
    return None if b == 0 else a / b


def rates(df: pd.DataFrame, weighted: bool = True, predicted: str = "predicted", correct: str = "correct") -> Rates:
    """
    R = |{c ∈ C*: f(c) = g(c)}| / |C*|, P = |{c ∈ C*: f(c) = g(c)}| / |{c: f(c) ≠ ∅}|,
    θ = |C*₈| / |C*| and R₁₋₇ over C* without case 8; each unit weighted by
    the inverse of its stratum's sampling share unless `weighted` is false.
    """
    w = df["weight"] if weighted else pd.Series(1.0, index=df.index)
    in_c = df["in_cstar"] == 1
    case8 = df["label_case"] == 8
    cstar = float(w[in_c].sum())
    cstar8 = float(w[in_c & case8].sum())
    cstar17 = cstar - cstar8
    pred = float(w[df[predicted] == 1].sum())
    corr_mask = df[correct] == 1
    corr = float(w[corr_mask].sum())
    corr17 = float(w[corr_mask & ~case8].sum())
    return Rates(cstar, cstar17, cstar8, pred, corr, corr17, _ratio(corr, cstar), _ratio(corr17, cstar17), _ratio(corr, pred), _ratio(cstar8, cstar))


def recall_by_case(df: pd.DataFrame, correct: str = "correct") -> pd.DataFrame:
    """Unweighted recall per reference case: the cases explain what the method misses."""
    c = df[df["in_cstar"] == 1]
    out = c.groupby("label_case").agg(n=("unit", "count"), correct=(correct, "sum")).reset_index()
    out["label_case"] = out["label_case"].astype(int)
    out["recall"] = out["correct"] / out["n"]
    return out


def predicted_shares(df: pd.DataFrame, weighted: bool = True) -> dict[str, float]:
    """
    Hypothesis 1: the share of recoverable links (cases 1–7) that only one
    component resolves — rules cases 1–3, infrastructure 4 and 7, the
    language model 5 and 6.
    """
    w = df["weight"] if weighted else pd.Series(1.0, index=df.index)
    c = df[(df["in_cstar"] == 1) & (df["label_case"] != 8)]
    total = float(w[c.index].sum())
    groups = {"rules": {1, 2, 3}, "infra": {4, 7}, "llm": {5, 6}}
    return {k: (float(w[c.index[c["label_case"].isin(v)]].sum()) / total if total else 0.0) for k, v in groups.items()}
