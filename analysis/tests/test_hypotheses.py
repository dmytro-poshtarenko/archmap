import numpy as np
import pandas as pd

from archmap_analysis.bootstrap import cluster_bootstrap
from archmap_analysis.data import paired
from archmap_analysis.hypotheses import CONFIRMED, REFUTED, hypothesis1, hypothesis2, main_hypothesis
from archmap_analysis.metrics import predicted_shares


def sample(n_files=150, seed=0):
    """Two units per file; cases 1–3 for 70 %, 4 and 7 for 15 %, 5 and 6 for 15 %."""
    rng = np.random.default_rng(seed)
    cases = rng.choice([1, 2, 3, 4, 7, 5, 6], size=2 * n_files, p=[0.3, 0.2, 0.2, 0.1, 0.05, 0.1, 0.05])
    return pd.DataFrame({
        "unit": [f"r:f{i // 2}.ts:{i}" for i in range(2 * n_files)],
        "file": [f"r:f{i // 2}.ts" for i in range(2 * n_files)],
        "stratum": "http", "weight": 1.0, "label_type": "http",
        "label_case": cases, "in_cstar": 1,
    })


def run(base, correct):
    df = base.copy()
    df["correct"] = correct.astype(int)
    df["predicted"] = 1
    return df


def test_components_that_cannot_replace_each_other_confirm_hypothesis_1():
    base = sample()
    c = base["label_case"]
    runs = {
        "full": run(base, np.ones(len(base), bool)),
        "no-rules": run(base, ~c.isin([1, 2, 3])),
        "no-infra": run(base, ~c.isin([4, 7])),
        "no-llm": run(base, ~c.isin([5, 6])),
    }
    # a missed link is no link: the method answers nothing there
    for name in ("no-rules", "no-infra", "no-llm"):
        runs[name]["predicted"] = runs[name]["correct"]
    boot = cluster_bootstrap(paired(runs), list(runs), replicates=2000, seed=11)
    d = hypothesis1(boot, "full", {"rules": "no-rules", "infra": "no-infra", "llm": "no-llm"})
    assert d.verdict == CONFIRMED, d.details
    # with the shares fixed beforehand, the ratio carries their sampling noise too
    fixed = hypothesis1(boot, "full", {"rules": "no-rules", "infra": "no-infra", "llm": "no-llm"}, predicted_shares(runs["full"]))
    assert fixed.details["components"]["rules"]["verdict"] == CONFIRMED
    assert main_hypothesis(boot, "full").verdict == CONFIRMED


def test_a_component_the_others_replace_refutes_hypothesis_1():
    base = sample()
    c = base["label_case"]
    runs = {
        "full": run(base, np.ones(len(base), bool)),
        "no-rules": run(base, ~c.isin([1, 2, 3])),
        "no-infra": run(base, np.ones(len(base), bool)),  # nothing lost: the others compensate
        "no-llm": run(base, ~c.isin([5, 6])),
    }
    boot = cluster_bootstrap(paired(runs), list(runs), replicates=2000, seed=11)
    d = hypothesis1(boot, "full", {"rules": "no-rules", "infra": "no-infra", "llm": "no-llm"})
    assert d.details["components"]["infra"]["verdict"] == REFUTED
    assert d.verdict == REFUTED
    assert main_hypothesis(boot, "no-rules").verdict == REFUTED


def test_hypothesis_2_follows_the_precision_of_the_modes():
    base = sample()
    rng = np.random.default_rng(4)
    good = rng.random(len(base)) < 0.95
    worse = rng.random(len(base)) < 0.75
    runs = {"no-llm": run(base, good), "select": run(base, good), "free": run(base, worse)}
    boot = cluster_bootstrap(paired(runs), list(runs), replicates=2000, seed=11)
    assert hypothesis2(boot, "no-llm", "select", "free").verdict == CONFIRMED
    runs["free"] = run(base, good)
    boot = cluster_bootstrap(paired(runs), list(runs), replicates=2000, seed=11)
    assert hypothesis2(boot, "no-llm", "select", "free").verdict == REFUTED
