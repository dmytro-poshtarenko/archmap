import numpy as np
import pytest

from archmap_analysis.stats import cohens_kappa, holm, mcnemar, wilson


def test_wilson_interval():
    lo, hi = wilson(8, 10)
    assert lo == pytest.approx(0.4902, abs=1e-4)
    assert hi == pytest.approx(0.9433, abs=1e-4)


def test_cohens_kappa_on_a_two_by_two_table():
    # yes/yes 20, yes/no 5, no/yes 10, no/no 15: p_o = 0.7, p_e = 0.5, kappa = 0.4
    a = ["y"] * 25 + ["n"] * 25
    b = ["y"] * 20 + ["n"] * 5 + ["y"] * 10 + ["n"] * 15
    assert cohens_kappa(a, b) == pytest.approx(0.4)
    assert cohens_kappa(["x", "y"], ["x", "y"]) == pytest.approx(1.0)


def test_holm_adjustment():
    reject, adjusted = holm([0.01, 0.04, 0.03])
    assert adjusted == pytest.approx([0.03, 0.06, 0.06])
    assert reject == [True, False, False]


def test_mcnemar_exact_for_few_disagreements():
    first = np.array([1] * 10 + [1] + [0] * 6 + [0] * 3)
    second = np.array([1] * 10 + [0] + [1] * 6 + [0] * 3)
    t = mcnemar(first, second)
    assert (t["only_first"], t["only_second"], t["exact"]) == (1, 6, True)
    assert t["pvalue"] == pytest.approx(16 / 128)
