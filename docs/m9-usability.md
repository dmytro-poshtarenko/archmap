# Usability of the map: Nielsen's ten heuristics (milestone M9)

**What was checked:**
- the LikeC4 views of the final Rocket.Chat map (`full.select.cloud`);
- the commands that build and open them;
- the two MCP servers as an agent uses them.

**How.** One evaluator (the author) went through each heuristic and checked it against the views, the commands and the tools. Nielsen recommends three to five evaluators, so this is a first pass, not a complete evaluation.

**Results.**
- Problems found and fixed on 2026-10-26: 8, marked **Fixed**. Some came from the author's own testing.
- Problems left: 2, marked **Open**.

| # | Heuristic | What the tool does | Finding |
|---|---|---|---|
| 1 | Visibility of system status | `build-map` prints the run, element and relation counts, and LikeC4's diagnostics. The index view's description names the run. `rebuild_map` returns the run, counts, open sites and diagnostics. | **Fixed:** the browser tab read `default`, and nothing said which view is which C4 level. The tab now reads `<product>: C4 Diagrams`, and every title starts with `C1:`, `C2:` or `C3:`. |
| 2 | Match between system and the real world | Parts carry their deployment names (`rocketchat`, `ddp-streamer-service`). Routes appear as developers write them (`GET /api/v1/rooms.info`). Relation kinds are the interaction types of the thesis. | **Open:** `rpc` for broker actions and `endpoint group` are the tool's terms. They are explained in the legend, not in the boxes. |
| 3 | User control and freedom | The viewer offers back and forward, zoom, fit, and opening a part's view from the map. Making a feature view again under the same name replaces it. `rebuild_map` never spends on the model unless asked (`llm: live`). | **Fixed:** no command removed a feature view; now `archmap remove-view` and the MCP tool `delete_feature_view` do. |
| 4 | Consistency and standards | One colour and line style per relation kind in every view. The same tags everywhere (`#rules`, `#infra`, `#llm`, `#viaGateway`, `#ambiguous`, `#shared`). One key format in the map, the CLI and MCP. | **Fixed:** names without Latin letters all became the same view id `feature`, so each new view replaced the last; they now get an id of their own. Names are in English, and every title starts with its C4 level. |
| 5 | Error prevention | `rebuild_map` defaults to recorded answers. Live runs have a budget limit. LikeC4 validates every write, and a map with diagnostics does not become `current`. | **Fixed:** the gateway was drawn as a box with no links, which reads as a missing part; its routing rules are now drawn. |
| 6 | Recognition rather than recall | Hovering a part shows what it holds and who uses it. Hovering an arrow shows its routes and what decided it. A feature view records its seeds, depth and kinds. | **Fixed:** elements and arrows had no descriptions, so the routes behind an arrow were hidden. **Open, in part:** the viewer's notation panel lists the element kinds, but LikeC4 1.59 keeps its relationship tab disabled, so the line styles are explained only in each view's description. |
| 7 | Flexibility and efficiency of use | The CLI suits scripts, the viewer exploring, MCP an agent. Seeds can be ids, route patterns, broker services, collections or keywords, with depth, direction and kind filters. The viewer exports PNG, JPG, D2, Mermaid, PlantUML and draw.io. | **Fixed:** the route pattern `/api/v1/livechat*` matched nothing, because `*` stopped at `/`. It now spans `/`. |
| 8 | Aesthetic and minimalist design | Parts are boxes coloured by kind, parallel links merge into one arrow, and endpoint groups stay inside their part. | **Fixed:** the `mongo` view (77 collections) and the `rocketchat` view (94 groups) drew one row thousands of pixels wide. A database now shows the collections several containers share (11 in `mongo`), and large parts lay their contents out top to bottom. **Fixed:** on the C2 view, arrows tangled like spaghetti, and LikeC4 labelled merged arrows `[...]`. Clients now sit on top and databases at the bottom, and one arrow per direction says what flows and by which protocol. The external systems, the gateway and the event bus each have a C2 view of their own (see the independent review below). |
| 9 | Help users recognise, diagnose, and recover from errors | Errors name the cause and the next step: «run 'x' has no links; run `archmap match` first», «no map in …; run `archmap build-map` first», seeds that match nothing are listed. MCP tools return their errors as tool errors with the message. | No problems found. |
| 10 | Help and documentation | The README section «Using the map» covers the commands, the views, the seeds, setting up MCP in Claude Code and questions to try. Every command has `--help`, and every MCP tool a description. | No problems found. |

## Independent review (2026-10-26)

A separate reviewer looked at all 18 views. It never saw how they were designed.
- **What it measured** on LikeC4's own layout: crossings, fit-to-screen zoom and labels.
- **How it checked accuracy:** against the database and the Rocket.Chat source.

What came of its findings:

| Finding | Change in the generator |
|---|---|
| C2 had 31 pairs of crossing arrows. The tier boxes alone doubled the crossings, and the "Scheduled jobs" box and the NATS hub drew things that are not containers or hid who talks to whom. | The tier boxes are gone. `rank source` puts the clients on top and `rank sink` the databases at the bottom. Scheduled jobs are a component inside their container. Events go straight from publisher to subscriber. The gateway and the bus each have a view of their own, and there is one arrow per direction. 31 → 6 crossing pairs. |
| False arrows: the map took every part that loads a file, not the parts the deployment runs it in (`queue-worker → rocketchat`, monolith-only code under the microservices profile). | The map asks the method's own narrowing (`Resolver.componentsOf`). Code several containers bundle is `#sharedCode`: drawn dotted, and kept out of C2 and out of "shared collection". |
| DDP drawn to `rocketchat` although the gateway sends the WebSocket to `ddp-streamer-service`. | On C2, DDP goes to the container that terminates the gateway's WebSocket. On the other views it is labelled `through` that container. |
| Labels said "how many", not "what". Names were ranked alphabetically, so 10 labels began with `DELETE`. | Names are ranked by call sites, and the prefix the target box shows is cut. C2 labels name the top groups (`REST: livechat, users, rooms +70 groups (474 routes)`). Arrows to collections are untitled. Units are the same across levels. |
| No key, and colours that collided (client = gateway, database = external systems). | Own colours, one per type, and a `notation` on every kind for the viewer's legend. A Markdown key is in every view's description. Line style tells request, asynchronous and data apart. |
| Boxes said nothing about what they are or are built with, and `mobile` stood alone with no explanation. | A `technology` comes from the images and package.json, and a one-line `summary` sits on every element. A container with no links is drawn light grey, and its summary counts its call sites. |

Still open, from the same review:
- **The two giant C3 views.** `of_rocketchat` is 96 nodes in one column, and `of_mongo` is dense.
- **Container C3 views** do not show what the container itself uses.
- **Feature views** still draw every relation between their elements, not only the feature's path.
- **C1 shows no people,** and external systems are grouped by domain rather than by purpose.

