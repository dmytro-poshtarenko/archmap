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
    Fits `found ~ log(tokens) × model + position` with an exchangeable
    working correlation within controllers and returns, per model, the slope
    of log(tokens) with its standard error and one-sided p-value for a fall.
    """
    missing = [c for c in REQUIRED if c not in df.columns]
    if missing:
        raise ValueError(f"missing columns {missing}")
    d = df.copy()
    d["log_tokens"] = np.log(d["tokens"].astype(float))
    d["found"] = d["found"].astype(int)
    models = sorted(d["model"].unique())
    fit = smf.gee(
        "found ~ log_tokens * C(model) + position",
        groups="controller",
        data=d,
        family=sm.families.Binomial(),
        cov_struct=sm.cov_struct.Exchangeable(),
    ).fit()
    params = fit.params
    cov = fit.cov_params()
    rows = []
    for m in models:
        contrast = pd.Series(0.0, index=params.index)
        contrast["log_tokens"] = 1.0
        term = f"log_tokens:C(model)[T.{m}]"
        if term in contrast.index:
            contrast[term] = 1.0
        slope = float(contrast @ params)
        se = float(np.sqrt(contrast @ cov @ contrast))
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
