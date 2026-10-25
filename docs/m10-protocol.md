# Reproduction, freeze, held-out repository and baseline (milestone M10)

## `archmap run-all`

One command reproduces a measurement. The steps, in order:
1. extraction;
2. infrastructure;
3. the model's route extraction;
4. cases;
5. the four variants (`full`, `no-llm`, `no-infra`, `no-rules`);
6. the model's runs for the hypotheses:

   | Run | Base and mode | Hypothesis |
   |---|---|---|
   | `full.select.<model>` | `full`, select | 1 |
   | `no-infra.select.<model>` | `no-infra`, select | 1 |
   | `no-rules.free.<model>` | `no-rules`, free | 1 |
   | `full.select-all.<model>` | `full`, select on every site | 2 |
   | `full.free-all.<model>` | `full`, free on every site | 2 |

7. evaluation of every run on the split;
8. the Python analysis, once the split has labels.

**Records.**
- Time and cost of each step go to `out/<target>/run-all-<split>.json`.
- With `--model replay-local` or `replay-cloud`, nothing is asked: every
  answer must be in the cache. The test `test/experiments/runAll.test.ts` runs
  all fifteen steps on mini-complex this way, at $0.
- With `--sites sample` (the default), the model is asked only about the
  lines of the labelled sample, which is all the evaluation needs.
- With `--method-only`, only the method itself is resolved (the full variant,
  the model choosing among candidates on open sites), besides the variant
  without the model, which asks nothing. The held-out repository checks the
  frozen method, not the hypotheses, so it runs this way.

**Fewer cloud requests (decided on 2026-10-25).** Every request to the cloud
model counts against the subscription, so each is asked once:
- **Before the first cloud request, everything that shapes the prompts is
  final:** templates, rules and extraction (the system description lists the
  collections the code uses), candidates, fragments, chunking.
- **The cache serves every later run.** Changes to matching, normalisation
  or evaluation are recomputed from it without the model.
- **Hypothesis 3 for the cloud model runs a smaller kit:**
  `exp h3-run --model cloud-cli --levels 0,3,5 --no-position`.
  - It has 36 variants instead of 90: about 1k, 33k and 98k tokens, without
    the position series.
  - Each model's slope is fitted on its own variants. Position had no effect
    for qwen3.
- **The held-out repository runs `--method-only`.**

## Freeze

`archmap freeze --tag <tag>` refuses until all of these hold:
- the tool repository is clean;
- the method is not frozen yet;
- the dev report exists (`reports/<target>/dev/summary.json`);
- hypothesis 3 has decided file splitting (`out/<target>/h3/decision.json`,
  written by the analysis), and `llm.chunking` agrees with it;
- the tag is free.

**The manifest** (`freeze/manifest.json`) records:
- the commit of the method;
- the hashes of config, rules and prompts, and the extraction engine
  version;
- the models;
- the chunking decision;
- the version of the labelling guide;
- the hash of the dev report;
- the predicted shares of hypothesis 1.

**Predicted shares.** They are weighted by the sampling strata and computed
from the case counts of the test labels: the one read of the test labels
allowed before the freeze (`caseCounts`). It returns counts per stratum and
case, never a label.

**Commit and tag.** The manifest is committed on top of the method with an
annotated tag. The command prints the digest for the supervisor.

**The guards.** They then open the test split and the held-out repository,
and close again when anything but `freeze/` and `audit/` changes.

The protocol after the freeze was rehearsed on a made-up target
(`test/experiments/freeze.test.ts`):
1. Before the freeze, the test labels refuse to open as the reference and the
   inventory leaves the held-out repository out.
2. The freeze refuses until the dev report and the chunking decision exist,
   then writes the manifest, commits it and tags it.
3. The test labels open, and the inventory takes the held-out repository in.
4. A later change to the method closes the guard.

The held-out repository's candidates join the existing candidate population
without touching the main sample (`storeCandidates`), so the held-out sample
can be drawn after the freeze.

## Baseline: codebase-memory-mcp

`archmap exp baseline-cbm` runs codebase-memory-mcp as an MCP server over
stdio:
1. it indexes each code repository in `full` mode;
2. it runs its cross-repository matching;
3. it reads `HTTP_CALLS`, `CROSS_HTTP_CALLS`, `EMITS` and `LISTENS_ON`
   through `query_graph`.

On the pinned Rocket.Chat snapshot (version 0.10.0 reported by its server):
- **Size.** The index of `main` takes 10 s and has 297,052 nodes. It holds
  1,101 HTTP calls, 40 emitted channels and 64 listened channels.
- **Synthetic routes.** Its routes are made from the URL strings at call
  sites (`__route__ANY__/v1/...`), with no declaring file. So it names the
  path a call uses, never the part of the system that serves it.
- **One line per call.** It attributes each call to the enclosing function
  and gives one line for it: the five calls of `AccountProfileForm.tsx` all
  sit at line 478.
- **False positives.** It reads URL strings in calls that make no request,
  e.g. 22 deprecation notices `methodDeprecationLogger.method('2fa:enable',
  '8.0.0', '/v1/users.enableTotp')`.

**Placing the answers.** The adapter places each answer on the lines of its
file that quote its URL path or channel. There the labelled units meet it as
they meet the method's sites, and an answer on a line that is no call counts
against it. This gives 1,439 places, stored as run `cbm`.

**Evaluating it.**
- Strict: `archmap evaluate --run cbm`, by target key. The baseline can only
  score where a cross-repository match gave the part.
- Path only: `--compare path`, ignoring the part and router prefixes. This is
  the fair upper bound for it.

The method's runs can be evaluated with `--compare path` too, to compare like
with like.
