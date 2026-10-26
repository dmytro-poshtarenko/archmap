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
| 6 | Recognition rather than recall | Hovering a part shows what it holds and who uses it. Hovering an arrow shows its routes and what decided it. A feature view records its seeds, depth and kinds. | **Fixed:** elements and arrows had no descriptions, so the routes behind an arrow were hidden. **Open:** the legend is in the index description, not drawn on the canvas. |
| 7 | Flexibility and efficiency of use | The CLI suits scripts, the viewer exploring, MCP an agent. Seeds can be ids, route patterns, broker services, collections or keywords, with depth, direction and kind filters. The viewer exports PNG, JPG, D2, Mermaid, PlantUML and draw.io. | **Fixed:** the route pattern `/api/v1/livechat*` matched nothing, because `*` stopped at `/`. It now spans `/`. |
| 8 | Aesthetic and minimalist design | Parts are boxes coloured by kind, parallel links merge into one arrow, and endpoint groups stay inside their part. | **Fixed:** the `mongo` view (77 collections) and the `rocketchat` view (94 groups) drew one row thousands of pixels wide. A database now shows its 19 shared collections, and large parts lay their contents out top to bottom. **Fixed:** on the C2 view, arrows tangled like spaghetti, and LikeC4 labelled merged arrows `[...]`. Containers now sit in rows, and one arrow per pair says what flows and by which protocol. Broker calls both ways share an arrow, and the external systems moved to a C2 view of their own. |
| 9 | Help users recognise, diagnose, and recover from errors | Errors name the cause and the next step: «run 'x' has no links; run `archmap match` first», «no map in …; run `archmap build-map` first», seeds that match nothing are listed. MCP tools return their errors as tool errors with the message. | No problems found. |
| 10 | Help and documentation | The README section «Using the map» covers the commands, the views, the seeds, setting up MCP in Claude Code and questions to try. Every command has `--help`, and every MCP tool a description. | No problems found. |
