import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import { storeCatalog } from "../../src/labelling/catalog.js";
import { startLabellingServer } from "../../src/labelling/server.js";
import { openCandidates, openLabels } from "../../src/labelling/store.js";
import { tempDir, writeTree } from "../helpers.js";
import { fakeSnapshot } from "./fixtures.js";

const CODE = Array.from({ length: 60 }, (_, i) => `const line${i + 1} = ${i + 1};`);
CODE[19] = "const getInfo = useEndpoint('GET', '/v1/rooms.info');";
CODE[21] = "await fetch(url);";

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function setup(role: "primary" | "second" = "primary", reuse?: { root: string }) {
  const root = reuse?.root ?? tempDir();
  const layout = dataLayout(join(root, "data"));
  writeTree(root, { "guide.md": "# Посібник\n\nВерсія: 1.0\n" });
  const snapshot = fakeSnapshot({
    "main:src/a.ts": { text: CODE.join("\n"), component: "web-client" },
    "main:src/gap.ts": { text: "export const x = 1;\nawait fetch(y);\n", split: "dev" },
    "main:src/other.ts": { text: "export {};\n" },
    "main:src/t.ts": { text: "fetch(z);\n", split: "test" },
  });
  const cdb = openCandidates(layout, "t");
  if (!reuse) seed(cdb);
  const labels = {
    dev: openLabels(layout, "t", "dev", "annotate", false),
    test: openLabels(layout, "t", "test", "annotate", false),
  };
  const server = await startLabellingServer({
    port: 0,
    annotator: role === "second" ? "B" : "A",
    role,
    guide: { version: "1.0+test", path: join(root, "guide.md") },
    snapshot,
    candidates: cdb,
    labels,
  });
  closers.push(server.close);
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(new URL(path, server.url), init);
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
  };
  const post = (path: string, body: unknown) =>
    call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { root, server, call, post, labels };
}

function seed(cdb: ReturnType<typeof openCandidates>) {
  const insert = cdb.prepare(
    "INSERT INTO candidate(id, repo, path, line, split, component, stratum, patterns, text_sha) VALUES (?, 'main', ?, ?, ?, ?, ?, ?, 'x')",
  );
  insert.run("main:src/a.ts:20", "src/a.ts", 20, "dev", "web-client", "http", '["rocketchat.use-endpoint"]');
  insert.run("main:src/a.ts:22", "src/a.ts", 22, "dev", "web-client", "http", '["generic.fetch"]');
  insert.run("main:src/t.ts:1", "src/t.ts", 1, "test", null, "http", '["generic.fetch"]');
  cdb.prepare("INSERT INTO sample(candidate, pool, rank, double) VALUES ('main:src/a.ts:20', 'main', 1, 0), ('main:src/a.ts:22', 'main', 2, 1), ('main:src/t.ts:1', 'main', 3, 0)").run();
  cdb.prepare("INSERT INTO gap_file(repo, path, split, rank) VALUES ('main', 'src/gap.ts', 'dev', 1)").run();
  storeCatalog(cdb, [{ key: "http:GET:/api/v1/rooms.info@rocketchat", kind: "http", name: "/api/v1/rooms.info", component: "rocketchat", source: null, note: "rest-typings" }]);
}

const label = (overrides: Record<string, unknown> = {}) => ({
  item: "main:src/a.ts:20",
  repo: "main",
  path: "src/a.ts",
  line: 20,
  endLine: null,
  origin: "sample",
  isSite: true,
  type: "http",
  target: "http:GET:/api/v1/rooms.info@rocketchat",
  caseNo: 1,
  reason: null,
  note: null,
  ...overrides,
});

