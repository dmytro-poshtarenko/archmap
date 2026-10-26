import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifySite } from "../../src/classify/features.js";
import { loadConfig } from "../../src/config/load.js";
import { dataLayout, resolveDataDir, toolRoot } from "../../src/core/paths.js";
import { hashOf } from "../../src/core/hash.js";
import { compareRoutes, typedRoutes } from "../../src/eval/restTypings.js";
import { extractAll, loadSites, programOf } from "../../src/extract/run.js";
import { loadRules } from "../../src/extract/rules.js";
import { extractInfra } from "../../src/infra/index.js";
import { hostOf } from "../../src/infra/model.js";
import { featureOf, type FeatureRequest } from "../../src/map/feature.js";
import { buildGraph } from "../../src/map/graph.js";
import { ALL_SOURCES } from "../../src/match/resolve.js";
import { loadLinks, matchingOf } from "../../src/match/run.js";
import { locateRepo } from "../../src/workspace/repos.js";

/**
 * System tests on the pinned Rocket.Chat snapshot. They need the fetched
 * repositories and the inventory (`archmap fetch`, `archmap inventory`) and
 * run with `pnpm test:system`.
 */
const layout = dataLayout(resolveDataDir());
const dbFile = join(layout.db, "rocketchat.sqlite");
const enabled = process.env.ARCHMAP_SYSTEM === "1" && existsSync(dbFile);

