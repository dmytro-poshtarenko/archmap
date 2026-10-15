import numpy as np
import pandas as pd

from archmap_analysis.h3 import decision, gee_length, spearman_by_model
from archmap_analysis.hypotheses import PARTIAL


def synthetic(seed=0):
    """12 controllers × 6 lengths × 8 routes; model a loses routes as files grow, model b does not."""
    rng = np.random.default_rng(seed)
    rows = []
    for model, slope in (("a", -1.2), ("b", 0.0)):
        for ctrl in range(12):
            effect = rng.normal(0, 0.3)
            for level, tokens in enumerate([1000, 2000, 4000, 8000, 16000, 32000]):
                for route in range(8):
                    position = route / 7
                    logit = 3.0 + slope * np.log(tokens / 1000) + effect
                    rows.append({"controller": f"c{ctrl}", "variant": f"c{ctrl}-{level}", "model": model, "tokens": tokens,
                                 "position": position, "route": route, "found": int(rng.random() < 1 / (1 + np.exp(-logit)))})
    return pd.DataFrame(rows)


def test_gee_finds_the_fall_only_where_it_exists():
    slopes = gee_length(synthetic()).set_index("model")
    assert slopes.loc["a", "falls"]
    assert slopes.loc["a", "slope"] < 0
    assert not slopes.loc["b", "falls"]
    assert decision(slopes.reset_index()) == PARTIAL
    rho = spearman_by_model(synthetic()).set_index("model")
    assert rho.loc["a", "rho"] < 0


def test_report_runs_hypothesis_3_alone_and_keeps_the_series_apart(tmp_path):
    import json

    from archmap_analysis.report import main

    df = synthetic()
    df["series"] = "length"
    pos = df[df["tokens"] == 4000].copy()
    pos["series"] = "position"
    pos["level"] = ["start", "middle", "end"] * (len(pos) // 3) + ["start"] * (len(pos) % 3)
    files = []
    for model in ("a", "b"):
        f = tmp_path / f"h3-{model}.csv"
        pd.concat([df[df["model"] == model], pos[pos["model"] == model]]).to_csv(f, index=False)
        files.append(str(f))
    out = tmp_path / "out"
    assert main(["--target", "toy", "--h3", *files, "--out", str(out)]) == 0
    summary = json.loads((out / "summary.json").read_text())
    assert summary["h3"]["verdict"] == PARTIAL
    assert summary["h3"]["split_files_for"] == {"a": True, "b": False}
    assert (out / "h3_position.csv").exists() and (out / "h3_length.svg").exists()
