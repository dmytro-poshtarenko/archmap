import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { dataLayout, toolRoot } from "../../src/core/paths.js";
import { loadRoutes, loadSites, programOf, runExtraction } from "../../src/extract/run.js";
import { display, hopKinds } from "../../src/extract/value.js";
import { openDb } from "../../src/store/db.js";
import { runInventory } from "../../src/workspace/inventory.js";
import { locateRepo } from "../../src/workspace/repos.js";
import { tempDir } from "../helpers.js";

interface ExpectedSite {
  at: string;
  type: string;
  role: string;
  method?: string;
  address: string;
  hops: string[];
  lifted?: boolean;
}
interface ExpectedRoute {
  at: string;
  kind: string;
  method: string | null;
  template: string;
  component: string;
}

/** Runs the inventory and the extraction on a fixture and returns what was found, in the fixtures' terms. */
function extract(configPath: string) {
  const loaded = loadConfig(configPath);
  const db = openDb(":memory:");
  const layout = dataLayout(tempDir());
  runInventory(db, loaded.config, layout, loaded.path, { allowHeldout: false, configHash: loaded.hash });
  runExtraction(db, loaded.config, programOf(db, loaded.config, layout, loaded.path), { force: true });
  const read = (repo: string, path: string) => {
    const r = loaded.config.repos.find((x) => x.id === repo);
    if (!r) throw new Error(`no repo ${repo}`);
    return readFileSync(join(locateRepo(r, layout, loaded.path).dir, path), "utf8");
  };
  const sites = loadSites(db).map((s) => ({
    at: `${s.repo}:${s.path}:${s.line}`,
    type: s.type,
    role: s.role,
    ...(s.method ? { method: display(s.method) } : {}),
    address: display(s.address),
    hops: hopKinds(s.address),
    ...(s.liftedFrom ? { lifted: true } : {}),
  }));
  const routes = loadRoutes(db).map((r) => ({
    at: `${r.repo}:${r.path}:${r.line}`,
    kind: r.kind,
    method: r.method,
    template: r.template,
    component: r.components[0] ?? null,
  }));
  return { sites, routes, read };
}

/** `repo:path:12` or `repo:path:@text` (first line containing the text) → `repo:path:line`. */
function resolveAt(at: string, read: (repo: string, path: string) => string): string {
  const m = /^([^:]+):(.+?):(@.+|\d+)$/.exec(at);
  if (!m) throw new Error(`bad anchor ${at}`);
  const [, repo = "", path = "", where = ""] = m;
  if (!where.startsWith("@")) return at;
  const lines = read(repo, path).split("\n");
  const index = lines.findIndex((l) => l.includes(where.slice(1)));
  if (index === -1) throw new Error(`anchor ${at} not found`);
  return `${repo}:${path}:${index + 1}`;
}

function expectedOf(file: string, read: (repo: string, path: string) => string) {
  const doc = parseYaml(readFileSync(file, "utf8")) as { sites?: ExpectedSite[]; routes?: ExpectedRoute[] };
  const sites = (doc.sites ?? []).map((s) => ({ ...s, at: resolveAt(s.at, read), hops: [...s.hops].sort() }));
  const routes = (doc.routes ?? []).map((r) => ({ ...r, at: resolveAt(r.at, read) }));
  return { sites, routes };
}

const byAt = (a: { at: string; template?: string }, b: { at: string; template?: string }) =>
  a.at === b.at ? String(a.template).localeCompare(String(b.template)) : a.at.localeCompare(b.at, "en", { numeric: true });

describe("extraction on the case fixtures", () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`case ${n} matches its expected sites and routes`, () => {
      const dir = join(toolRoot, "fixtures", "cases", `case${n}`);
      const found = extract(join(dir, "archmap.yaml"));
      const expected = expectedOf(join(dir, "expected.yaml"), found.read);
      expect([...found.sites].sort(byAt)).toEqual([...expected.sites].sort(byAt));
      expect([...found.routes].sort(byAt)).toEqual([...expected.routes].sort(byAt));
    });
  }
});

describe("extraction on mini-complex", () => {
  it("matches the expected output", () => {
    const found = extract(join(toolRoot, "configs", "mini.yaml"));
    const expected = expectedOf(join(toolRoot, "fixtures", "mini-complex", "expected.yaml"), found.read);
    expect([...found.sites].sort(byAt)).toEqual([...expected.sites].sort(byAt));
    expect([...found.routes].sort(byAt)).toEqual([...expected.routes].sort(byAt));
  });
});

