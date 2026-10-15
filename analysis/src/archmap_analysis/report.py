"""
Tables and figures for the report from evaluated runs:

    uv run python -m archmap_analysis.report --target rocketchat --split dev --runs no-llm no-infra+no-llm

Writes `data/reports/<target>/<split>/`: metrics with bootstrap and Wilson
intervals, recall per case, McNemar against the first run, the hypothesis
checks whose runs are given, and the figures as SVG and PNG.
"""

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from .bootstrap import DEFAULT_REPLICATES, cluster_bootstrap, interval  # noqa: E402
from .data import load_runs, paired  # noqa: E402
from .h3 import decision as h3_decision  # noqa: E402
from .h3 import gee_length, spearman_by_model  # noqa: E402
from .hypotheses import hypothesis1, hypothesis2, main_hypothesis  # noqa: E402
from .metrics import predicted_shares, rates, recall_by_case  # noqa: E402
from .stats import mcnemar, wilson  # noqa: E402


def markdown(df: pd.DataFrame) -> str:
    """A pipe table; numbers as they are formatted in the frame."""
    head = "| " + " | ".join(str(c) for c in df.columns) + " |"
    rule = "|" + "|".join("---" for _ in df.columns) + "|"
    rows = ["| " + " | ".join("" if pd.isna(v) else str(v) for v in r) + " |" for r in df.itertuples(index=False)]
    return "\n".join([head, rule, *rows]) + "\n"


def pct(x: float | None) -> str:
    return "–" if x is None or (isinstance(x, float) and np.isnan(x)) else f"{100 * x:.1f}"


def ci(pair: tuple[float, float]) -> str:
    return f"[{pct(pair[0])}; {pct(pair[1])}]"


def write_table(df: pd.DataFrame, out: Path, name: str) -> None:
    df.to_csv(out / f"{name}.csv", index=False)
    (out / f"{name}.md").write_text(markdown(df))


def save_figure(fig, out: Path, name: str) -> None:
    fig.tight_layout()
    fig.savefig(out / f"{name}.svg")
    fig.savefig(out / f"{name}.png", dpi=200)
    plt.close(fig)


def metrics_table(runs: dict[str, pd.DataFrame], boot) -> pd.DataFrame:
    rows = []
    for name, df in runs.items():
        w = rates(df, weighted=True)
        u = rates(df, weighted=False)
        rows.append(
            {
                "run": name,
                "units": len(df),
                "C*": int(u.cstar),
                "case 8": int(u.cstar8),
                "linked": int(u.predicted),
                "R1-7 %": pct(w.recall17),
                "R1-7 95% CI (files)": ci(interval(boot.recall17(name))),
                "P %": pct(w.precision),
                "P 95% CI (files)": ci(interval(boot.precision(name))),
                "R %": pct(w.recall),
                "θ %": pct(w.theta),
                "R1-7 unweighted, Wilson": f"{pct(u.recall17)} {ci(wilson(int(u.correct17), int(u.cstar17)))}",
                "P unweighted, Wilson": f"{pct(u.precision)} {ci(wilson(int(u.correct), int(u.predicted)))}",
            }
        )
    return pd.DataFrame(rows)


def by_case_table(runs: dict[str, pd.DataFrame]) -> pd.DataFrame:
    frames = []
    for name, df in runs.items():
        t = recall_by_case(df)
        t.insert(0, "run", name)
        t["recall %"] = t["recall"].map(pct)
        frames.append(t.drop(columns=["recall"]))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def mcnemar_table(wide: pd.DataFrame, names: list[str]) -> pd.DataFrame:
    c = wide[wide["in_cstar"] == 1]
    rows = []
    for other in names[1:]:
        t = mcnemar(c[f"correct@{names[0]}"].to_numpy(), c[f"correct@{other}"].to_numpy())
        rows.append({"first": names[0], "second": other, **t})
    return pd.DataFrame(rows)


def figure_by_case(table: pd.DataFrame, out: Path) -> None:
    if table.empty:
        return
    pivot = table.pivot_table(index="label_case", columns="run", values="correct", aggfunc="sum") / table.pivot_table(
        index="label_case", columns="run", values="n", aggfunc="sum"
    )
    fig, ax = plt.subplots(figsize=(7, 3.5))
    (pivot * 100).plot.bar(ax=ax, rot=0)
    ax.set_xlabel("Випадок")
    ax.set_ylabel("Повнота, %")
    ax.set_ylim(0, 105)
    ax.legend(title="Варіант", fontsize=8)
    save_figure(fig, out, "recall_by_case")


def figure_rates(runs: dict[str, pd.DataFrame], boot, out: Path) -> None:
    names = list(runs)
    fig, ax = plt.subplots(figsize=(7, 0.6 * len(names) + 1.5))
    for i, name in enumerate(names):
        w = rates(runs[name])
        for value, (lo, hi), color, offset in (
            (w.recall17, interval(boot.recall17(name)), "tab:blue", -0.12),
            (w.precision, interval(boot.precision(name)), "tab:orange", 0.12),
        ):
            if value is None:
                continue
            ax.errorbar(100 * value, i + offset, xerr=[[100 * (value - lo)], [100 * (hi - value)]], fmt="o", color=color, capsize=3)
    ax.set_yticks(range(len(names)), names)
    ax.set_xlabel("%, 95 % інтервал (бутстреп за файлами)")
    ax.axvline(90, color="grey", linestyle=":", linewidth=1)
    ax.plot([], [], "o", color="tab:blue", label="R₁₋₇")
    ax.plot([], [], "o", color="tab:orange", label="P")
    ax.legend(loc="lower left", fontsize=8)
    save_figure(fig, out, "rates")


