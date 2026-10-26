# The LikeC4 map, feature views and the MCP server (milestone M9)

## `archmap build-map [--run <id>]`

This writes `data/out/<target>/<run>/likec4/c4-model.c4` and validates it with
LikeC4 1.59.4 (`LikeC4.fromWorkspace(...).getErrors()`, the same check as
`likec4 validate`). Feature views made earlier are kept next to it.

- **Default run.** Without `--run`, it draws the full method with the model's answers (`full.select.<model>`), or `full` when no model has run.
- **The `current` link.** A valid map becomes the one `data/out/<target>/current` points to. `archmap view`, `feature-view` and both MCP servers open that link.
- **Viewing.** `archmap view [--run <id>] [--port 5173]` starts the LikeC4 viewer on the map.
- **Project title.** `likec4.config.json` next to the model names the project `<product>: C4 Diagrams`; LikeC4 shows it in the browser tab. The product is the last part of the main repository's URL (`Rocket.Chat`), else the config's name.
- **File order.** The model file is named `c4-model.c4` so the viewer lists its C1, C2 and C3 views before the feature views.

### Elements

- **The whole system,** as one element of kind `system`, for the C1 view.
- **The parts of the config:** `client`, `service`, `gateway`, `bus`, `database`, `external` and `scheduler`.
  - Each gets a `technology` drawn under its title. For a known image it is the product and version (`mongodb/mongodb-community-server:8.0` → MongoDB 8.0, `nats:2.6` → NATS 2.6, `traefik:v3.6` → Traefik 3.6).
  - Otherwise it is the frameworks the package.json of its code names: React Native, Electron, Next.js, Preact, React, Vue, Angular and Svelte for a client; Node.js with Moleculer, NestJS, Express, Fastify, Koa, hapi, Socket.IO, BullMQ or ws for a server-side container. Meteor is added when the code unit has `.meteor/release`.
  - A mobile technology draws the client as a phone.
- **External systems,** one per domain (`ext_slack_com`), from the call sites the method recognised as leaving the system (link status `none`, reason `external`):
  - a base address taken from a setting gets the setting's default value from the code (`{setting:Cloud_Url}` → `https://cloud.rocket.chat`);
  - the domain is the host's last two labels.
- **Inside a part, elements of kind `endpointGroup`:**
  - HTTP routes grouped by their first word (`ep_rooms` for `/api/v1/rooms.*`);
  - `ddp_methods` and `ddp_streams`;
  - broker namespaces (`ns_presence` for `presence.*`).
- **Collections inside the database** (`mongo.users`). A collection is tagged `#shared` when two or more containers use it with code of their own; shared-code relations do not count.
- **Scheduled jobs** are a `jobs` element inside the container that registers them. The jobs run in that container's process, so they are not a container of their own.
- **Summary.** Every element has a `summary`, one line drawn on it: what a part holds (`73 REST groups, 15 DDP methods, 1 DDP subscription, 12 broker namespaces, 18 scheduled jobs`), what a client calls, how many collections a database has. The longer `description` is in its details.
- **No links.** A client or service with no relation and nothing inside is tagged `#noLinks`. It is drawn light grey, and its summary counts its call sites (`No links found: 2 call sites, 2 unresolved`).

### Which containers run a call

A call site belongs to the parts that run it under the run's deployment. The map asks the method's own narrowing, `Resolver.componentsOf`, with the run variant's sources:
- a broker service class runs only where it is registered;
- code loaded only under conditions the profile makes false does not run there.

A relation whose every site still belongs to two or more parts is tagged `#sharedCode`: the call sits in a package several containers bundle, e.g. `packages/models`, and which of them makes it is not known. It is drawn dotted grey, its description names the package, and it stays out of the C2 summaries.

### Relations

Relations are aggregated by (source part, target element, kind). The line says whether a call waits for its answer:

| Kind | What | Style |
|---|---|---|
| http | REST over HTTP | Solid blue |
| ddp | DDP method | Solid blue |
| rpc | Broker action | Solid blue |
| stream | DDP subscription | Dashed amber |
| event | Broker event | Dashed amber |
| db | Database access | Solid grey |
| route | A gateway's rule (gateway views only) | Dashed teal |

**How relations are drawn and labelled:**
- **Events** go from the publisher to the bus and from the bus to the subscriber.
- **Routes** go from a gateway to each part its rules send requests to, e.g. `traefik → ddp-streamer-service` for `/websocket` and `/sockjs`. They come from the infrastructure step, and only the gateway views draw them.
- **Labels say what.** The names behind a relation are ranked by how many call sites use them, then alphabetically, and the label shows the first three and `+N`.
  - The prefix the target box already shows is left out: `/api/v1/` before a route of the chat group, `presence.` before an action of `presence.*`.
  - An arrow to a collection has no title, because the box names the collection.
- **Protocols.** Every relation has a `technology` that LikeC4 prints under the label:
  - `HTTP` or `HTTPS`;
  - `WebSocket (DDP)`;
  - `<bus> (RPC)` and `<bus> (events)`;
  - the database's protocol.

  A call that passed a gateway adds `via <gateway>`. DDP over a WebSocket that the gateway sends to another container adds `through <that container>`. The bus and database protocols come from the scheme of the URLs other containers reach them by (`TRANSPORTER=nats://nats:4222` → NATS, `MONGO_URL=mongodb://…` → MongoDB), else from their images.
