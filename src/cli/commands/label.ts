import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { sha256Hex } from "../../core/hash.js";
import { extractionAsFrozen, gapReport } from "../../eval/gap.js";
import { toolRoot } from "../../core/paths.js";
import { findCandidates, loadCandidates, storeCandidates } from "../../labelling/candidates.js";
import { storeCatalog } from "../../labelling/catalog.js";
import { GUIDE_PATH, guideVersion } from "../../labelling/guide.js";
import { extractCatalog } from "../../labelling/catalogs/index.js";
import { exportLabels, importJsonl, toCsv, toJsonl } from "../../labelling/exchange.js";
import { agreement } from "../../labelling/labels.js";
import { compilePacks } from "../../labelling/patterns.js";
import { drawGapFiles, drawSample, loadSample, sampleHash, storeGapFiles, storeSample } from "../../labelling/sample.js";
import { startLabellingServer } from "../../labelling/server.js";
import { openSnapshot } from "../../labelling/snapshot.js";
import { openCandidates, openLabels, SPLITS, type Split } from "../../labelling/store.js";
import { type Db, getMeta } from "../../store/db.js";
import { type CliContext, createContext, type GlobalOptions } from "../context.js";


function snapshotOf(ctx: CliContext) {
  const db = ctx.openDb();
  return { db, snapshot: openSnapshot(db, ctx.loaded.config, ctx.layout, ctx.loaded.path) };
}

function packsOf(ctx: CliContext, snapshot: ReturnType<typeof openSnapshot>) {
  return compilePacks(ctx.loaded.config.labelling.packs, (repo, path) => snapshot.read(repo, path));
}

function splitArg(value: string): Split {
  if (!SPLITS.includes(value as Split)) throw new Error(`split must be one of ${SPLITS.join(", ")}`);
  return value as Split;
}

function table(rows: Array<Record<string, string | number>>): void {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0] ?? {});
  console.log(cols.join("\t"));
  for (const r of rows) console.log(cols.map((c) => r[c]).join("\t"));
}