describe("labelling interface", () => {
  it("listens on the loopback interface only and refuses foreign pages", async () => {
    const { server, call } = await setup();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const port = new URL(server.url).port;
    const rebound = await new Promise<number>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/api/state", headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(rebound).toBe(403);
    const plain = await call("/api/label?split=dev", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(label()) });
    expect(plain.status).toBe(415);
  });

  it("serves the page, the guide, the state and the queue in labelling order", async () => {
    const { call } = await setup();
    expect((await call("/")).body).toContain("archmap");
    expect((await call("/guide")).body).toContain("Версія: 1.0");
    expect((await call("/api/state")).body).toMatchObject({ annotator: "A", guide: "1.0+test", splits: { dev: { total: 2, done: 0 }, test: { total: 1 } } });
    const queue = (await call("/api/queue?split=dev")).body as Array<{ item: string; rank: number }>;
    expect(queue.map((q) => q.item)).toEqual(["main:src/a.ts:20", "main:src/a.ts:22"]);
    expect((await call("/api/queue?split=heldout")).status).toBe(403);
  });

  it("shows the code around a site with nearby candidates, except when reading blind", async () => {
    const { call } = await setup();
    const item = (await call("/api/item?split=dev&item=main:src/a.ts:20")).body as {
      code: { from: number; lines: string[] };
      candidateLines: number[];
      label: unknown;
    };
    expect(item.code.from).toBe(1);
    expect(item.code.lines[19]).toContain("useEndpoint");
    expect(item.candidateLines).toEqual([20, 22]);
    expect(item.label).toBeNull();
    const blind = (await call("/api/item?split=dev&item=main:src/gap.ts:2&blind=1")).body as { candidateLines: number[] };
    expect(blind.candidateLines).toEqual([]);
    expect((await call("/api/item?split=dev&item=main:../../etc/passwd:1")).status).toBe(404);
    expect((await call("/api/item?split=test&item=main:src/a.ts:20")).status).toBe(400);
  });

  it("saves valid labels of sampled items and gap-check lines only", async () => {
    const { call, post } = await setup();
    expect((await post("/api/label?split=dev", label())).status).toBe(200);
    expect((await call("/api/state")).body).toMatchObject({ splits: { dev: { done: 1 } } });
    expect((await post("/api/label?split=dev", label({ caseNo: null }))).status).toBe(400);
    const outside = label({ item: "main:src/other.ts:1", path: "src/other.ts", line: 1 });
    expect((await post("/api/label?split=dev", outside)).status).toBe(400);
    const gap = label({ item: "main:src/gap.ts:2", path: "src/gap.ts", line: 2, origin: "gap", target: "NONE", caseNo: null, reason: "external" });
    expect((await post("/api/label?split=dev", gap)).status).toBe(200);
    const files = (await call("/api/gap")).body as Array<{ sites: unknown[]; reviewed: boolean }>;
    expect(files[0]?.sites).toHaveLength(1);
    expect((await post("/api/gap/done", { repo: "main", path: "src/gap.ts" })).status).toBe(200);
    expect(((await call("/api/gap")).body as Array<{ reviewed: boolean }>)[0]?.reviewed).toBe(true);
  });

  it("shows whole files only for the gap check", async () => {
    const { call } = await setup();
    expect((await call("/api/file?repo=main&path=src/gap.ts")).status).toBe(200);
    expect((await call("/api/file?repo=main&path=src/other.ts")).status).toBe(403);
  });

  it("searches and extends the catalog", async () => {
    const { call, post } = await setup();
    expect(((await call("/api/catalog?q=rooms info")).body as Array<{ key: string }>).map((e) => e.key)).toEqual([
      "http:GET:/api/v1/rooms.info@rocketchat",
    ]);
    expect((await post("/api/catalog", { key: "ddp:call:saveSettings@rocketchat" })).status).toBe(200);
    expect((await post("/api/catalog", { key: "not a key" })).status).toBe(400);
    expect(((await call("/api/catalog?q=saveSettings")).body as Array<{ origin: string }>)[0]?.origin).toBe("manual");
  });

  it("gives the second annotator only the double items, without the first annotator's labels", async () => {
    const first = await setup();
    const saved = await first.post(
      "/api/label?split=dev",
      label({ item: "main:src/a.ts:22", line: 22, target: "NONE", caseNo: null, reason: "external", type: "http" }),
    );
    expect(saved.status).toBe(200);
    const second = await setup("second", { root: first.root });
    const queue = (await second.call("/api/queue?split=dev")).body as Array<{ item: string; done: boolean; summary: unknown }>;
    expect(queue).toEqual([expect.objectContaining({ item: "main:src/a.ts:22", done: false, summary: null })]);
    const item = (await second.call("/api/item?split=dev&item=main:src/a.ts:22")).body as { label: unknown };
    expect(item.label).toBeNull();
    expect((await second.post("/api/label?split=dev", label())).status).toBe(400);
  });
});
