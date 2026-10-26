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

## Results on Rocket.Chat

**Snapshot.** Pinned on 2026-10-15 (`configs/rocketchat.lock.json`):

| Repository | Commit |
|---|---|
| Rocket.Chat | `16badb07aedc365a489b9f4ac5b6d8e64ad65373` |
| Rocket.Chat.Electron | `158b7c6cbbab88f2c39ab23f98ed65647c050133` |
| Rocket.Chat.ReactNative (held out) | `19a8c31ae31df949a1a1ec5c80d1e1ce502858c0` |
| helm-charts | `eea375d7a9b74b98066d8681f6ba9715ec6340ef` |

**Reference.**
- One annotator labelled the call sites blind, by `docs/labelling-guide.md`: 135 on the dev split, 265 on the test split and 76 in the held-out mobile client.
- There was no second annotator, so agreement between annotators was not measured.
- **Freeze.** The method was tuned on dev only and frozen with the tag `freeze-1` (method commit `f1b88f2`) before the test split was opened.
- **Audit.** Every evaluation is in `audit/evaluations.jsonl`, with its run, split, comparison mode, metrics, tool commit and config hash.

**Test split, frozen method.** R₁₋₇ is recall among the links static sources can recover; P is precision. Both are weighted by interaction type, with 95 % bootstrap intervals over files.