- **Summary arrows (`#overview`)** are what the C2 views draw: one per direction between two containers, standing for every call between them.
  - **Title:** what flows, e.g. `REST: livechat, users, rooms +70 groups (474 routes)`, `RPC: authorization.*, abac.* (26 actions)`, `events: notify.*, watch.*, user.* +13 (60)`. Groups are ranked by how many names they hold.
  - **Technology:** the protocols written once per base (`NATS (RPC, events)`) and the gateway passed.
  - **Events** go straight from each publisher to each subscriber of the same event: the C4 "via" notation instead of a hub.
  - **DDP** that a gateway sends to another container's WebSocket goes to that container; its broker arrow to the method's owner shows the forwarding.
  - **Left out:** shared-code relations, the gateway's own relations and the bus.
  - The C3 and feature views draw only the calls themselves, and the feature search ignores summary arrows and gateway relations.
- **Gateway relations (`#gateway`)**, for the gateway views:
  - the gateway's rules;
  - from each part whose calls pass the gateway to the gateway, with what they send.
- **Descriptions.** A developer reads these in the details:
  - **a part:** what it holds, which parts use it and which it uses, which events it publishes and receives;
  - **an element inside a part:** the routes, methods or names in use there;
  - **an arrow:** every name behind it, up to twelve, what decided it and the number of call sites.
- **Tags:**
  - `#rules`, `#infra` or `#llm` for what decided the link;
  - `#ambiguous` when the site keeps several possible targets, one relation to each;
  - `#viaGateway` when the request passes a gateway;
  - `#sharedCode`, `#overview` and `#gateway` as above.
- **Metadata:** the cases, one call site, the number of sites, the gateways passed, the container that terminates a WebSocket, and the run.
- **No code text** reaches the model.

### Notation

The specification defines its own colours, one per element type, and a `notation` text for every element and relationship kind. The viewer's legend lists the element kinds; LikeC4 1.59 keeps its relationship tab disabled. So every view's description starts with what the view shows and ends with a Markdown key to the arrows, line styles and grey boxes.

### Views

Every title starts with its level of the C4 model.

- `context` (C1): the system and the external systems it calls, each arrow counting the endpoints reached.
- `index` (C2): the containers that run code or hold data (clients, services, databases, schedulers).
  - `rank source` puts the clients on top and `rank sink` the databases at the bottom.
  - Only summary arrows are drawn: `exclude * -> * where tag is not #overview`.
  - `autoLayout TopBottom 160 100`.
  - The gateway, the bus and external systems are on views of their own.
- `external_systems` (C2): the containers that call outside the system, and the external systems.
- `gateway_<name>` (C2): who sends requests through a gateway, and where its rules send them by path.
- `bus_<name>` (C2): which containers publish events to a bus and which receive them.
- `of_<part>` (C3): one view per part with elements inside it, titled `C3: <part> (API groups and their callers)`.
  - A part with more than 12 elements inside lays them out top to bottom, not in one row.
  - A database with more than 12 collections shows only the ones two or more parts share, because sharing is the interaction through a database. The view's description counts what it leaves out.

**On Rocket.Chat:**
- `full` (rules and infrastructure, before the C4 levels): 181 elements, 244 relations, no diagnostics.
- The final map (`full.select.cloud`, the frozen method with the cloud model): 195 elements, 293 relations, no diagnostics.
- The C2 view has 12 containers and 24 summary arrows. Six pairs of arrows cross, against 31 before the review; the count is the reviewer's strict one on LikeC4's own layout.

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

- **Name.** The name is in English: the feature, then in parentheses what the view holds, e.g. `User presence (presence service actions, their callers, sessions collection)`.
  - The title gets the C4 level: C3 when the view includes components inside a container, C2 otherwise. A level the caller wrote is replaced.
  - The view id comes from the words before the parenthesis (`feature_user_presence`). A name with no Latin letters or digits gets a short hash.
- **Description.** The view's description records the seeds, depth, direction, kinds and run.
- **Merged arrows.** When a container is shown closed, LikeC4 draws all calls into it as one arrow and labels it `[...]` if their titles differ. The view gives such an arrow a title and protocol in the C2 style (`include rocketchat -> authorization-service with { title 'RPC: abac.*, authorization.* (26 actions)' }`). An arrow into a container shown open keeps LikeC4's label, because the rule would also draw the calls to its hidden elements. No view of the final map has a `[...]` label.
- **Removing.** `archmap remove-view <view id or name>` or the MCP tool `delete_feature_view` removes a feature view.

**Acceptance.** Four scenarios on Rocket.Chat were fixed before the run
(`docs/m9-acceptance.md`) and all four pass. mini-complex has three exact
scenarios in `test/map/map.test.ts`.

## MCP servers

`archmap mcp` serves four tools over stdio and logs to stderr:

| Tool | What it does |
|---|---|
| `rebuild_map({variant, llm: cache-only \| live, model})` | Classify, match, resolve the open sites in select mode, then build and validate the map. By default it uses recorded model answers only, with no new spending. |
| `list_unresolved({run, cases?, type?, component?, limit ≤ 200})` | Sites left unresolved or ambiguous, as metadata only: location, type, case, reason, alternatives. A file of a closed licence zone gives no address. |
| `create_feature_view({name, seeds, depth, kinds?, direction?, run?})` | Adds and validates a feature view. It returns the parts, the links between them with their routes, and the viewer address of the view. |
| `delete_feature_view({view, run?})` | Removes a feature view, by its view id or the name it was made with. |

`.mcp.json` registers it next to LikeC4's own read-only server
(`likec4 mcp ../data/out/rocketchat/current`, built into the LikeC4 CLI).
`rebuild_map` uses the cloud model of the config by default, from recorded
answers only.

The test `test/map/map.test.ts` starts the server as a subprocess and calls
all three tools through the MCP client over stdio.
