import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { toolRoot } from "../../src/core/paths.js";
import { runH3 } from "../../src/experiments/h3run.js";
import { LlmClient } from "../../src/llm/client.js";
import type { LlmAnswer, LlmProvider, LlmRequest } from "../../src/llm/types.js";
import { openDb } from "../../src/store/db.js";
import { tempDir } from "../helpers.js";
import { mulberry32 } from "../../src/core/prng.js";
import { detectRoutes, found, paddingStatements, prepareController, renameRoute, variantsOf } from "../../src/experiments/h3.js";

const CONTROLLER = `import { API } from '../api';

const schema = { type: 'object' };

API.v1.get(
\t'widgets.list',
\t{ authRequired: true },
\tasync function action() {
\t\treturn API.v1.success({ widgets: [] });
\t},
);

function helper(id: string) {
\treturn id.trim();
}

API.v1.addRoute(
\t'widgets/:id',
\t{ authRequired: true },
\t{
\t\tasync get() {
\t\t\treturn API.v1.success({ id: helper(this.urlParams.id) });
\t\t},
\t\tasync delete() {
\t\t\treturn API.v1.success();
\t\t},
\t},
);
`;

const POOL = Array.from({ length: 400 }, (_, i) => `export function pad${i}(value: number): number {\n\tconst doubled = value * ${i + 2};\n\treturn doubled > 100 ? doubled - 1 : doubled + 1;\n}`);

describe("hypothesis 3 variants", () => {
  it("renames route words and keeps separators and parameters", () => {
    const taken = new Set<string>();
    const renamed = renameRoute("livechat/visitor/:token", mulberry32(1), taken);
    expect(renamed).toMatch(/^[a-z]+\/[a-z]+\/:token$/);
    expect(renamed).not.toContain("livechat");
    expect(renameRoute("livechat/visitor/:token", mulberry32(1), taken)).not.toBe(renamed);
  });

  it("prepares a controller whose routes the detector still finds under new names", () => {
    expect(detectRoutes("api/v1/widgets.ts", CONTROLLER).map((r) => `${r.method} ${r.template}`)).toEqual(["GET /api/v1/widgets.list", "GET /api/v1/widgets/:id", "DELETE /api/v1/widgets/:id"]);
    const c = prepareController("c01", "main:api/v1/widgets.ts", "api/v1/widgets.ts", CONTROLLER, mulberry32(7), new Set());
    expect(c.text).not.toContain("widgets.list");
    expect(c.path).not.toContain("widgets");
    expect(c.routes.map((r) => [r.method, r.original])).toEqual([
      ["GET", "widgets.list"],
      ["GET", "widgets/:id"],
      ["DELETE", "widgets/:id"],
    ]);
  });

  it("pads to every level, keeps the routes and their places, and moves them in the position series", () => {
    const c = prepareController("c01", "main:api/v1/widgets.ts", "api/v1/widgets.ts", CONTROLLER, mulberry32(7), new Set());
    const variants = variantsOf(c, POOL, [4_000, 16_000], 8_000, 11);
    expect(variants.map((v) => v.id)).toEqual(["c01-L0", "c01-L1", "c01-L2", "c01-P-start", "c01-P-middle", "c01-P-end"]);
    const [l0, l1, l2] = variants;
    expect(l1?.chars).toBeGreaterThanOrEqual(4_000);
    expect(l2?.chars).toBeGreaterThanOrEqual(16_000);
    for (const v of variants) expect(v.routes).toHaveLength(3);
    const first = (v: (typeof variants)[number] | undefined) => v?.routes[0]?.position ?? -1;
    expect(Math.abs(first(l2) - first(l0))).toBeLessThan(0.1);
    const pos = (id: string) => variants.find((v) => v.id === id)?.routes.map((r) => r.position) ?? [];
    expect(Math.max(...pos("c01-P-start"))).toBeLessThan(0.2);
    expect(Math.min(...pos("c01-P-end"))).toBeGreaterThan(0.8);
  });

  it("refuses padding that declares routes", () => {
    const c = prepareController("c01", "main:api/v1/widgets.ts", "api/v1/widgets.ts", CONTROLLER, mulberry32(7), new Set());
    const leaky = [...POOL.slice(0, 5), "API.v1.get('other.route', {}, async () => API.v1.success());"];
    expect(() => variantsOf(c, leaky.concat(leaky, leaky, leaky), [1_500], null, 3)).toThrow(/declares/);
  });

  it("takes only top-level code without imports as padding", () => {
    expect(paddingStatements("import a from 'a';\nexport * from './b';\nconst x = 1;\nfunction f() {}\n", "x.ts")).toEqual(["const x = 1;", "function f() {}"]);
  });

  it("counts a route found whatever router prefix the model writes", () => {
    const route = { method: "GET", template: "/api/v1/zimlo/:id", line: 1, position: 0 };
    expect(found(route, [{ method: "GET", template: "/v1/zimlo/:token" }])).toBe(true);
    expect(found(route, [{ method: null, template: "zimlo/:x" }])).toBe(true);
    expect(found(route, [{ method: "POST", template: "/api/v1/zimlo/:id" }])).toBe(false);
    expect(found(route, [{ method: "GET", template: "/api/v1/zimlo" }])).toBe(false);
  });
});

describe("hypothesis 3 run", () => {
  it("asks only about the chosen variants: some length levels, without the position series", async () => {
    const dir = tempDir();
    const route = { method: "GET", template: "/api/v1/a.b", line: 1, position: 0.5 };
    const variant = (id: string, series: "length" | "position", level: string) => ({ id, controller: "c01", series, level, path: "x.ts", chars: 10, routes: [route], file: `variants/${id}.ts` });
    const variants = [variant("c01-L0", "length", "0"), variant("c01-L1", "length", "1"), variant("c01-L3", "length", "3"), variant("c01-P-start", "position", "start")];
    mkdirSync(join(dir, "variants"), { recursive: true });
    for (const v of variants) writeFileSync(join(dir, v.file), `API.v1.get('a.b', {}, () => {}); // ${v.id}`);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ target: "t", seed: 1, createdAt: "", levels: [], positionChars: 0, controllers: [], variants }));
    const asked: string[] = [];
    const provider: LlmProvider = {
      id: "ollama",
      model: "m",
      async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
        asked.push(req.user.slice(-12));
        const parsed = { routes: [{ kind: "http", method: "GET", name: "/api/v1/a.b", line: 1 }] } as T;
        return { parsed, raw: "", stopReason: "end_turn", modelRequested: "m", modelActual: "m", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, latencyMs: 1, costUsd: 0, cached: false, batchId: null };
      },
    };
    const config = loadConfig(join(toolRoot, "configs", "rocketchat.yaml")).config;
    const rows = await runH3(dir, config, new LlmClient(openDb(":memory:"), provider, { budgetUsd: 1 }), provider, { levels: ["0", "3"], position: false });
    expect(rows.map((r) => r.variant)).toEqual(["c01-L0", "c01-L3"]);
    expect(asked).toHaveLength(2);
    expect(rows.every((r) => r.found === 1)).toBe(true);
  });
});