| Variant | Opus 5.5: R₁₋₇ | Opus 5.5: P | Qwen3 30B: R₁₋₇ | Qwen3 30B: P |
|---|---|---|---|---|
| Full method (the model chooses among the rules' candidates for open sites) | 97.4 % [94.3; 99.7] | 98.7 % [96.8; 100] | 96.0 % [92.8; 98.4] | 98.7 % [96.7; 100] |
| Without the model | 95.8 % | 98.8 % | 95.8 % | 98.8 % |
| Without the infrastructure descriptions | 97.4 % | 98.7 % | 95.3 % | 97.1 % |
| Without the rules | 9.6 % | 98.7 % | 0.5 % | 5.3 % |
| The model on every site, choosing among candidates | 97.4 % | 96.1 % | 91.1 % | 87.8 % |
| The model on every site, free search | 97.4 % | 96.4 % | 42.8 % | 72.9 % |

**Hypotheses:**
- **Main hypothesis:** confirmed with both models.
- **H1** (each component's share is predicted by the cases): confirmed with both models.
- **H2:** refuted with both models, for different reasons. Opus barely invents targets, so free search is as good as choosing. Qwen, asked about every site, spoils links the rules had found.
- **H3:** partly confirmed. Qwen's recall falls with file length (GEE slope −0.65, p = 0.004); Opus found 59 of 59 routes at every length. Long files are split for Qwen only.

**The two models differ only on DDP streams.** Opus links 13 of 15, Qwen 1 of 15 (exact McNemar p = 0.0018), because Qwen does not recognise `createStream(…)` declarations.

**Held-out mobile client.** The frozen method linked none of its 45 sites with a target, and none of 33 without the E2E scripts. The 95 % upper bounds are 7.9 % and 10.4 %. The client calls the server through its own SDK, which the rule packs do not recognise, and the model does not look for call sites.

**Baseline: codebase-memory-mcp 0.10.0.**
- By full target key: 0 % recall, because it never names the part that serves a call.
- By path only: R₁₋₇ 12.5 % [8.1; 17.5], P 75.8 %, all on HTTP. The method scored the same way gets 97.6 % and 98.8 %.

**Gap check** (`pnpm archmap label gap-report`). In 20 files read in full:
- the text search for candidates found 48 of 49 call sites, the method's extraction 46;
- both found all 42 sites with a target in the system, so the miss rate is at most 8.4 % at 95 %.

**Stability of the cloud model** (`pnpm archmap llm-stats`). Repeated requests gave the same decision:
- route extraction: 27 of 27;
- choosing among candidates: 21 of 21;
- free search: 36 of 44.

**Memorisation.** From a file path alone, Opus named 50 of 59 routes and Qwen 2 of 59; with the paths renamed, both named none. Opus knows Rocket.Chat from training, which is a threat to validity for its route extraction.

**The map.** Built from the full method with Opus: 194 elements and 268 relations.
- C1: Rocket.Chat and the 7 external systems its code calls.
- C2: its 15 containers.
- C3: one view of each container.

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

## Using the map

### The whole system

```bash
pnpm archmap build-map   # the full method with the model's answers; LikeC4 validates it
pnpm archmap view        # the LikeC4 viewer on http://localhost:5173
```

`build-map` also points `data/out/<target>/current` at the map it built, so
`view` and the MCP servers always open the latest one. The viewer's title is
`<product>: C4 Diagrams`, where the product is named after the main
repository (`Rocket.Chat`). Every view's title starts with its level of the
C4 model:

| Level | View | What it shows |
|---|---|---|
| C1 | `context` | The system as one box and the external systems its code calls, one per domain, with the endpoints reached. |
| C2 | `index` | The containers that run code or hold data. Clients sit on top and databases at the bottom. One arrow per direction says what flows and by which protocol, e.g. `REST: livechat, users, rooms +70 groups (474 routes)` [HTTP via traefik]. Events go straight from publisher to subscriber, and DDP goes to the container that terminates the gateway's WebSocket. |
| C2 | `external_systems` | The containers that call systems outside the product, and those systems. |
| C2 | `gateway_<name>` | Who sends requests through a gateway, and where its rules send them by path. |
| C2 | `bus_<name>` | Which containers publish events to a message bus and which receive them. |
| C3 | `of_<container>` | One container from inside: REST groups, DDP methods and subscriptions, broker namespaces, scheduled jobs, and who calls them. The database view keeps the collections two or more containers share. |
| C2 or C3 | `feature_<name>` | The containers and components one feature uses (below). |

**Reading the views.** Every view's description has the key, and the viewer's legend lists the element types.

| What you see | What it means |
|---|---|
| Box colour and shape | The element's type: client application, server-side container, database, message bus, gateway, external system, API group, collection, scheduled jobs. |
| Text in a box | The technology, from the container image or the package.json (`Node.js, Moleculer`, `MongoDB 8.0`), then a one-line summary. |
| Solid blue arrow | Request and response: REST, a DDP method, a broker action. |
| Dashed amber arrow | Asynchronous: a broker event, a DDP subscription. |
| Grey arrow | Database access. |
| Dotted grey arrow | Only shared code links the two. The call sits in a package several containers bundle, so which of them makes it is not known. |
| Text in brackets under a label | The protocol, and the gateway or the container the traffic passes: `HTTP via traefik`, `WebSocket (DDP) through ddp-streamer-service`, `NATS (RPC, events)`, `MongoDB`. |
| Light grey box | The method found no links for that container. Its summary counts the call sites it has, or says that none of its code was in the workspace. |

Bus and database protocols come from the URLs in the deployment descriptions (`TRANSPORTER=nats://…`), else from the container images.

**Which containers run a call.** A call site belongs to the containers that run it under the deployment, as the method narrows them. A broker service registered only in some containers runs only there. Code loaded only under conditions the profile makes false does not run.

### One feature

```bash
pnpm archmap feature-view "User presence (presence service actions, their callers, sessions collection)" --seeds ns:presence,coll:usersSessions
pnpm archmap remove-view feature_user_presence
```

**The name.** Write it in English: what the feature is, then in parentheses what the view holds. The map adds the C4 level: C3 when the view shows components inside a container, C2 when it shows containers only. The view id comes from the words before the parenthesis (`feature_user_presence`).

**Seeds.** A seed is one of:
- an element id (`rocketchat`);
- a route pattern (`/api/v1/livechat*`, where `*` stands for any characters, `/` included);
- a broker service (`ns:presence`);
- a collection (`coll:users`);
- a keyword.

**Following the links.** The view follows links from the seeds:
- `--depth`: hops, 1 to 4;
- `--direction`: `in`, `out` or `both`;
- `--kinds`: only these kinds of links.

### From Claude Code

Claude Code started in this directory picks up `.mcp.json`, which registers
two servers. To use them from any project:

```bash
claude mcp add archmap -- pnpm -C /path/to/tool -s archmap mcp
claude mcp add likec4 -- pnpm -C /path/to/tool -s archmap likec4-mcp
```

For another codebase, pass its config to both, e.g. `archmap --config /path/to/target.yaml mcp`.
`likec4-mcp` serves the map built last for that config, with the LikeC4 version the tool pins.

| Server | Tools |
|---|---|
| `archmap` | `create_feature_view` builds a feature view and returns its parts, the links between them with their routes, and the viewer address. `delete_feature_view` removes one. `list_unresolved` lists what the method left open, as metadata only. `rebuild_map` reruns classification, matching and the model's answers (recorded ones unless `llm: live`) and rebuilds the map. |
| `likec4` | Read-only: elements, relationships, paths between parts, views. |

Questions to try:
- «Which parts of Rocket.Chat take part in user presence? Make a feature view.»
- «Which external systems does Rocket.Chat call, and from which containers?»
- «What did the method leave unresolved in the desktop client, and why?»

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

Every evaluation is appended to `audit/evaluations.jsonl`. Entries since 2026-10-26 say how predictions met the labels (`compare`: `key` or `path`). Earlier entries scored by path only have a run id ending in `@path`.

## Reproducing the measurements

The labels are published without code: repository, commit, path, line, type, target and case (`pnpm archmap label export`). With them:

```bash
git checkout freeze-1                       # the frozen method
pnpm install && (cd analysis && uv sync)
pnpm archmap fetch && pnpm archmap inventory          # the pinned commits
pnpm archmap extract && pnpm archmap extract-infra
pnpm archmap label candidates && pnpm archmap label sample   # the same frame and sample: fixed seeds
pnpm archmap label import --split test --file test-labels.jsonl
pnpm archmap run-all --model cloud-cli --split test   # or --model cloud with an API key, or --model local
```

**The model's answers.**
- Asked again, Opus 5.5 may answer a few requests differently: it takes no temperature, and free search was the least stable task (above).
- With the recorded answers, `--model replay-cloud-cli` reproduces every number of the table. Replays of both models gave metrics identical to the first evaluation, to the last digit.

**The baseline:**

```bash
pnpm archmap exp baseline-cbm
pnpm archmap evaluate --run cbm --split test --compare path
```

**The gap check** came after the freeze. Run it on a later commit: `pnpm archmap label gap-report`. It reads the test labels only while the extraction is still the frozen one.

## Licences

The tool is MIT-licensed.

**Rocket.Chat Enterprise code** (`ee/`, `apps/meteor/ee/`):
- it never enters this repository, its fixtures or published data;
- `pnpm licence-check` runs before every commit and fails on any fingerprint
  match;
- it is never sent to the cloud model: `llm.cloud.sendNonPublishable` is off,
  and only the local model reads it;
- the MCP server lists no address from it.

## LikeC4

The map is LikeC4 source text that archmap writes; nothing in LikeC4 is patched.

**What the tool uses.** archmap uses LikeC4 in three ways:
- **the language:** `src/map/dsl.ts` and `src/map/feature.ts` write it;
- **the API:** `LikeC4.fromWorkspace` validates a map and computes its views;
- **the command-line tool:** `likec4 start` behind `archmap view`, and `likec4 mcp` behind `archmap likec4-mcp`.

The API and the command-line tool are used only in `src/map/likec4.ts`.

**The version** is pinned exactly in `package.json` (`likec4` 1.59.4) and in `pnpm-lock.yaml`. Nothing changes until someone changes it.

**What the tests hold.** The map tests run LikeC4 itself on mini-complex. They check:
- the model has no diagnostics;
- every view title starts with its C4 level;
- no arrow is labelled `[...]`;
- the C2 view draws only the summary arrows;
- a feature view draws the arrows the generator expects;
- `likec4-mcp` starts LikeC4's MCP server of the pinned version.

**To upgrade LikeC4:**

```bash
pnpm add likec4@<version> --save-exact
pnpm test
pnpm archmap build-map
pnpm archmap view
```

1. Install the new version with `--save-exact`.
2. Run `pnpm test`. A failure names what the new version draws differently.
3. Rebuild the map and look at the C1, C2 and a feature view in the viewer.
4. Retake screenshots if the look has changed.

## Tests

```bash
pnpm test             # unit and integration tests, case fixtures, mini-complex
pnpm test:system      # invariants on the pinned Rocket.Chat snapshot (needs fetch, inventory, extract, extract-infra)
cd analysis && uv run pytest
```

Design notes for each milestone are in `docs/`.
