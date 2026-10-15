# Evaluation and statistical analysis (milestone M6)

## `archmap evaluate --run <id> --split dev`

This command compares one stored run with the reference labels of a split.

- **Splits and access.** The test and held-out splits open only after the
  freeze. The label guard (`openLabels`) refuses them earlier.
- **Audit log.** Every evaluation is appended to `audit/evaluations.jsonl`.

### Units

- **What a unit is.** A unit is a sampled candidate line with a label of
  origin `sample`.
- **Duplicate lines.** A line labelled `duplicate` stands for a call that is
  labelled on a line above. It is not a unit of its own.
- **Lines not labelled yet.** These are counted as pending.

### Alignment

A method site belongs to a unit when their lines overlap. The unit's lines are
the labelled line up to its `end_line`; the site's are `line` to `endLine`.

- When several sites overlap, the site that starts nearest the labelled line
  is taken.
- A site is counted at most once.
- Units that are call sites are aligned first. A neighbouring line that is not
  a site therefore cannot take their site.

### Formulas

The formulas follow section 5 of the thesis plan:

| Quantity | Definition |
|---|---|
| C* | Units the reference gives a target in the system (not `NONE`, not "not a site") |
| R (5.1) | correct / C* |
| R₁₋₇ | Recall over C* without the reference's case 8 |
| P (5.2) | correct / units the method linked |
| θ (5.3) | C*₈ / C* |

- **Precision.** A link the method gives on a line that the reference calls
  "no call site", or "NONE", counts against precision.
- **Correct.** The method's key equals the reference key, with route
  parameters compared by position (`canonicalTargetKey`). For a site that
  chooses among alternatives at run time, any alternative counts.
- **Weights.** Every unit is weighted by population ÷ sample of its stratum
  (the interaction type of the candidate search) within the split. The
  weighted values estimate the whole system, because the sample
  over-represents rare types (at least 30 units per type). Unweighted values
  are written too.
- **Breakdowns.** Recall is also reported per reference case and per type, and
  for links between parts: distinct (calling part, target part, kind) edges.

### Output

`data/out/<target>/<run>/eval/<split>/` holds:
- `site_results.csv`: one row per unit, the input of the analysis;
- `metrics.json`.

## Analysis (`analysis/`, Python 3.14 with uv)

```bash
cd analysis && uv sync && uv run pytest
uv run python -m archmap_analysis.report --target rocketchat --split dev --runs no-llm no-infra+no-llm
```

### Inputs and outputs

- **Runs.** Every run named in `--runs`, `--full`, `--without` and `--modes`
  is read and paired on the same units.
- **Output.** `data/reports/<target>/<split>/` gets:
  - `metrics` (CSV and Markdown);
  - `recall_by_case`;
  - `mcnemar` against the first run;
  - the figures `rates` and `recall_by_case` (SVG and PNG);
  - `summary.json` with the hypothesis checks whose runs were given.

### Intervals and tests

**Bootstrap over files.** Calls of one file are not independent: they share a
wrapper and a base address.
- Each of the 10,000 replicates draws as many files as the sample has, with
  replacement. The seed is the config's bootstrap seed, 11.
- Every run is evaluated on the same draws, so differences between runs are
  paired.
- Intervals are percentile intervals.

**Wilson intervals and McNemar's test** ignore that dependence. They are
reported for comparison, as the plan asks. McNemar is exact when fewer than
25 units disagree.

### Hypothesis checks

Each check ends confirmed, refuted or undetermined.

**Main hypothesis.**
- Confirmed when the lower 95 % bounds of R₁₋₇ and P are both ≥ 90 %.
- Refuted when an upper bound is below 90 %.

**Hypothesis 1.**
- **Measuring the drop.** Each component's drop in R₁₋₇ is divided by the
  share of its cases among cases 1–7: rules 1–3, infrastructure 4 and 7,
  language model 5 and 6. The share is measured on the same bootstrap draws,
  so the ratio reflects substitution between components, not the sampling
  noise of the share. `--shares` fixes the shares instead, e.g. the values
  sent before the test run.
- **Testing each component.**
  - One-sided bootstrap p-values test ratio ≥ 0.8 (confirmation) and
    ratio < 0.8 (refutation). They are Holm-adjusted over the three
    components.
  - A component whose share is below 5 % needs only a drop of at most 3
    percentage points.
  - Precision without a component may rise by at most 3 points, tested the
    same way.
- **Verdict.**
  - Confirmed when every component is confirmed.
  - Refuted when any component is refuted.

**Hypothesis 2.**
- Confirmed when the precision of select mode is at most 3 points below the
  method without the model (interval lower bound ≥ −3 points), and free mode
  is significantly less precise than select mode (upper bound < 0).
- Refuted when select mode loses more than 3 points, or when free mode is not
  significantly less precise and its lower bound is ≥ −3 points.

**Hypothesis 3** (`--h3 <csv>`, written by milestone M8).
- The input has one row per route of a synthetic variant, with columns
  `controller`, `variant`, `model`, `tokens`, `position` and `found`.
- The model is a logistic GEE, `found ~ log(tokens) × model + position`, with
  an exchangeable correlation within controllers.
- For each model, the slope of log(tokens) is tested one-sided for a fall.
- Verdict: confirmed when both models fall, partially confirmed when one
  does, refuted when none does.
- Spearman correlations are given only for description.

## Checks

| Check | Where | Result |
|---|---|---|
| Hand-computed toy set | `test/eval/evaluate.test.ts` and `analysis/tests/test_metrics.py` (same toy set) | Both give R = 0.4, R₁₋₇ = 0.5, P = 0.4, θ = 0.2 and the weighted values |
| Bootstrap stability | `test_bootstrap.py` | The same seed gives the same replicates. Another seed moves the interval by less than 2 points. With one unit per file, the interval comes within 1.5 points of Wilson's |
| Statistics against hand-worked values | — | Wilson 8/10, kappa 0.4, Holm, exact McNemar |
| Hypothesis decisions | — | Run on synthetic runs where the answer is known by construction |

The first dev report needs the reference labels of the dev split. It is
produced as soon as the pilot and the dev labelling exist.
