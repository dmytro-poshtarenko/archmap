# The language model layer (milestone M7)

## Providers

| Provider | Model | How answers are fixed |
|---|---|---|
| `cloud` (`AnthropicProvider`) | `claude-opus-5-5` | See below |
| `local` (`OllamaProvider`) | `qwen3:30b-a3b-instruct-2507-q4_K_M` | See below |
| `replay-local`, `replay-cloud` (`ReplayProvider`) | the recorded one | Recorded answers only; a request never recorded is an error |

**Cloud model.**
- Calls go through `client.messages.parse` with structured output
  (`zodOutputFormat`) and a fixed `output_config.effort` per task: extract
  `medium`, select `low`, free `medium`, probe `low`.
- The model takes no temperature, and its thinking cannot be switched off.
- The stable instructions go in a cached system block.
- There are no server-side fallbacks, and `response.model` is stored with
  every answer.
- Many requests go as one Message Batch at half price.
- `countTokens` counts input.

**Local model.**
- `/api/chat` is called with `format` set to the JSON schema, temperature 0,
  seed 42 and `think: false`.
- The window (`num_ctx`) is sized for each request.
- The schema only constrains decoding; the model never sees it. So every
  prompt names each field and value of its answer.
  - Found on 2026-10-20 in the dev run with prompt version 1, which named the
    kinds only in prose ("DDP methods").
  - qwen3 answered `http` with `POST` for every Meteor method: 250 of 250
    answers, 825 declarations, all `http`.
  - Version 2 names the values. On the same files it gives `ddp-method`
    (5 of 5) and keeps `http` for REST routes.
  - A test checks that every template names the fields and enum values of its
    schema.

**Input is never cut silently.**
- Ollama 0.40.2 refuses a prompt longer than the window: it returns
  `exceed_context_size_error` with the exact token count (checked live: a
  13,932-token prompt with `num_ctx` 2,048).
- The provider then sends the prompt again with a window that fits.
- Ollama can also refuse in plain text:
  `request (98485 tokens) exceeds the available context size (256 tokens)`.
  - It does this for its own check, and it raises a one-token window to 256.
  - The text still gives the exact count, and the provider reads both forms.
  - Before this was handled (found 2026-10-20), the exact count quietly fell
    back to the estimate, which was 8.5k tokens short on numbered code.
  - The refusal of the real request then stopped the H3 run after 10 of 90
    variants. Nothing was cut: Ollama refused rather than truncated.
- A prompt beyond the largest window (`maxCtx`, 131,072) is reported as
  `truncated-input` and gives no answer.

## Answer cache, budget, stability

- **Cache key.** Every request is keyed by the SHA-256 of:
  - task, provider and model;
  - the prompt as sent: system, user, schema, limits, effort and template
    version;
  - the repeat number.

  Answers are stored in `llm_answer` with the model that gave them, the stop
  reason, tokens, latency and cost. A repeated run asks nothing: in the live
  test, every request of the second run came from the cache, at $0.
- **No answer means no link.** A refusal, a cut at `max_tokens` or a
  truncated input leaves `parsed` empty, and the site gets no link.
- **Budget.** The budget check refuses requests whose worst-case cost (input
  estimated from length, output at the limit) would take the stored spending
  over `budgetUsd` (60).
- **Stability.** 10 % of the requests are chosen by their content (the same
  ones every run) and asked three times. `archmap llm-stats` reports how many
  gave the same decision; confidences and the order of lists are ignored.

## Code of closed licence zones

- **Cloud model.** Files of licence zones that are not publishable (Rocket.Chat
  Enterprise, `ee/` and `apps/meteor/ee/`) are never sent to the cloud model.
  Sites in such files stay unresolved in cloud runs.
- **Local model.** It reads them, since the code does not leave the machine.
- **Switch.** `llm.cloud.sendNonPublishable: true` would change this. It is
  the author's decision and is off.

## Tasks

| Task | Command | Input | Answer |
|---|---|---|---|
| (a) extract routes | `archmap llm-routes` | A server file matching a hint of `llm.extract.hints`, with line numbers | `{routes: [{kind, method, name, line}]}` → `route` rows with source `llm`, parts from the import graph (`file_usage`) |
| (b) select | `archmap resolve --mode select` | ±40 lines around the call (import block, call marked `>>`), the system description, up to 5 candidates | `{choice: C1…C5 \| NONE, confidence}` |
| (c) free | `archmap resolve --mode free` | The same, without candidates | `{target: {kind, method, name, component} \| null, confidence}` |
| (d) memorisation probe | used by milestone M8 | Project and file path only | The routes the model recalls |

- **Long files** are split only when `llm.chunking.enabled` is on (hypothesis
  3 decides):
  - top-level statements are packed into parts of at most `maxTokens`;
  - a call too long on its own (`Meteor.methods({ … })`) is split between its
    properties, each part repeating the opening line.
- **Routes the model extracts** count only where no rule declaration fits.
  They fill gaps and never override a rule.
- **System description.** It is built from what the variant may use: the
  parts of the config; with the infrastructure, containers and gateway rules;
  with the rules, where each broker service runs and the collections in the
  code.
- **Select-mode candidates.** They are the M5 ranking, with the rules' own
  answer first for a site already linked. An address without any text
  (`{?}`) gets no candidates, since nothing can be compared.
- **Free answers.** They are normalised against the method's catalog:
  - the part is found by id, alias or container host;
  - an HTTP path is fitted to the templates of that part, among the routes
    the variant knows: without the rules, only those the model extracted;
  - a collection's key names its database, whatever part the model gives.
    The key format fixes this part, as `*` for an event.

  Both rules were fixed on 2026-10-20 after the local dev run:
  - qwen named the right collection with the part that uses it
    (`coll:-:users@rocketchat`), so about 38 of 88 "invented" answers in
    full free mode were not inventions;
  - the HTTP fit had always used the rules' routes, so without the rules an
    answer could still reach a route only the rules declare.
  
  A key outside the catalog makes no link and is recorded as invented
  (`reason = llm-invented:<key>`).
- **Derived runs.** `resolve` writes `<base>.<mode>[-all].<local|cloud>`: the
  base run's links, with the model's decisions on the sites it was asked
  about. `--scope all` asks about every site (hypothesis 2); `--sites sample`
  only about the lines of the labelled sample.

## Live smoke test with the local model (Rocket.Chat)

**Route extraction (5 files).**
- 7 requests (2 stability repeats) in 2 min 23 s, 10 HTTP routes.
- qwen3 often drops the `/api/v1` prefix (`/v1/audit/rooms.members`) and once
  garbles one (`/api.apps.ui.interaction/:id`). The rules declare these
  routes anyway, so the full method is unaffected; the variant without rules
  will show this weakness.

**Resolution (20 open sites per mode).**
- **Select mode:** 12 sites had candidates; the 8 DDP sites had none, since
  no DDP declaration was extracted yet. 4 were linked and 8 got no target.
- **Free mode:** 20 answers, none in the method's catalog. One example of an
  invented target is `/api/v1/calendar.events.list` for the declared
  `/api/v1/calendar-events.list`.

**Rerun.** 100 % from the cache, $0. The repeated requests gave the same
decision (3 of 3).

**Cloud estimate.** `archmap llm-cost`, input estimated from length because
there is no key yet: about $29 at full price, about $15 in batches. That
covers route extraction (258 files), select and free on the 157 open sites,
with closed licence zones excluded. The budget is $60.

The cloud part of the smoke test (20 sites × 2 modes, 5 files with both
models) runs once the API key is set.
