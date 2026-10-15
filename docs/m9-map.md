# The LikeC4 map, feature views and the MCP server (milestone M9)

## `archmap build-map --run <id>`

This writes `data/out/<target>/<run>/likec4/model.c4` and validates it with
LikeC4 1.59.4 (`LikeC4.fromWorkspace(...).getErrors()`, the same check as
`likec4 validate`). Feature views made earlier are kept next to it.

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

- **Events** go from the publisher to the bus and from the bus to the
  subscriber.
- **Jobs** go from the scheduler to the part that runs them.
- **Tags:**
  - `#rules`, `#infra` or `#llm` for what decided the link;
  - `#ambiguous` when the site keeps several possible targets, one relation
    to each;
  - `#viaGateway` when the request passes a gateway.
- **Metadata:** the cases, one call site, the number of sites and the run.
- **No code text** reaches the model. Titles name at most two routes, or
  names, and a count.

### Views

- `index`: the whole system.
- `of_<part>`: one view per part with elements inside it.

On Rocket.Chat (`full`, rules and infrastructure) this gives 181 elements,
244 relations and no diagnostics.

## Feature views

`archmap feature-view <name> --seeds … [--depth 1–4] [--kinds …] [--direction in|out|both]`
writes `feature_<slug>.c4`.

**Seeds.** A seed can be:
- an element id (`rocketchat`, `mongo.users`);
- a route pattern (`/api/v1/rooms.*`);
- `ns:<broker service>`;
- `coll:<collection>`;
- a keyword, matched against titles and target keys.

**Search.** Breadth-first from the seeds along relations of the given kinds
and direction. A relation touches an element when it starts or ends at it, or
inside it.

**Acceptance.** Four scenarios on Rocket.Chat were fixed before the run
(`docs/m9-acceptance.md`) and all four pass. mini-complex has three exact
scenarios in `test/map/map.test.ts`.

## MCP servers

`archmap mcp` serves three tools over stdio and logs to stderr:

| Tool | What it does |
|---|---|
| `rebuild_map({variant, llm: cache-only \| live, model})` | Classify, match, resolve the open sites in select mode, then build and validate the map. By default it uses recorded model answers only, with no new spending. |
| `list_unresolved({run, cases?, type?, component?, limit ≤ 200})` | Sites left unresolved or ambiguous, as metadata only: location, type, case, reason, alternatives. A file of a closed licence zone gives no address. |
| `create_feature_view({name, seeds, depth, kinds?, direction?, run?})` | Adds and validates a feature view. |

`.mcp.json` registers it next to LikeC4's own read-only server
(`likec4 mcp <workspace>`, built into the LikeC4 CLI).

The test `test/map/map.test.ts` starts the server as a subprocess and calls
all three tools through the MCP client over stdio.
