# Review of 50 extracted call sites on the dev split (milestone M3)

The Rocket.Chat rule pack was checked against the code on 50 call sites of the
dev split. These were 10 random sites of each interaction type, all 9 dev
trigger sites, and one more HTTP site (seed `20261015`, stream `m3-review`).
This is a development check of the extraction on the tuning data, not
reference labelling: nothing here is a label.

Each site was checked for its type and role, its address (path, method, stream,
action, collection or job name), and the components running its code.

## Findings and fixes

| # | Finding | Sites | Fix |
|---|---|---|---|
| 1 | Service proxies created outside `core-services` (`Instance` in `apps/meteor/ee/server/sdk`) were not recognised | 1 of 50, about 3 in the snapshot | A second proxy factory: `proxify` imported from `@rocket.chat/core-services`; bindings may name several factories (`a\|b`) |
| 2 | Web-client files were also attributed to `rocketchat`: `apps/meteor/vite/**` (the client build, `vite/entry.ts` imports `client/main.ts`) was mapped to the server | every web-client site (699) | `apps/meteor/vite/**` mapped to `web-client`; no web-client site runs in `rocketchat` any more |
| 3 | A livechat request leaving the client library kept being lifted although only an id (`tmid`) in a path segment came from the caller | 1 of 50 | The lift decision (an id in a segment stays, a path is lifted) applies at every level, not only the first |
| 4 | `useEndpoint('GET', endpointsByRoomType[type])` gave an unknown path | 1 of 50 | A computed key into a constant object gives the alternatives of its values: `/api/{/v1/im.members\|/v1/rooms.membersOrderedByRole}` |

After the fixes all 50 sites are correct, except two whose target is decided at
run time:
- `Meteor.callAsync(method, …)` in the `method.call` REST endpoint, where the method name comes from the request;
- a file URL in `useReloadOnError`.

Both stay unknown (`{?}`), as they should: their target cannot be recovered
from static sources.

## Checked sites

| Type | Sites | Correct after the fixes |
|---|---|---|
| broker (`api.broadcast`, service proxies) | 10 | 10 |
| db (model proxies → collections) | 10 | 10 |
| ddp (`useMethod`, `useStream`, `sdk.stream`, `Meteor.callAsync`) | 10 | 9 + 1 unknown by nature |
| http (`useEndpoint`, `sdk.rest`, `serverFetch`, `fetch`) | 11 | 10 + 1 unknown by nature |
| trigger (`cronJobs.add`, `addAtTimestamp`) | 9 | 9 |

Two observations for later milestones:
- **The ldap sync job** (`cronJobs.add(jobName, …)` in `ee/server/configuration/ldap.ts`) keeps `{param:jobName}`, because its function is not called by name.
- **Cached stores** call `sdk.call(\`${this.name}/get\`)`, so the method name depends on instance state (`{dyn}/get`).
