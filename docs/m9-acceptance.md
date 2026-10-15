# Acceptance scenarios of the feature views (milestone M9)

The expected parts were written down before the views were generated.

- **Sources.** They come from the routing table of the labelling guide
  (§5.2–5.3, microservices profile) and from what each Rocket.Chat
  microservice is for. They do not come from the tool's output.
- **What each scenario sets.** The parts the view must contain and parts it
  must not contain. A part is a top-level element; an element inside it,
  such as an endpoint group or a broker namespace, counts as that part.
- **The run.** All scenarios run on `full` of Rocket.Chat: rules and
  infrastructure, before any language model decision.

| # | Feature | Seeds, depth, direction, kinds | Must contain | Must not contain | Why |
|---|---|---|---|---|---|
| S1 | Presence | `ns:presence`, 1, in, rpc | presence-service, rocketchat, ddp-streamer-service | web-client, livechat, desktop, mongo | The `presence` service runs in presence-service. The server sets statuses, and ddp-streamer reports websocket connections (`newConnection`, `removeConnection`). |
| S2 | Livechat widget | `livechat`, 1, out, http | livechat, rocketchat | presence-service, authorization-service, ddp-streamer-service | The widget calls the server's REST API only. |
| S3 | Users collection | `coll:users`, 1, in, db | rocketchat, account-service, presence-service | web-client, livechat, desktop | Logins (account-service) and status changes (presence-service) write `users`, as does the server. |
| S4 | Authorization | `ns:authorization`, 1, in, rpc | authorization-service, rocketchat | web-client, livechat, desktop | Permission checks are broker calls into authorization-service; the server makes most of them. |

`test/system/rocketchat.test.ts` checks the four scenarios.

## Result (run `full`, Rocket.Chat, 2026-10-15)

| # | Parts in the view | Verdict |
|---|---|---|
| S1 | ddp-streamer-service, presence-service, rocketchat | Passed: exactly the expected parts |
| S2 | livechat, rocketchat | Passed: exactly the expected parts |
| S3 | account-service, authorization-service, ddp-streamer-service, mongo (the seed's part), omnichannel-transcript-service, presence-service, queue-worker-service, rocketchat | Passed |
| S4 | authorization-service, ddp-streamer-service, rocketchat | Passed |

- **S3.** Every microservice reads the `users` collection through the
  shared models package. This is more than the three parts the scenario
  requires, and none of the excluded clients.
- **S4.** ddp-streamer also checks permissions through the authorization
  service.