describe.runIf(enabled)("Rocket.Chat system", () => {
  const loaded = loadConfig(join(toolRoot, "configs", "rocketchat.yaml"));
  // opened only when the suite runs: a skipped suite is still collected, and a fresh workspace has no database
  let db: Database.Database;
  let files: Array<{ repo: string; path: string }> = [];
  beforeAll(() => {
    db = new Database(dbFile, { readonly: true });
    files = db.prepare("SELECT repo_id AS repo, path FROM file").all() as Array<{ repo: string; path: string }>;
  });
  afterAll(() => db?.close());
  const dirOf = (repo: string) => {
    const r = loaded.config.repos.find((x) => x.id === repo);
    return r ? locateRepo(r, layout, loaded.path).dir : "";
  };

  it("finds every microservice container, routes /websocket to the streamer, and resolves the broker and database", async () => {
    const facts = await extractInfra({ config: loaded.config, files, dirOf, helm: () => ({ error: "not used in this test" }) });
    const components = new Set(facts.containers.map((c) => c.component));
    for (const c of ["account-service", "authorization-service", "ddp-streamer-service", "omnichannel-transcript-service", "presence-service", "queue-worker-service"]) {
      expect(components).toContain(c);
    }
    const best = (path: string) =>
      facts.rules.filter((r) => r.match === "prefix" && path.startsWith(r.path)).sort((a, b) => b.priority - a.priority)[0]?.target;
    expect(best("/websocket")).toBe("ddp-streamer-service");
    expect(best("/sockjs/info")).toBe("ddp-streamer-service");
    expect(best("/api/v1/rooms.info")).toBe("rocketchat");
    const server = facts.containers.find((c) => c.component === "rocketchat");
    const byHost = (url: string | undefined) => facts.containers.find((c) => c.hostnames.includes(hostOf(url ?? "") ?? ""))?.component;
    expect(byHost(server?.env.TRANSPORTER)).toBe("nats");
    expect(byHost(server?.env.MONGO_URL)).toBe("mongo");
  });

  it("extracts the same sites and routes on every run, and finds at least 95 % of the typed REST routes", () => {
    const rules = loadRules(loaded.config.rules.packs);
    const run = () => {
      const r = extractAll(programOf(db as never, loaded.config, layout, loaded.path), rules, loaded.config.rules.liftDepth);
      return { r, hash: hashOf({ sites: r.sites, routes: r.routes }) };
    };
    const first = run();
    expect(run().hash).toBe(first.hash);
    expect(first.r.sites.length).toBeGreaterThan(4000);
    for (const type of ["http", "ddp", "broker", "db", "trigger"]) expect(first.r.stats.byType[type] ?? 0).toBeGreaterThan(0);
    const comparison = compareRoutes(typedRoutes(programOf(db as never, loaded.config, layout, loaded.path), "main"), first.r.routes);
    expect(comparison.recall).toBeGreaterThanOrEqual(0.95);
  }, 120_000);

  it("matches the stored sites the way the labelling guide routes them in the microservices profile", () => {
    const { resolver, sites } = matchingOf(db as never, loaded.config);
    const resolveAll = () => sites.map((s) => resolver.resolve(s, ALL_SOURCES));
    const all = resolveAll();
    expect(hashOf(resolveAll())).toBe(hashOf(all));
    expect(all.filter((r) => r.status === "linked").length).toBeGreaterThan(4000);
    const first = (pred: (i: number) => boolean) => all.findIndex((_, i) => pred(i));
    const named = (display: string, components?: string[]) =>
      first((i) => JSON.stringify(sites[i]?.address.parts) === JSON.stringify([{ k: "lit", v: display }]) && (!components || JSON.stringify(sites[i]?.components) === JSON.stringify(components)));

    const setStatus = named("presence.setStatus", ["rocketchat"]);
    expect(all[setStatus]?.target).toBe("action:-:presence.setStatus@presence-service");
    expect(classifySite(resolver, sites[setStatus] as never).caseNo).toBe(4);
    expect(all[named("license.hasModule", ["presence-service", "rocketchat"])]?.target).toBe("action:-:license.hasModule@rocketchat");
    expect(all[named("team.create", ["rocketchat"])]).toMatchObject({ status: "none", reason: "intra" });
    expect(all[named("users")]?.target).toBe("coll:-:users@mongo");
    expect(all[named("/api/v1/rooms.info", ["web-client"])]?.target).toBe("http:GET:/api/v1/rooms.info@rocketchat");
    // DDP declarations have no rules: without the language model's routes no DDP site links
    const withoutModel = sites.map((s) => resolver.resolve(s, { ...ALL_SOURCES, llmRoutes: false }));
    expect(sites.filter((s, i) => s.type === "ddp" && withoutModel[i]?.status === "linked")).toHaveLength(0);
  }, 60_000);

  it("passes the acceptance scenarios of the feature views (docs/m9-acceptance.md)", () => {
    const graph = buildGraph(loaded.config, "full", loadSites(db as never), loadLinks(db as never, "full"));
    const parts = (req: Omit<FeatureRequest, "name">) => new Set(featureOf(graph, { name: "s", ...req }).elements.map((e) => e.split(".")[0]));
    const scenarios: Array<[Omit<FeatureRequest, "name">, string[], string[]]> = [
      [{ seeds: ["ns:presence"], depth: 1, direction: "in", kinds: ["rpc"] }, ["presence-service", "rocketchat", "ddp-streamer-service"], ["web-client", "livechat", "desktop", "mongo"]],
      [{ seeds: ["livechat"], depth: 1, direction: "out", kinds: ["http"] }, ["livechat", "rocketchat"], ["presence-service", "authorization-service", "ddp-streamer-service"]],
      [{ seeds: ["coll:users"], depth: 1, direction: "in", kinds: ["db"] }, ["rocketchat", "account-service", "presence-service"], ["web-client", "livechat", "desktop"]],
      [{ seeds: ["ns:authorization"], depth: 1, direction: "in", kinds: ["rpc"] }, ["authorization-service", "rocketchat"], ["web-client", "livechat", "desktop"]],
    ];
    for (const [req, must, mustNot] of scenarios) {
      const got = parts(req);
      for (const p of must) expect(got, `${req.seeds[0]} must reach ${p}`).toContain(p);
      for (const p of mustNot) expect(got, `${req.seeds[0]} must not reach ${p}`).not.toContain(p);
    }
  });
});
