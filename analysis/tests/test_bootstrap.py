import numpy as np
import pandas as pd
import pytest

from archmap_analysis.bootstrap import cluster_bootstrap, file_draws, interval
from archmap_analysis.data import paired
from archmap_analysis.stats import wilson


def runs_of(n_files=60, per_file=3, p=0.8, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for f in range(n_files):
        for i in range(per_file):
            hit = int(rng.random() < p)
            rows.append({"unit": f"r:f{f}.ts:{i}", "file": f"r:f{f}.ts", "stratum": "http", "weight": 1.0, "label_type": "http",
                         "label_case": 1, "in_cstar": 1, "predicted": 1, "correct": hit})
    df = pd.DataFrame(rows)
    return {"a": df, "b": df.copy()}


def test_the_same_seed_gives_the_same_replicates():
    wide = paired(runs_of())
    one = cluster_bootstrap(wide, ["a"], replicates=2000, seed=11)
    two = cluster_bootstrap(wide, ["a"], replicates=2000, seed=11)
    other = cluster_bootstrap(wide, ["a"], replicates=2000, seed=12)
    assert np.array_equal(one.recall17("a"), two.recall17("a"))
    assert not np.array_equal(one.recall17("a"), other.recall17("a"))
    # the interval itself barely moves with the seed
    assert interval(one.recall17("a")) == pytest.approx(interval(other.recall17("a")), abs=0.02)


def test_draws_keep_the_number_of_files():
    draws = file_draws(7, 100, seed=1)
    assert draws.shape == (100, 7)
    assert (draws.sum(axis=1) == 7).all()


def test_paired_runs_share_their_draws():
    wide = paired(runs_of())
    boot = cluster_bootstrap(wide, ["a", "b"], replicates=1000, seed=3)
    assert np.allclose(boot.recall17("a") - boot.recall17("b"), 0)


def test_one_unit_per_file_comes_close_to_wilson():
    wide = paired(runs_of(n_files=300, per_file=1, p=0.85, seed=5))
    boot = cluster_bootstrap(wide, ["a"], replicates=4000, seed=11)
    k = int(wide["correct@a"].sum())
    assert interval(boot.recall17("a")) == pytest.approx(wilson(k, 300), abs=0.015)
