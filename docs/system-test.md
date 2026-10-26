# System test: a full run from a clean clone

The system test runs the tool on Rocket.Chat exactly as the README describes. It starts from a fresh copy of this repository and an empty data workspace, with no file prepared by hand, and checks the tool as a whole against its requirements.

**Run on 2026-10-26.**
- **Tool:** a fresh `git clone` of this repository at `a56bdcb`. The fixes below were made during the test; the final run is at `708c3cf`.
- **Data:** an empty data workspace, set with `ARCHMAP_DATA`.
- **Model:** the cloud model through Claude Code (`--model cloud-cli`, `claude-opus-5-5`).
- **Environment:**
  - macOS 27.0.1 on Apple M3 Max, 48 GB;
  - Node.js 24.18.0, pnpm 10.19.0, uv 0.12.0;
  - Claude Code 2.1.303, LikeC4 1.59.4.

  Helm was not installed; the README marks it optional.

## Procedure and results

| Step | Command | Result | Time |
|---|---|---|---|
| Install | `pnpm install`, `uv sync` | Done | 2 s |
| Tests | `pnpm test`, `uv run pytest` | First run: 3 tests failed, and the system test file failed to load (defects 1 and 2). After the fixes: 203 passed, 4 skipped (the system suite, as designed); Python 18 passed | 6 s, 25 s |
| Pin | `archmap pin` | Kept the committed pins | 2 s |
| Fetch | `archmap fetch` | main, desktop and helm at the pinned commits. mobile is held out until the freeze | 13 s |
| Inventory | `archmap inventory` | 10,040 files: main 9,260, desktop 673, helm 107 | 2 s |
| Rules | `archmap extract` | 5,250 call sites, 1,017 routes | 9 s |
| Infrastructure | `archmap extract-infra` | 13 containers, 4 gateway rules | 1 s |
| Model, task (a) | `archmap llm-routes --model cloud-cli` | 268 files, 322 requests, all answered; 777 declarations | 8 min 41 s |
| Cases | `archmap classify` | A case for each of the 5,250 sites | 2 s |
| Matching | `archmap match`, with `--no-llm`, `--no-infra`, `--no-rules` | `full`: 4,680 linked, 469 with no target, 101 unresolved | 6 s |
| Model, tasks (b) and (c) | `archmap resolve --base full --mode select --model cloud-cli` | 30 sites, 32 requests: 10 linked, 20 with no target, 0 invented | 1 min 36 s |
| Map | `archmap build-map --run full.select.cloud` | 195 elements, 293 relations, no diagnostics | 2 s |
| Reference | `label candidates`, `label sample`, `label import --split dev` | The same 400-line sample as the measurements; 157 dev labels imported | 6 s |
| Evaluation | `archmap evaluate --run full.select.cloud --split dev` | R₁₋₇ 100 %, P 100 % (107 of 107). The `no-llm` run: R₁₋₇ 98.5 %, P 100 % | 2 s |
| System tests | `pnpm test:system` | 4 passed | 39 s |

From an empty workspace to a validated map took 12 minutes, 10 of them waiting for the cloud model. The model was asked 354 times, about 1.7 million tokens in and 69,000 out.

## Requirements

| Requirement | Evidence | Result |
|---|---|---|
| Build the map of the system from the code of several repositories and the infrastructure descriptions | `build-map`: 195 elements and 293 relations, from three repositories and docker-compose | Met |
| Build the map of one feature on request | `feature-view` in the CLI and `create_feature_view` over MCP gave the same parts as on the measurement workspace | Met |
| Show each link's interaction type, source and case | Relation kinds, the tags `#rules`, `#infra` and `#llm`, the case in each relation's metadata | Met |
| List the unresolved call sites with their cases | `list_unresolved`: 71 sites with case, reason and alternatives | Met |
| Switch the components and the model's mode by parameters | `match --no-llm`, `--no-infra`, `--no-rules`; `resolve --mode select` or `free` | Met |
| Compute recall and precision against the reference | `evaluate`: R₁₋₇, P and θ, per case and type | Met |
| Give an agent access to the map through MCP | `archmap mcp`: four tools, all called. `archmap likec4-mcp`: LikeC4 1.59.4, the project listed and summarised | Met |
| Code that may not be published never reaches the cloud model | 0 of 354 cloud requests concerned any of the 708 such files: 601 under the Enterprise licence, 107 with no licence | Met |
| In local mode, no code leaves the computer | Not exercised: this run used the cloud model | Not tested here |
| The same input with the recorded answers gives the same result | A repeated run asked nothing (354 answers from the cache) and wrote a byte-identical model | Met |
| Runs on the developer's computer with Node.js, with no server but the model | As above | Met |

## Defects found and fixed

| # | Defect | Fix |
|---|---|---|
| 1 | `.gitignore` dropped `fixtures/infra/compose/.env`, so three infrastructure tests failed on any fresh clone | Fixtures are exempt from the rule (`df72dee`) |
| 2 | The Rocket.Chat system suite opened its database while being collected, so `pnpm test` failed on a workspace with no data instead of skipping it | The database opens only when the suite runs (`df72dee`) |
| 3 | The analysis report ignored `ARCHMAP_DATA`, and its hypothesis 3 test wrote `out/toy/h3/decision.json` into the real data workspace | The report honours `ARCHMAP_DATA`; the test writes to a temporary workspace (`3f2ec45`) |
| 4 | The map said that a part with no code in the workspace had no call sites in its code. Here that was the held-out mobile repository | Such a part reads `Not analysed: none of its code is in the workspace` (`708c3cf`) |

None of them touched the method: extraction, matching, rules, prompts and configuration are unchanged.

## Comparison with the measurement workspace

- **Static steps.** Outside the held-out repository, the results match:
  - 5,250 call sites and 1,017 routes;
  - 13 containers and 4 gateway rules;
  - the same 400-line sample.
- **Matching.**
  - `full` and `no-llm` gave the same counts.
  - `no-infra` differed: 168 ambiguous sites against 107. The measurement workspace's `no-infra` run is older and used another set of model declarations, as its recorded input hash shows.
- **The cloud model, asked again from scratch.**
  - 3 of 5,250 links differ: two DDP method declarations and one REST route were found in one run and not the other.
  - None of the 3 is in the labelled sample.
  - Opus 5.5 takes no temperature, and 26 of 27 repeated extraction requests gave the same answer.
- **The map.** The element and relation counts are the same. It differs only by those 3 links and by the box of the held-out mobile repository.

## Deviations from the README

- **`archmap pin`** kept the committed pins. It re-resolves them only with `--refresh`.
- **The mobile repository** is held out until the method is frozen. At this commit the method is not the frozen one, so `fetch` skipped it, as designed.
- **The Helm chart** was skipped, because Helm was not installed.
- **The dev labels** came from `archmap label export` of the measurement workspace. They are the published reference, not a file made for the test.
