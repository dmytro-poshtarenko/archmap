# Performance profile

Measured on 2026-10-15 on an Apple M3 Max (48 GB) with Node.js 24.18, on the
Rocket.Chat snapshot pinned in `configs/rocketchat.lock.json` (main `16badb07`,
desktop `158b7c6c`, helm-charts `eea375d7`). Times are wall-clock; memory is the
peak resident set size of the process.

| Step | Input | Time | Memory |
|---|---|---|---|
| Parse every code file with the TypeScript 6.0.2 parser bundled in ts-morph 28, no type checker, all trees kept | 8,306 files, 18 MB of text, 2.7 M nodes | 1.2 s | 0.8 GB |
| Type checker over the largest code unit, `apps/meteor`, without `node_modules` | 4,483 files | 0.8 s to load, 1.3 s for 4,000 type queries | 0.87 GB |
| `archmap inventory` | 10,040 files of three repositories | < 1 s | — |
| `archmap label candidates` | 5,748 candidates in 1,647 files | 1.5 s | — |
| `archmap extract` with `generic@1` and `meteor@1` | 8,306 code files | 2.9 s: parse 1.2, calls 1.3, lifting 0.1, routes 0.2 | 0.98 GB |
| `archmap extract` with `generic@1`, `meteor@1` and `rocketchat@1` | 8,306 code files; 5,250 sites, 1,017 routes | 6.6 s: parse and import graph 1.3, calls 4.3, lifting 0.3, routes 0.7 | 0.96 GB |

To reproduce:

```bash
/usr/bin/time -l pnpm archmap extract --force
```

## Decisions taken from the profile

The plan budgeted for a slow, memory-hungry extraction: three or four worker
processes with 8 GB heaps, a text prefilter so that only 10–20 % of the files
are parsed, and a fact cache keyed by file hash, extractor version and rules
hash. The profile shows none of these is needed:

- **One process.** It keeps the syntax trees of the whole snapshot for the run,
  so cross-file resolution never re-parses a file.
- **No prefilter and no per-file cache.** Parsing everything costs about a
  second, less than the bookkeeping these would add.
- **Skipping unchanged runs.** `archmap extract` skips the run when neither the
  inventory hash nor the rules hash changed since the last one; `--force` runs
  it anyway.
- **Type checker on demand.** It stays affordable for the cases the syntactic
  evaluator cannot decide (level 2 of address evaluation).

