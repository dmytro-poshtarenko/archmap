"""
Hypothesis 3: does the probability that the model extracts a route fall
with the length of the file? The unit is a route; routes of one controller
are correlated, so a logistic GEE grouped by controller estimates the slope
of log(tokens) for each model.
"""

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from scipy.stats import norm, spearmanr

from .hypotheses import CONFIRMED, PARTIAL, REFUTED

REQUIRED = ["controller", "variant", "model", "tokens", "position", "found"]


def gee_length(df: pd.DataFrame, alpha: float = 0.05) -> pd.DataFrame:
    """
    Fits `found ~ log(tokens) + position` with an exchangeable working
    correlation within controllers, for each model on its own variants (the
    cloud model may run a smaller kit), and returns the slope of log(tokens)
    with its standard error and one-sided p-value for a fall. A model that
    found every route has nothing to fit: its recall does not fall.
    """
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"missing columns {missing}")
    d = df.copy()
    d["log_tokens"] = np.log(d["tokens"].astype(float))
    d["found"] = d["found"].astype(int)
    rows = []
    for m, g in sorted(d.groupby("model"), key=lambda x: x[0]):
        if g["found"].nunique() < 2:
            rows.append({"model": m, "slope": float("nan"), "se": float("nan"), "z": float("nan"), "p_fall": 1.0, "falls": False})
            continue
        fit = smf.gee(
            "found ~ log_tokens + position",
            groups="controller",
            data=g,
            family=sm.families.Binomial(),
            cov_struct=sm.cov_struct.Exchangeable(),
        ).fit()
        slope = float(fit.params["log_tokens"])
        se = float(fit.bse["log_tokens"])
        z = slope / se if se > 0 else float("nan")
        p_fall = float(norm.cdf(z))
        rows.append({"model": m, "slope": slope, "se": se, "z": z, "p_fall": p_fall, "falls": bool(p_fall < alpha and slope < 0)})
    return pd.DataFrame(rows)


def spearman_by_model(df: pd.DataFrame) -> pd.DataFrame:
    """Descriptive only: rank correlation of file length with the share of routes found per variant."""
    rows = []
    for m, g in df.groupby("model"):
        per_variant = g.groupby("variant").agg(tokens=("tokens", "first"), recall=("found", "mean"))
        rho, p = spearmanr(per_variant["tokens"], per_variant["recall"])
        rows.append({"model": m, "variants": len(per_variant), "rho": float(rho), "p": float(p)})
    return pd.DataFrame(rows)


def decision(slopes: pd.DataFrame) -> str:
    falls = slopes["falls"].tolist()
    if all(falls):
        return CONFIRMED
    return PARTIAL if any(falls) else REFUTED
