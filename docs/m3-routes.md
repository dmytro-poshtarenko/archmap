# REST routes found by the rules vs rest-typings (milestone M3)

`archmap check-routes` compares the REST routes the Rocket.Chat rule pack
extracts with the typed catalog in `@rocket.chat/rest-typings`, which is part of
the reference and never of the method. A typed route counts as found when an
extracted route of the same method serves its path, by name or as a template:
`/livechat/users/:type` serves `/livechat/users/agent`. The full list is
written to `data/reports/rocketchat/routes-vs-rest-typings.md`.

| | Routes |
|---|---|
| Typed in rest-typings | 570 |
| Found by the rules | 557 (97.7 %) |
| Found by the rules but not typed in rest-typings | 155 |

Routes found but not typed are mostly endpoints declared with the validated
chained form (`API.v1.get(...).post(...)`). Their types are added by augmenting
`Endpoints` next to the handlers, not in rest-typings.

## The 13 typed routes not found

| Routes | Why |
|---|---|
| `POST /api/v1/login`, `POST /api/v1/logout`, `GET /api/v1/logout` | Added by `APIClass` itself to every instance with default authentication (`this.addRoute(['login'], …)` inside the class); no rule follows `this` to the instances |
| `POST /api/v1/im.kick` | Typed, but no handler in the snapshot |
| `/api/v1/federation/{searchPublicRooms, joinExternalPublicRoom, listServersByUser, addServerByUser, removeServerByUser}` | Typed, but no handler in the snapshot (federation v1 was removed) |
| `GET /api/v1/licenses.requestSeatsLink` | Typed, but no handler in the snapshot |
| `GET /api/v1/livechat/departments.by-unit/` | Typed with a trailing slash; the handler declares `livechat/departments.by-unit/:id` |
| `GET /api/apps/public/:appId/get-sidebar-icon` | Served by the apps router outside the REST router (`router.get` on the Express-like router of the apps API) |
