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

## The same test with Sonnet 5.5

A second clean clone (`825d13b`) ran the same procedure with one change: `llm.cloud.model: claude-sonnet-5-5` in `configs/rocketchat.yaml`. The tests, the static steps, the map, the MCP servers and the system tests passed as above.

| | Opus 5.5 | Sonnet 5.5 |
|---|---|---|
| Task (a), 322 requests | 8 min 41 s, 777 declarations | 7 min 34 s, 773 declarations |
| Tasks (b) and (c), 32 requests | 1 min 36 s; 10 linked, 0 invented | 1 min 16 s; 10 linked, 0 invented |
| Tokens in / out | 1.69 M / 69 k | 1.72 M / 60 k |
| Repeated requests with the same answer | 26 of 27 | 25 of 27 |
| Links of the full method | 4,690 linked, 489 with no target, 71 unresolved | The same counts |
| Dev: R₁₋₇, P | 100 %, 100 % | 100 %, 100 % |

- **Links.**
  - The two models link 5,247 of 5,250 sites the same way.
  - The 3 sites that differ are the ones on which two Opus runs also differ, and none of them is in the sample.
  - On all 218 call sites of the test sample, both runs predict exactly what the official Opus run predicted. With Sonnet the method would have the same test results: R₁₋₇ 97.4 %, P 98.7 %.
- **Declarations.**
  - The DDP methods and subscriptions are the same 198.
  - Sonnet leaves out the `/api` router prefix in 175 of its 575 REST declarations; Opus never does. Without the prefix, 564 declarations are shared. The other 24 differ in how a prefix-mounted handler is written: `* /assets` against `GET /assets/:asset`, and different parameter names.
  - The missing prefix cost no links here, because the rules also find these REST routes. Where the model alone knows the routes, it could.

## Install and quick start (2026-10-26)

This run checks the setup commands the README's quick start uses. It takes the steps a new user takes, with the installed command, on a project outside the tool.

| Step | Result |
|---|---|
| `npm install -g <archive of the repository>` into a temporary prefix | Installed in 13 s; the `archmap` command works from any folder |
| The same from the git URL | Failed in npm 11.16. It ran the install scripts of the git dependency (esbuild, fsevents, archmap's own) in folders relative to the current one, which do not exist. The README gives the archive URL instead |
| `archmap init --yes` in a copy of mini-complex | The parts of the hand-written config: web (client); api and worker (services); traefik (gateway); redis (bus, as BullMQ keeps jobs in it). Also its compose file and `generic@1` |
| `archmap doctor` | Every check passed |
| `archmap map` | Inventory to map in 2 s: 8 elements, 11 relations, no diagnostics, as with the hand-written config. The data went to `.archmap/`, which has its own `.gitignore` |
| `archmap view` | The viewer answered |
| `archmap setup claude`, with a temporary `HOME` | Both servers registered; `claude mcp list` reported both as connected |
| `archmap init` on the Rocket.Chat snapshot | The parts of the hand-written config (see below) |

**`init` on Rocket.Chat.** On the checkouts of the measurements, `init` found:
- the Meteor server, by its Dockerfile, and its browser code `apps/meteor/client`;
- the six microservices under their docker-compose names, by the packages named like them;
- the desktop client, an Electron app at the root of a workspace, and the livechat client;
- traefik, nats and mongo, by their images;
- the rule packs `generic@1`, `meteor@1` and `rocketchat@1`.

It also took `uikit-playground`, a playground app. The held-out mobile repository was not in the folder.

**The map from the detected config.** Without the model, it linked 4,523 call sites, against 4,602 with the hand-written config, and drew 197 elements and 290 relations against 195 and 293.

**Without `rocketchat@1`.** The detected config found 80 call sites and linked none. Rocket.Chat's calls go through its own SDK, as the held-out mobile client showed.

**Defects found and fixed.**
- **A config read as a number or a boolean** (found while writing the tests). A YAML id like `2024` or `true` would not have loaded; the config now quotes such ids.
- **An override compose file** (a build with no context) was read as a build of the repository's root.
- **A test compose file and an image named after a vendor** (`kong/httpbin`) were taken as parts.
- **A workspace root that is an app** was left out.
- **Install from git**, with two causes:
  - A `prepare` build needed devDependencies, which npm does not install for a global git install. Fixed: the command runs the sources through tsx, so no build is needed.
  - npm 11 runs the install scripts of a git dependency in the wrong folders. Worked around: the README installs from the archive URL.

