# Matching, cases and variants (milestone M5)

`archmap classify` predicts the case of every call site; `archmap match`
resolves every site under one variant of the method and stores the run.

## Resolution

One resolver serves every variant and the classifier. A `Sources` switch says
what it may use:

| Source | Contents | Hidden by |
|---|---|---|
| `rules` | Addresses of the sites found by the rule bindings, route declarations of the detectors | `--no-rules` |
| `llmRoutes` | Declarations extracted by the language model (milestone M7) | `--no-llm` |
| `env` | Container environment, the profile's `infra.env`, service registration guards, which services are deployed | `--no-infra` |
| `gateway` | Gateway routing rules | `--no-infra` |

Each type is resolved by name, so the target key is the same one the labelling
guide uses.

### HTTP

1. **Address forms.** Alternatives are expanded into separate forms. The
   query string and the fragment are dropped. Each form gets a host and path
   segments:
   - the host is `none` for a relative path, a literal, an `env` or `setting`
     name, or `unknown`;
   - each segment is a literal, a run-time segment (from a parameter, from
     configuration, or unknown), a glob (text glued to a value) or an unknown
     tail;
   - a template written at the call site (`/v1/visitor/:token`) counts as a
     parameter.
2. **Fitting routes.** Three steps:
   - an exact comparison with parameters named alike;
   - path-to-regexp 8 for concrete paths;
   - a segment-by-segment comparison otherwise.

   Literal-to-literal segments rank first, and a run-time segment prefers a
   parameter to a literal. A fit that needs a guess is weak and never links on
   its own: a run-time segment against a literal, a glob, or an unknown tail.
   A route with the site's exact method ranks above one taking any method.
3. **The host decides the part.**
   - A literal host, or an `env` or `setting` value from the containers
     running the site (or the profile), names a container and so a part.
   - A gateway host passes the gateway's rules.
   - `localhost` means the site's own part.
   - Any other host is outside the system.
   - A relative path from a browser client passes the gateway: the
     highest-priority rule wins, its rewrite applies, and the route must
     exist in the rule's target. When the gateway's target has no such route,
     the direct match decides.
   - A base address from configuration that no part of the system serves is
     an outside service: `none (external)`.

### Other types

- **DDP methods and subscriptions.**
  - Matched by name against `ddp-method` declarations. The rules have none,
    so without the language model every DDP site stays unresolved: that is
    case 5.
  - A client's DDP traffic takes the transport path of the Meteor pack
    (`/websocket`) through the gateway. The receiving part handles what it
    declares itself and forwards the rest.
- **Broker actions.**
  - Matched by `<service>.<action>`.
  - A service runs where it is registered (`registerService` calls), unless
    the registration's guard is false for the environment of that part. The
    Rocket.Chat pack maps `isRunningMs()` to `TRANSPORTER ~ ^(nats|TCP)`.
  - A registration in a part the deployment does not run counts for nothing.
  - No registration left: `none (not-deployed)`.
- **Events.**
  - The name alone is the key (`event:-:<name>@*`).
  - A name with run-time pieces is matched against the names the code uses
    elsewhere.
- **Collections.**
  - The database part is the one the site's containers reach through their
    environment (`MONGO_URL`).
  - Without infrastructure, the single database component of the config is
    used.
- **Timers.** The part that runs the registering code.
- **Code of a broker service class** runs where its service runs. So a cron
  job or a call inside `Presence` runs in `presence-service` under the
  microservices profile, not in `rocketchat`, which imports the class only to
  register it when `!isRunningMs()`.

### Outcomes

- **One part left.** The site is linked, unless that part is every part
  running the site: `none (intra)`.
- **Two or more parts left.** The site is ambiguous.
- **An address that chooses among known alternatives at run time**
  (`endpointsByRoomType[type]`) is linked to each of them. The target key is
  the first alternative; the run stores them all.

## Cases

Features are read from the resolution with every source:

| Feature | Present when |
|---|---|
| c1 | The address is written at the call site: no substitutions, no hops |
| c2 | HTTP with substitutions (parameter, run-time value, environment, setting) and the path visible |
| c3 | The address was found by following declarations (hops) or by lifting from a wrapper |
| c4 | The site is linked, and resolving it again without the environment changes the answer |
| c5 | The address is determined, but no rule declaration fits it (and the site has a target) |
| c6 | Two or more parts remain |
| c7 | The site is linked, and resolving it again without the gateway rules changes the answer |
| c8 | Part of the address is known only at run time: an unknown host, a glob, an unknown segment or tail, or any non-literal part of a name |

- The case is the highest feature present.
- It is null when the method finds no target in the system (`none`), as the
  guide gives a case only to sites with a target.
- c4 and c7 are measured, not inferred: the evidence was needed exactly when
  taking it away changes the link.

## Variants and runs

- **Run id.** `match` stores a run under the variant's name: `full`,
  `no-llm`, `no-infra+no-llm`, and so on. Running a variant again replaces it.
- **One row per site.** Each site gets a row in `link`:
  - status, target key, route, part, reason, gateways passed;
  - provenance: `rules`, or `infra` when the answer without the environment
    and gateway differs;
  - predicted case and alternatives.
- **Candidates.** Ambiguous and unresolved sites get up to five candidates in
  `candidate` for the language model's select mode. Score = 0.5 × Jaccard of
  name tokens + 0.3 × (1 − normalised Levenshtein distance) + 0.1 × method
  match + 0.1 × reachability. Targets the rules leave open come first.

## Rocket.Chat, microservices profile, without the language model

These are counts over all 5,250 sites; no reference labels are involved.

| | Sites |
|---|---|
| Linked | 4,608 (db 3,478, http 662, broker 449, trigger 19) |
| No target in the system (`none`) | 471 (calls within `rocketchat`, outside services, services not deployed) |
| Unresolved | 171 (all 96 DDP sites: no declaration rules; unknown addresses) |
| Decided by the infrastructure | 103 (broker actions of `presence`, `authorization`, `abac` and the presence cron job) |

Predicted cases:

| Case | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | none |
|---|---|---|---|---|---|---|---|---|---|
| Sites | 897 | 13 | 3,597 | 103 | 80 | 0 | 0 | 89 | 471 |

- **No case 7 yet.** Without DDP declarations nothing in Rocket.Chat needs
  the gateway: every REST path exists only in `rocketchat`. The streams and
  the presence methods that ddp-streamer handles itself become case 7 once
  the language model extracts the declarations.
- **Without the infrastructure** (`no-infra+no-llm`), 105 sites become
  ambiguous and the 103 infrastructure-decided links are lost: exactly the
  case 4 sites.

## For the labelling guide

The guide (v1.1) has no rule for a site that chooses among known addresses at
run time:
- `endpointsByRoomType[type]` in `useMembersList` calls `/v1/im.members` or
  `/v1/rooms.membersOrderedByRole`;
- 4 such sites are on the dev split.

The method links such a site to every alternative. The pilot should settle
how to label them, for example the first alternative in the code with a note,
and record the decision in guide v1.2.
