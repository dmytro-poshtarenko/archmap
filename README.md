# archmap

`archmap` recovers the inter-service links of a multi-repository JS/TS system
and draws them as C4 diagrams in [LikeC4](https://likec4.dev). It combines
three sources of evidence, each of which can be switched off:
- analysis of the code by rules (ts-morph);
- the infrastructure descriptions: docker compose, Traefik, nginx,
  Kubernetes, Helm, Terraform;
- a large language model: Claude Opus 5.5 in the cloud, or Qwen3 30B locally
  in Ollama.

It is also the measuring instrument of the master's thesis «Формування
архітектури діючого мультирепозиторного програмного комплексу». It labels a
reference sample, evaluates every variant of the method on the same call
sites, runs the experiment on file length (hypothesis 3) and freezes the
method before the test split is opened. The target system is described by one
config file; Rocket.Chat is `configs/rocketchat.yaml`.

## Requirements

| What | Version | Needed for |
|---|---|---|
| Node.js | 24 | Everything |
| pnpm | 10 | Everything |
| git | — | Everything |
| Python with uv | 3.14, uv 0.12 | The statistical analysis (`analysis/`) |
| Ollama | 0.40, with `qwen3:30b-a3b-instruct-2507-q4_K_M` | The local model |
| `ANTHROPIC_API_KEY`, or Claude Code logged in to a subscription | — | The cloud model (`claude-opus-5-5`): `--model cloud` through the API, `--model cloud-cli` through Claude Code |
| Helm | — | Optional: rendering Helm charts (`brew install helm`) |
| codebase-memory-mcp | 0.7 or later | Optional: the baseline |

```bash
pnpm install
cd analysis && uv sync && cd ..
pnpm test
```

## Data workspace

Experiment data lives outside this repository: `../data` by default, or
`$ARCHMAP_DATA`, or `--data <dir>`. It holds:
- `repos/<id>@<sha>`: checkouts at the pinned commits;
- `db/<target>.sqlite`: the method's database;
- `labels/<target>/`: the reference labels;
- `out/<target>/`: runs, maps, evaluations, the hypothesis 3 kit;
- `reports/<target>/`: tables and figures.

The data is never published.

## The pipeline

Every step is a command that reads the previous step's result from the
database. `--config <file>` chooses the target; the default is Rocket.Chat.

```bash
pnpm archmap pin                 # resolve the branches to commits (configs/<target>.lock.json)
pnpm archmap fetch               # clone the repositories at the pinned commits
pnpm archmap inventory           # files, code units, parts of the system, licence zones, dev/test split
pnpm archmap extract             # call sites and route declarations by the rule packs (rules/*.yaml)
pnpm archmap extract-infra       # containers, environment, gateway rules
pnpm archmap llm-routes --model local     # task (a): declarations the rules do not cover
pnpm archmap classify            # predicted case 1–8 of every call site
pnpm archmap match               # one run per variant: --no-rules, --no-infra, --no-llm
pnpm archmap resolve --base full --mode select --model local   # tasks (b)/(c): the model resolves open sites
pnpm archmap build-map --run full.select.local                 # LikeC4 model, validated
pnpm archmap evaluate --run full.select.local --split dev      # recall, precision, θ against the labels
```

`pnpm archmap run-all [--model local|cloud|cloud-cli|replay-local|replay-cloud|replay-cloud-cli]` does
all of it in one command, for every run the hypotheses need. It then writes
the time and cost of each step to `out/<target>/run-all-<split>.json`.
- Answers of the model are cached by the prompt as sent, so a repeated run
  asks nothing.
- A replay model only reads recorded answers.

**Model cost.**
- `pnpm archmap llm-cost` estimates what the cloud model would cost.
- `pnpm archmap llm-stats` shows what the cache holds and how stable repeated
  answers are.
- Every command that calls the cloud model honours `--budget-usd` (default
  from the config: $60).

## Viewing the map

```bash
npx likec4 start ../data/out/rocketchat/full.select.local/likec4
pnpm archmap feature-view "Presence" --seeds ns:presence --depth 1 --direction in --kinds rpc
```

Agents get two MCP servers (`.mcp.json`):
- **`archmap mcp`**: `rebuild_map`, `list_unresolved`, `create_feature_view`;
- **`likec4 mcp`**: read-only access to the model.

## Reference labelling

```bash
pnpm archmap label candidates    # candidate lines by a text search independent of the method
pnpm archmap label sample        # stratified sample, seeded
pnpm archmap label serve         # the labelling interface on 127.0.0.1:4100
pnpm archmap label status
pnpm archmap label agreement --split dev
```

The protocol is `docs/labelling-guide.md` (in Ukrainian). The interface never
shows the method's answers. The test labels can be written at any time but
read as the reference only after the freeze.

## Experiments before the freeze

```bash
pnpm archmap exp h3-generate                 # 90 synthetic controllers of different length, checked by the route detector
pnpm archmap exp h3-run --model local        # and --model cloud
pnpm archmap exp probe --model local         # memorisation probe: routes named from the path alone
pnpm archmap exp baseline-cbm                # the baseline: codebase-memory-mcp on the same snapshot
cd analysis && uv run python -m archmap_analysis.report --target rocketchat --split dev \
  --runs no-llm full.select.local --h3 ../../data/out/rocketchat/h3/h3_results-local.csv
```

The analysis writes:
- CSV and Markdown tables, and SVG and PNG figures, to
  `reports/<target>/<split>/`;
- the decision of hypothesis 3 on splitting long files to
  `out/<target>/h3/decision.json`.

## Freeze and the test protocol

```bash
pnpm archmap freeze --tag freeze-1 --check   # what still stops the freeze
pnpm archmap freeze --tag freeze-1           # manifest, commit and annotated tag; prints the digest for the supervisor
```

**Conditions.** The freeze needs:
- a clean tree;
- a dev report;
- the chunking decision of hypothesis 3, reflected in the config.

**The manifest.** It records:
- the commit of the method;
- the hashes of config, rules and prompts;
- the models;
- the predicted shares of hypothesis 1, from the test labels' case counts.

**After the freeze.** The guards open the test split and the held-out
repository, and close again if anything but `freeze/` and `audit/` changes:

```bash
pnpm archmap fetch && pnpm archmap inventory        # now including the held-out repository
pnpm archmap label candidates && pnpm archmap label sample --heldout   # then label the held-out sample
pnpm archmap run-all --model cloud --split test     # the frozen variant on the test split
pnpm archmap run-all --model cloud --split heldout
```

Every evaluation is appended to `audit/evaluations.jsonl`.

## Licences

The tool is MIT-licensed.

**Rocket.Chat Enterprise code** (`ee/`, `apps/meteor/ee/`):
- it never enters this repository, its fixtures or published data;
- `pnpm licence-check` runs before every commit and fails on any fingerprint
  match;
- it is never sent to the cloud model: `llm.cloud.sendNonPublishable` is off,
  and only the local model reads it;
- the MCP server lists no address from it.

## Tests

```bash
pnpm test             # unit and integration tests, case fixtures, mini-complex
pnpm test:system      # invariants on the pinned Rocket.Chat snapshot (needs fetch, inventory, extract, extract-infra)
cd analysis && uv run pytest
```

Design notes for each milestone are in `docs/`.
