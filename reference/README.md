# The reference labels

The labels of the measurements on Rocket.Chat. The thesis author made them by hand (annotator `A`), following `docs/labelling-guide.md`, blind to the method's answers. They say where a call site is and how it was labelled, never the code.

| File | Split | Labels | From the stratified sample | From the gap check |
|---|---|---|---|---|
| `dev.jsonl` | dev: the method was tuned on it | 157 | 135 | 22 |
| `test.jsonl` | test: the frozen method was measured on it | 289 | 265 | 24 |
| `heldout.jsonl` | the held-out mobile client | 76 | 76 | — |

**Columns:**
- `repo`, `sha`, `path`, `line`, `end_line`: where the site is, at the pinned commit;
- `annotator`: who labelled it;
- `origin`: `sample` for the stratified sample, `gap` for the files the gap check read in full;
- `is_site`: 1 when the line is a call site;
- `type`: `http`, `ddp`, `broker`, `db` or `trigger`;
- `target`: the target key, e.g. `http:GET:/api/v1/rooms.info@rocketchat`; `NONE` when the call leaves the system or has no target in it;
- `case`: the case of the classification, 1–8;
- `reason`: why a line is not a site, or has no target;
- `guide`: the version of the labelling guide.

**To use them,** draw the same sample first (the seeds are fixed), then import:

```bash
pnpm archmap label candidates && pnpm archmap label sample
pnpm archmap label import --split test --file reference/test.jsonl
```

Labels of sites in Rocket.Chat's Enterprise code are included: they hold no code.
