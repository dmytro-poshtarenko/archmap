"""Reading the per-unit results that `archmap evaluate` writes (`site_results.csv`)."""

from pathlib import Path

import pandas as pd

#: Columns of site_results.csv, in the order the evaluator writes them.
COLUMNS = [
    "unit", "file", "repo", "path", "line", "stratum", "weight",
    "label_is_site", "label_reason", "label_type", "label_target", "label_case",
    "site", "status", "target", "alternatives", "predicted_case",
    "in_cstar", "predicted", "correct",
]


def load_units(path: Path | str) -> pd.DataFrame:
    """One evaluated run: a row per labelled unit of the sample."""
    df = pd.read_csv(path, dtype={"label_target": "string", "target": "string", "alternatives": "string"}, keep_default_na=True)
    missing = [c for c in COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: missing columns {missing}")
    for c in ("label_is_site", "in_cstar", "predicted", "correct"):
        df[c] = df[c].astype(int)
    df["weight"] = df["weight"].astype(float)
    df["label_case"] = pd.to_numeric(df["label_case"], errors="coerce")
    return df


def results_path(data_dir: Path | str, target: str, run: str, split: str) -> Path:
    return Path(data_dir) / "out" / target / run / "eval" / split / "site_results.csv"


def load_runs(data_dir: Path | str, target: str, split: str, runs: list[str]) -> dict[str, pd.DataFrame]:
    return {run: load_units(results_path(data_dir, target, run, split)) for run in runs}


def paired(runs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """
    The runs side by side on the same units: the reference columns once, and
    `predicted@<run>` and `correct@<run>` per run. Every run must cover the
    same labelled units, as all variants are evaluated on the same sites.
    """
    if not runs:
        raise ValueError("no runs")
    names = list(runs)
    base = runs[names[0]][["unit", "file", "stratum", "weight", "label_type", "label_case", "in_cstar"]].set_index("unit")
    for name in names:
        df = runs[name].set_index("unit")
        if set(df.index) != set(base.index):
            raise ValueError(f"run {name} covers other units than {names[0]}")
        base[f"predicted@{name}"] = df["predicted"]
        base[f"correct@{name}"] = df["correct"]
    return base.reset_index()
