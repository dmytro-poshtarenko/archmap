import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { runClassify } from "../../src/classify/run.js";
import { loadConfig } from "../../src/config/load.js";
import { canonicalTargetKey } from "../../src/core/keys.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { loadSites, programOf, runExtraction } from "../../src/extract/run.js";
import { extractInfra, writeInfra } from "../../src/infra/index.js";
import { loadCandidates, loadLinks, runMatch, type Variant } from "../../src/match/run.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { locateRepo } from "../../src/workspace/repos.js";
import { tempDir } from "../helpers.js";

interface ExpectedLink {
  site: string;
  target: string | null;
  case: number;
}

const NO_LLM: Variant = { rules: true, infra: true, llm: false };

/** Inventory, extraction, infrastructure, cases and one matching run on a fixture, all in memory. */
async function pipeline(configPath: string, variant: Variant = NO_LLM) {
  const loaded = loadConfig(configPath);
  const { config } = loaded;
  const db = openDb(":memory:");
  const layout = dataLayout(tempDir());
  runInventory(db, config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
  runExtraction(db, config, programOf(db, config, layout, loaded.path), { force: true });
  const dirOf = (repo: string) => {
    const r = config.repos.find((x) => x.id === repo);
    if (!r) throw new Error(`no repo ${repo}`);
    return locateRepo(r, layout, loaded.path).dir;
  };
  const files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
  writeInfra(db, await extractInfra({ config, files, dirOf }), "test");
  runClassify(db, config);
  const run = runMatch(db, config, variant, { configHash: loaded.hash });
  const read = (repo: string, path: string) => readFileSync(join(dirOf(repo), path), "utf8");
  const lineOf = new Map(loadSites(db).map((s) => [s.id, `${s.repo}:${s.path}:${s.line}`]));
  const links = loadLinks(db, run.run).map((l) => ({ ...l, at: lineOf.get(l.site) as string }));
  return { db, run: run.run, links, read };
}

/** `repo:path:@text` → `repo:path:line` of the first line containing the text. */
function resolveAt(at: string, read: (repo: string, path: string) => string): string {
  const m = /^([^:]+):(.+?):@(.+)$/.exec(at);
  if (!m) return at;
  const [, repo = "", path = "", text = ""] = m;
  const index = read(repo, path)
    .split("\n")
    .findIndex((l) => l.includes(text));
  if (index === -1) throw new Error(`anchor ${at} not found`);
  return `${repo}:${path}:${index + 1}`;
}

function expectedLinks(file: string, read: (repo: string, path: string) => string): Array<ExpectedLink & { at: string }> {
  const doc = parseYaml(readFileSync(file, "utf8")) as { links?: ExpectedLink[] };
  return (doc.links ?? []).map((l) => ({ ...l, at: resolveAt(l.site, read) }));
}

describe("matching the case fixtures without the language model", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`case ${n} gives the expected target and case`, async () => {
      const dir = join(toolRoot, "fixtures", "cases", `case${n}`);
      const found = await pipeline(join(dir, "archmap.yaml"));
      const expected = expectedLinks(join(dir, "expected.yaml"), found.read);
      expect(expected.length).toBeGreaterThan(0);
      for (const e of expected) {
        const link = found.links.find((l) => l.at === e.at);
        expect(link, e.site).toBeDefined();
        if (!link) continue;
        expect(link.caseNo, e.site).toBe(e.case);
        if (e.case === 5) {
          // the declaration needs the language model: nothing to link to yet
          expect(link.status, e.site).toBe("unresolved");
        } else if (e.case === 6) {
          // two parts fit and nothing in the deployment decides: both are offered
          expect(link.status, e.site).toBe("ambiguous");
          expect(link.alternatives.map(canonicalTargetKey), e.site).toContain(canonicalTargetKey(e.target as string));
          const offered = loadCandidates(found.db, found.run, link.site).map((c) => canonicalTargetKey(c.target));
          expect(offered.slice(0, link.alternatives.length), e.site).toContain(canonicalTargetKey(e.target as string));
        } else {
          expect(link.target, e.site).toBe(e.target);
        }
      }
    });
  }
});

describe("matching mini-complex", () => {
  it("links every site without the language model", async () => {
    const found = await pipeline(join(toolRoot, "configs", "mini.yaml"));
    const expected = expectedLinks(join(toolRoot, "fixtures", "mini-complex", "expected.yaml"), found.read);
    const got = found.links.map((l) => ({ at: l.at, target: l.target, case: l.caseNo })).sort((a, b) => a.at.localeCompare(b.at, "en", { numeric: true }));
    const want = expected.map((e) => ({ at: e.at, target: e.target, case: e.case })).sort((a, b) => a.at.localeCompare(b.at, "en", { numeric: true }));
    expect(got).toEqual(want);
    expect(found.links.filter((l) => l.at.startsWith("web:")).every((l) => l.via.includes("traefik"))).toBe(true);
  });

  it("loses only what each source contributes when it is switched off", async () => {
    const noInfra = await pipeline(join(toolRoot, "configs", "mini.yaml"), { rules: true, infra: false, llm: false });
    // nothing here needs the deployment: the same targets, decided by the rules alone
    expect(noInfra.links.filter((l) => l.status === "linked")).toHaveLength(8);
    expect(noInfra.links.every((l) => l.provenance === null || l.provenance === "rules")).toBe(true);
    const noRules = await pipeline(join(toolRoot, "configs", "mini.yaml"), { rules: false, infra: true, llm: false });
    expect(noRules.links.every((l) => l.status === "unresolved" && l.reason === "rules-off")).toBe(true);
  });
});

describe("variants on the case fixtures", () => {
  it("needs the deployment for cases 4 and 7", async () => {
    for (const n of [4, 7]) {
      const dir = join(toolRoot, "fixtures", "cases", `case${n}`);
      const full = await pipeline(join(dir, "archmap.yaml"));
      const bare = await pipeline(join(dir, "archmap.yaml"), { rules: true, infra: false, llm: false });
      const site = (links: typeof full.links) => links.find((l) => l.caseNo === n);
      expect(site(full.links)?.status).toBe("linked");
      expect(site(full.links)?.provenance).toBe("infra");
      expect(site(bare.links)?.status).not.toBe("linked");
    }
  });
});
