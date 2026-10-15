import pytest

from archmap_analysis.metrics import predicted_shares, rates, recall_by_case


def test_toy_set_matches_the_hand_computed_values(toy):
    u = rates(toy, weighted=False)
    assert (u.cstar, u.cstar17, u.cstar8, u.predicted, u.correct, u.correct17) == (5, 4, 1, 5, 2, 2)
    assert u.recall == pytest.approx(0.4)
    assert u.recall17 == pytest.approx(0.5)
    assert u.precision == pytest.approx(0.4)
    assert u.theta == pytest.approx(0.2)
    w = rates(toy, weighted=True)
    assert (w.cstar, w.cstar17, w.cstar8, w.predicted, w.correct) == (34, 24, 10, 34, 12)
    assert w.recall17 == pytest.approx(0.5)
    assert w.precision == pytest.approx(12 / 34)


def test_recall_by_case(toy):
    t = recall_by_case(toy).set_index("label_case")
    assert t.loc[2, "n"] == 2 and t.loc[2, "correct"] == 1
    assert t.loc[8, "recall"] == 0


def test_predicted_shares_cover_the_recoverable_cases(toy):
    # C*1-7 weighted: case 1 (10) + case 2 (10 + 2) + case 5 (2) = 24
    s = predicted_shares(toy)
    assert s["rules"] == pytest.approx(22 / 24)
    assert s["llm"] == pytest.approx(2 / 24)
    assert s["infra"] == 0