def h3_report(paths: list[Path], out: Path) -> dict:
    """
    Hypothesis 3 from the per-model result files: the GEE and Spearman on the
    length series, recall by place of the routes for the position series
    (the two series are analysed separately), and the chunking decision.
    """
    all_rows = pd.concat([pd.read_csv(p) for p in paths], ignore_index=True)
    df = all_rows[all_rows["series"] == "length"] if "series" in all_rows.columns else all_rows
    slopes = gee_length(df)
    rho = spearman_by_model(df)
    if "series" in all_rows.columns:
        pos = all_rows[all_rows["series"] == "position"]
        if not pos.empty:
            table = pos.groupby(["model", "level"]).agg(n=("found", "count"), found=("found", "sum")).reset_index()
            table["recall %"] = (100 * table["found"] / table["n"]).round(1)
            table["Wilson 95%"] = [ci(wilson(int(k), int(n))) for k, n in zip(table["found"], table["n"], strict=True)]
            write_table(table, out, "h3_position")
    write_table(slopes.round(4), out, "h3_gee")
    write_table(rho.round(4), out, "h3_spearman")
    fig, ax = plt.subplots(figsize=(6, 3.5))
    for m, g in df.groupby("model"):
        per = g.groupby("variant").agg(tokens=("tokens", "first"), recall=("found", "mean")).sort_values("tokens")
        ax.plot(per["tokens"], 100 * per["recall"], "o", label=m, alpha=0.7)
    ax.set_xscale("log")
    ax.set_xlabel("Довжина файлу, токенів")
    ax.set_ylabel("Частка вилучених маршрутів, %")
    ax.legend(fontsize=8)
    save_figure(fig, out, "h3_length")
    chunking = {str(r["model"]): bool(r["falls"]) for r in slopes.to_dict(orient="records")}
    return {"verdict": h3_decision(slopes), "slopes": slopes.to_dict(orient="records"), "split_files_for": chunking}


def parse_pairs(items: list[str] | None) -> dict[str, str]:
    out = {}
    for item in items or []:
        key, _, value = item.partition("=")
        if not value:
            raise SystemExit(f"expected key=value, got {item}")
        out[key] = value
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="archmap_analysis.report", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(Path(__file__).resolve().parents[4] / "data"), help="data workspace (default: magister-diplom/data)")
    ap.add_argument("--target", required=True)
    ap.add_argument("--split", default="dev")
    ap.add_argument("--runs", nargs="*", default=[], help="evaluated runs; the first is the reference for McNemar")
    ap.add_argument("--full", help="hypotheses: the full method's run")
    ap.add_argument("--without", nargs="*", help="hypothesis 1: rules=<run> infra=<run> llm=<run>")
    ap.add_argument("--shares", help="hypothesis 1: JSON file with the predicted shares (default: from these labels)")
    ap.add_argument("--modes", nargs="*", help="hypothesis 2: no-llm=<run> select=<run> free=<run>")
    ap.add_argument("--h3", nargs="+", help="hypothesis 3: result CSVs of the synthetic-file experiment, one per model")
    ap.add_argument("--replicates", type=int, default=DEFAULT_REPLICATES)
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--out", help="output directory (default: <data>/reports/<target>/<split>)")
    args = ap.parse_args(argv)

    out = Path(args.out) if args.out else Path(args.data) / "reports" / args.target / args.split
    out.mkdir(parents=True, exist_ok=True)
    summary: dict = {"target": args.target, "split": args.split, "replicates": args.replicates, "seed": args.seed}
    names = list(dict.fromkeys(args.runs + [v for v in [args.full] if v] + list(parse_pairs(args.without).values()) + list(parse_pairs(args.modes).values())))
    if names:
        runs = load_runs(args.data, args.target, args.split, names)
        wide = paired(runs)
        boot = cluster_bootstrap(wide, names, replicates=args.replicates, seed=args.seed)
        summary.update({"runs": names, "units": len(wide), "files": int(wide["file"].nunique())})
        write_table(metrics_table(runs, boot), out, "metrics")
        cases = by_case_table(runs)
        write_table(cases, out, "recall_by_case")
        if len(names) > 1:
            write_table(mcnemar_table(wide, names), out, "mcnemar")
        figure_by_case(cases, out)
        figure_rates(runs, boot, out)
        if args.full:
            summary["main"] = main_hypothesis(boot, args.full).__dict__
            without = parse_pairs(args.without)
            if without:
                shares = json.loads(Path(args.shares).read_text()) if args.shares else None
                summary["h1"] = hypothesis1(boot, args.full, without, shares).__dict__
                summary["h1"]["point_shares"] = predicted_shares(runs[args.full])
        modes = parse_pairs(args.modes)
        if {"no-llm", "select", "free"} <= set(modes):
            summary["h2"] = hypothesis2(boot, modes["no-llm"], modes["select"], modes["free"]).__dict__
    if args.h3:
        summary["h3"] = h3_report([Path(p) for p in args.h3], out)
        # the decision the freeze checks the config against
        decision = Path(args.data) / "out" / args.target / "h3" / "decision.json"
        decision.parent.mkdir(parents=True, exist_ok=True)
        decision.write_text(json.dumps({"verdict": summary["h3"]["verdict"], "splitFilesFor": summary["h3"]["split_files_for"], "files": args.h3}, indent=2, default=float) + "\n")
    if not names and not args.h3:
        raise SystemExit("nothing to report: give --runs and/or --h3")

    (out / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False, default=float) + "\n")
    if names:
        print(f"{summary['units']} units in {summary['files']} files, {len(names)} runs")
    print(f"written to {out}")
    for key in ("main", "h1", "h2", "h3"):
        if key in summary:
            print(f"{key}: {summary[key]['verdict']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
