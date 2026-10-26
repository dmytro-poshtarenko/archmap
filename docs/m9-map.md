# The LikeC4 map, feature views and the MCP server (milestone M9)

## `archmap build-map [--run <id>]`

This writes `data/out/<target>/<run>/likec4/model.c4` and validates it with
LikeC4 1.59.4 (`LikeC4.fromWorkspace(...).getErrors()`, the same check as
`likec4 validate`). Feature views made earlier are kept next to it.

- **Default run.** Without `--run`, it draws the full method with the model's answers (`full.select.<model>`), or `full` when no model has run.
- **The `current` link.** A valid map becomes the one `data/out/<target>/current` points to. `archmap view`, `feature-view` and both MCP servers open that link.
- **Viewing.** `archmap view [--run <id>] [--port 5173]` starts the LikeC4 viewer on the map.

### Elements

- The parts of the config, as `client`, `service`, `gateway`, `bus`,
  `database`, `external` and `scheduler`.
- Inside a part, elements of kind `endpointGroup`:
  - HTTP routes grouped by their first word (`ep_rooms` for
    `/api/v1/rooms.*`);
  - `ddp_methods` and `ddp_streams`;
  - broker namespaces (`ns_presence` for `presence.*`).
- Collections inside the database (`mongo.users`), tagged `#shared` when two
  or more parts use them.
- `scheduler` for scheduled jobs.

### Relations

Relations are aggregated by (source part, target element, kind):

| Kind | Style |
|---|---|
| http | Solid blue |
| ddp | Solid indigo |
| rpc (broker actions) | Dashed green |
| event | Dotted amber |
| db | Solid grey |
| trigger | Dotted red |
| route (a gateway's rules) | Dashed teal |

- **Events** go from the publisher to the bus and from the bus to the
  subscriber.
- **Jobs** go from the scheduler to the part that runs them.
- **Routes** go from a gateway to each part its rules send requests to, e.g. `traefik → ddp-streamer-service` for `/websocket` and `/sockjs`. They come from the infrastructure step, not from call sites.
- **Descriptions.** A developer sees these when hovering:
  - **a part:** what it holds, which parts use it and which it uses, which events it publishes and receives;
  - **an element inside a part:** the routes, methods or names in use there;
  - **an arrow:** every route behind it, up to twelve, and what decided it.
- **Tags:**
  - `#rules`, `#infra` or `#llm` for what decided the link;
  - `#ambiguous` when the site keeps several possible targets, one relation
    to each;
  - `#viaGateway` when the request passes a gateway.
- **Metadata:** the cases, one call site, the number of sites and the run.
- **No code text** reaches the model. Titles name at most two routes, or
  names, and a count.

### Views

- `index`: the whole system, with a description that names the run and explains the arrows and tags.
- `of_<part>`: one view per part with elements inside it.
  - A part with more than 12 elements inside lays them out top to bottom, not in one row.
  - A database with more than 12 collections shows only the ones two or more parts share, because sharing is the interaction through a database. The view's description counts what it leaves out.

On Rocket.Chat this gives:
- `full` (rules and infrastructure): 181 elements, 244 relations, no diagnostics;
- the final map (`full.select.cloud`, the frozen method with the cloud model): 186 elements, 252 relations including the 2 gateway routes, no diagnostics.

## Feature views

`archmap feature-view <name> --seeds … [--depth 1–4] [--kinds …] [--direction in|out|both]`
writes `feature_<slug>.c4`.

**Seeds.** A seed can be:
- an element id (`rocketchat`, `mongo.users`);
- a route pattern (`/api/v1/rooms.*`), where `*` stands for any characters, `/` included;
- `ns:<broker service>`;
- `coll:<collection>`;
- a keyword, matched against titles and target keys.

**Search.** Breadth-first from the seeds along relations of the given kinds
and direction. A relation touches an element when it starts or ends at it, or
inside it.

- **View id.** The view id comes from the name in Latin letters: Cyrillic is transliterated (`Присутність` → `feature_prysutnist`), and a name with no letters gets a short hash.
- **Description.** The view's description records the seeds, depth, direction, kinds and run.

**Acceptance.** Four scenarios on Rocket.Chat were fixed before the run
(`docs/m9-acceptance.md`) and all four pass. mini-complex has three exact
scenarios in `test/map/map.test.ts`.

## MCP servers

`archmap mcp` serves three tools over stdio and logs to stderr:

| Tool | What it does |
|---|---|
| `rebuild_map({variant, llm: cache-only \| live, model})` | Classify, match, resolve the open sites in select mode, then build and validate the map. By default it uses recorded model answers only, with no new spending. |
| `list_unresolved({run, cases?, type?, component?, limit ≤ 200})` | Sites left unresolved or ambiguous, as metadata only: location, type, case, reason, alternatives. A file of a closed licence zone gives no address. |
| `create_feature_view({name, seeds, depth, kinds?, direction?, run?})` | Adds and validates a feature view. It returns the parts, the links between them with their routes, and the viewer address of the view. |

`.mcp.json` registers it next to LikeC4's own read-only server
(`likec4 mcp ../data/out/rocketchat/current`, built into the LikeC4 CLI).
`rebuild_map` uses the cloud model of the config by default, from recorded
answers only.

The test `test/map/map.test.ts` starts the server as a subprocess and calls
all three tools through the MCP client over stdio.
