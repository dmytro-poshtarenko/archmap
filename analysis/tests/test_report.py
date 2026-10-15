import json

from archmap_analysis.report import main


def test_report_writes_tables_figures_and_a_summary(tmp_path, toy):
    for run in ("no-llm", "no-infra+no-llm"):
        d = tmp_path / "data" / "out" / "toy" / run / "eval" / "dev"
        d.mkdir(parents=True)
        toy.to_csv(d / "site_results.csv", index=False)
    out = tmp_path / "report"
    assert main(["--data", str(tmp_path / "data"), "--target", "toy", "--runs", "no-llm", "no-infra+no-llm", "--replicates", "500", "--out", str(out)]) == 0
    for name in ("metrics.csv", "metrics.md", "recall_by_case.csv", "mcnemar.csv", "rates.svg", "rates.png", "recall_by_case.svg", "summary.json"):
        assert (out / name).exists(), name
    summary = json.loads((out / "summary.json").read_text())
    assert summary["units"] == 7 and summary["files"] == 2
    assert "| run |" in (out / "metrics.md").read_text()