export function registerLabel(program: Command): void {
  const label = program.command("label").description("reference labelling: candidates, sample, interface, export");

  label
    .command("candidates")
    .description("find candidate call sites with the text patterns of the labelling packs and build the reference catalog")
    .option("--force", "replace candidates even though a sample was drawn from them (the sample is dropped)")
    .action((opts: { force?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { db, snapshot } = snapshotOf(ctx);
      const cdb = openCandidates(ctx.layout, ctx.loaded.config.name);
      try {
        const packs = packsOf(ctx, snapshot);
        const found = findCandidates(snapshot, packs);
        if (opts.force) {
          cdb.exec("DELETE FROM sample; DELETE FROM gap_file; DELETE FROM meta WHERE key LIKE 'sample.%'");
          ctx.log("dropped the stored sample; draw it again with 'archmap label sample'");
        }
        const { changed } = storeCandidates(cdb, found, { packsHash: packs.hash, inventoryHash: snapshot.inventoryHash });
        const counts = new Map<string, Record<string, number>>();
        for (const c of found) {
          const row = counts.get(c.stratum) ?? { dev: 0, test: 0, heldout: 0 };
          row[c.split] = (row[c.split] ?? 0) + 1;
          counts.set(c.stratum, row);
        }
        table([...counts.entries()].sort().map(([stratum, r]) => ({ stratum, dev: r.dev ?? 0, test: r.test ?? 0, heldout: r.heldout ?? 0 })));
        console.log(`${found.length} candidates in ${new Set(found.map((c) => `${c.repo}:${c.path}`)).size} files${changed ? "" : " (unchanged)"}`);
        storeCatalog(cdb, extractCatalog(ctx.loaded.config.labelling.packs, snapshot));
        const kinds = cdb.prepare("SELECT kind, count(*) AS n FROM catalog GROUP BY kind ORDER BY kind").all() as Array<{ kind: string; n: number }>;
        console.log(`reference catalog: ${kinds.map((k) => `${k.kind} ${k.n}`).join(", ")}`);
      } finally {
        cdb.close();
        db.close();
      }
    });

  label
    .command("sample")
    .description("draw the stratified sample (and the gap-check files) with the configured seed")
    .option("--heldout", "draw the held-out sample (after the freeze)")
    .option("--check", "recompute the sample and compare it with the stored one")
    .option("--force", "replace a different stored sample")
    .action((opts: { heldout?: boolean; check?: boolean; force?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      if (opts.heldout && !ctx.frozen()) throw new Error("the held-out sample is drawn only after the method is frozen");
      const { db, snapshot } = snapshotOf(ctx);
      const cdb = openCandidates(ctx.layout, config.name);
      try {
        const pool = opts.heldout ? "heldout" : "main";
        const candidates = loadCandidates(cdb).filter((c) => (pool === "heldout" ? c.split === "heldout" : c.split !== "heldout"));
        if (candidates.length === 0) throw new Error("no candidates; run 'archmap label candidates' first");
        const params = {
          seed: config.experiment.seeds.sample,
          size: pool === "heldout" ? config.experiment.sample.heldout : config.experiment.sample.main,
          minPerStratum: config.experiment.sample.minPerType,
          doubleShare: config.experiment.secondAnnotator,
        };
        const sample = drawSample(pool, candidates, params);
        if (opts.check) {
          const stored = getMeta(cdb, `sample.${pool}.hash`);
          const same = stored === sampleHash(sample);
          console.log(same ? `${pool} sample: identical to the stored one` : `${pool} sample: DIFFERS from the stored one`);
          if (!same) process.exitCode = 1;
          return;
        }
        const result = storeSample(cdb, sample, { force: opts.force ?? false, params: { ...params, candidates: getMeta(cdb, "candidates.hash") } });
        if (pool === "main") {
          const packs = packsOf(ctx, snapshot);
          storeGapFiles(cdb, drawGapFiles(snapshot, packs.gapImports, config.labelling.gapFiles, params.seed, ["dev", "test"]));
        }
        const bySplit = new Map<string, Map<string, number>>();
        const splitOf = new Map(candidates.map((c) => [c.id, c.split]));
        for (const item of sample.items) {
          const row = bySplit.get(item.stratum) ?? new Map<string, number>();
          const split = splitOf.get(item.candidate) ?? "?";
          row.set(split, (row.get(split) ?? 0) + 1);
          bySplit.set(item.stratum, row);
        }
        table(
          Object.entries(sample.allocation).map(([stratum, a]) => ({
            stratum,
            population: a.population,
            sample: a.sample,
            dev: bySplit.get(stratum)?.get("dev") ?? 0,
            test: bySplit.get(stratum)?.get("test") ?? 0,
            double: sample.items.filter((i) => i.stratum === stratum && i.double).length,
          })),
        );
        console.log(`${pool} sample of ${sample.items.length}: ${result}`);
      } finally {
        cdb.close();
        db.close();
      }
    });

  label
    .command("serve")
    .description("open the local labelling interface (127.0.0.1); it never shows the tool's answers")
    .option("--annotator <id>", "annotator id stored with each label", "A")
    .option("--second", "second annotator: only the items drawn for double labelling")
    .option("--port <n>", "port", "4100")
    .action(async (opts: { annotator: string; second?: boolean; port: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { config } = ctx.loaded;
      const { snapshot } = snapshotOf(ctx);
      const cdb = openCandidates(ctx.layout, config.name);
      const frozen = ctx.frozen();
      const labels: Partial<Record<Split, Db>> = {
        dev: openLabels(ctx.layout, config.name, "dev", "annotate", frozen),
        test: openLabels(ctx.layout, config.name, "test", "annotate", frozen),
      };
      if (frozen) labels.heldout = openLabels(ctx.layout, config.name, "heldout", "annotate", frozen);
      const server = await startLabellingServer({
        port: Number(opts.port),
        annotator: opts.annotator,
        role: opts.second ? "second" : "primary",
        guide: { version: guideVersion(), path: GUIDE_PATH },
        snapshot,
        candidates: cdb,
        labels,
      });
      console.log(`labelling interface for ${opts.annotator}: ${server.url}`);
      ctx.log("press Ctrl+C to stop");
      process.on("SIGINT", () => {
        void server.close().then(() => process.exit(0));
      });
    });

  label
    .command("export")
    .description("export labels without code: repo, sha, path, line, type, target, case (test and held-out only after the freeze)")
    .requiredOption("--split <split>", "dev, test or heldout", splitArg)
    .option("--format <format>", "jsonl or csv", "jsonl")
    .option("--annotator <id>", "only this annotator")
    .option("--out <file>", "write to a file instead of stdout")
    .action((opts: { split: Split; format: string; annotator?: string; out?: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const ldb = openLabels(ctx.layout, ctx.loaded.config.name, opts.split, "evaluate", opts.split === "dev" || ctx.frozen());
      try {
        const shas = new Map(ctx.loaded.config.repos.map((r) => [r.id, r.sha ?? "local"]));
        const rows = exportLabels(ldb, (repo) => shas.get(repo) ?? "unknown", opts.annotator);
        const text = opts.format === "csv" ? toCsv(rows) : toJsonl(rows);
        if (opts.out) {
          writeFileSync(opts.out, text);
          ctx.log(`${rows.length} labels written to ${opts.out}`);
        } else process.stdout.write(text);
      } finally {
        ldb.close();
      }
    });

  label
    .command("import")
    .description("import labels exported with 'label export --format jsonl', e.g. from the second annotator")
    .requiredOption("--split <split>", "dev, test or heldout", splitArg)
    .requiredOption("--file <file>", "JSON lines file")
    .option("--annotator <id>", "store under this annotator instead of the one in the file")
    .action((opts: { split: Split; file: string; annotator?: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const ldb = openLabels(ctx.layout, ctx.loaded.config.name, opts.split, "annotate", opts.split !== "heldout" || ctx.frozen());
      try {
        const n = importJsonl(ldb, readFileSync(opts.file, "utf8"), { annotator: opts.annotator });
        console.log(`${n} labels imported into ${opts.split}`);
      } finally {
        ldb.close();
      }
    });

  label
    .command("agreement")
    .description("Cohen's kappa between two annotators, for the target and for the case")
    .requiredOption("--split <split>", "dev, test or heldout", splitArg)
    .option("--first <id>", "first annotator", "A")
    .option("--second <id>", "second annotator", "B")
    .option("--details", "list the disagreements")
    .action((opts: { split: Split; first: string; second: string; details?: boolean }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const ldb = openLabels(ctx.layout, ctx.loaded.config.name, opts.split, "evaluate", opts.split === "dev" || ctx.frozen());
      try {
        const result = agreement(ldb, opts.first, opts.second);
        const fmt = (k: { n: number; observed: number; kappa: number | null }) =>
          `n=${k.n}, agreement ${(k.observed * 100).toFixed(1)}%, kappa ${k.kappa === null ? "undefined" : k.kappa.toFixed(3)}`;
        console.log(`target: ${fmt(result.target)}`);
        console.log(`case:   ${fmt(result.case)}`);
        console.log(`disagreements: ${result.disagreements.length}`);
        if (opts.details) for (const d of result.disagreements) console.log(JSON.stringify(d));
      } finally {
        ldb.close();
      }
    });

  label
    .command("gap-report")
    .description("the gap check: in the files read in full, how many call sites the text search for candidates and the method's extraction found")
    .option("--annotator <id>", "whose labels are the reference", "A")
    .action((opts: { annotator: string }, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const { name } = ctx.loaded.config;
      const allowed = extractionAsFrozen(toolRoot);
      if (!allowed.ok) throw new Error(`the gap check reads test labels: ${allowed.reason}`);
      const cdb = openCandidates(ctx.layout, name);
      const labels = { dev: openLabels(ctx.layout, name, "dev", "evaluate", true), test: openLabels(ctx.layout, name, "test", "evaluate", true) };
      const db = ctx.openDb();
      try {
        const r = gapReport({ candidates: cdb, labels, method: db, annotator: opts.annotator });
        const pct = (k: number, n: number) => (n === 0 ? "–" : `${((100 * k) / n).toFixed(1)} %`);
        console.log(`files read in full: ${r.reviewed} of ${r.files}`);
        console.log(`call sites: ${r.all.sites}; text search found ${r.all.inFrame} (${pct(r.all.inFrame, r.all.sites)}), the method's extraction ${r.all.byMethod} (${pct(r.all.byMethod, r.all.sites)})`);
        console.log(
          `with a target in the system: ${r.targeted.sites}; text search ${r.targeted.inFrame}, extraction ${r.targeted.byMethod}; 95 % upper bound of the miss rate: text search ${pct(r.targeted.missUpper.frame, 1)}, extraction ${pct(r.targeted.missUpper.method, 1)}`,
        );
        for (const s of r.sites.filter((x) => !x.inFrame || !x.byMethod)) {
          console.log(`  missed by ${[!s.inFrame ? "text search" : "", !s.byMethod ? "extraction" : ""].filter(Boolean).join(" and ")}: ${s.split} ${s.repo}:${s.path}:${s.line} (${s.type ?? "?"}, ${s.target})`);
        }
        const out = join(ctx.layout.root, "reports", name, "gap");
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "gap_report.json"), `${JSON.stringify({ ...r, sites: undefined }, null, 2)}\n`);
        const header = "split,repo,path,line,type,target,origin,in_frame,by_method";
        const rows = r.sites.map((s) => [s.split, s.repo, s.path, s.line, s.type ?? "", s.target, s.origin, s.inFrame ? 1 : 0, s.byMethod ? 1 : 0].join(","));
        writeFileSync(join(out, "gap_sites.csv"), `${[header, ...rows].join("\n")}\n`);
        console.log(`written to ${out}`);
      } finally {
        db.close();
        labels.dev.close();
        labels.test.close();
        cdb.close();
      }
    });

  label
    .command("status")
    .description("labelling progress per split and annotator")
    .action((_opts: unknown, cmd: Command) => {
      const ctx = createContext(cmd.optsWithGlobals<GlobalOptions>());
      const cdb = openCandidates(ctx.layout, ctx.loaded.config.name);
      try {
        const sample = loadSample(cdb, "main");
        const splitOf = new Map(loadCandidates(cdb).map((c) => [c.id, c.split]));
        console.log(`candidates: ${getMeta(cdb, "candidates.count") ?? 0}; main sample: ${sample.length}; gap files: ${cdb.prepare("SELECT count(*) FROM gap_file").pluck().get()}`);
        // Progress counts only: the test labels themselves are not read before the freeze.
        for (const split of ["dev", "test"] as const) {
          const ldb = openLabels(ctx.layout, ctx.loaded.config.name, split, "annotate", false);
          try {
            const inSplit = sample.filter((s) => splitOf.get(s.candidate) === split);
            const byAnnotator = ldb.prepare("SELECT annotator, origin, count(*) AS n FROM label GROUP BY annotator, origin").all() as Array<{
              annotator: string;
              origin: string;
              n: number;
            }>;
            console.log(`${split}: ${inSplit.length} sampled (${inSplit.filter((s) => s.double).length} double); labels ${byAnnotator.map((r) => `${r.annotator}/${r.origin} ${r.n}`).join(", ") || "none"}`);
          } finally {
            ldb.close();
          }
        }
      } finally {
        cdb.close();
      }
    });
}
