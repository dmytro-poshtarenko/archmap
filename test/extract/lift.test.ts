import { describe, expect, it } from "vitest";
import { display, hopKinds } from "../../src/extract/value.js";
import { programFrom, sitesOf } from "./helpers.js";

function summary(files: Record<string, string>, liftDepth = 3) {
  const program = programFrom(files);
  return sitesOf(program, liftDepth)
    .map((s) => {
      const sf = s.at.getSourceFile();
      const line = sf.getLineAndCharacterOfPosition(s.at.getStart(sf)).line + 1;
      return `${program.idOf(s.at)}:${line} ${s.method ? display(s.method) : "-"} ${display(s.address)} [${hopKinds(s.address).join(",")}]${s.liftedFrom ? " lifted" : ""}`;
    })
    .sort();
}

const HTTP = [
  "export function request(path: string, init?: { method?: string }) {",
  "  return fetch(`/api${path}`, init);",
  "}",
  "export const get = (path: string) => request(path);",
  "export const post = (path: string) => request(path, { method: 'POST' });",
].join("\n");

describe("lifting", () => {
  it("lifts through wrappers of wrappers to the call that fixes the address", () => {
    expect(
      summary({
        "r:http.ts": HTTP,
        "r:orders.ts": "import { get, post } from './http.js';\nexport const list = () => get('/orders');\nexport const create = () => post('/orders');",
      }),
    ).toEqual([
      "r:orders.ts:2 GET /api/orders [import,wrapper] lifted",
      "r:orders.ts:3 POST /api/orders [import,wrapper] lifted",
    ]);
  });

  it("stops at the configured depth", () => {
    const files = {
      "r:http.ts": HTTP,
      "r:orders.ts": "import { get } from './http.js';\nexport const list = () => get('/orders');",
    };
    expect(summary(files, 1)).toEqual([
      "r:http.ts:4 GET /api{param:path} [wrapper] lifted",
      "r:http.ts:5 POST /api{param:path} [wrapper] lifted",
    ]);
    expect(summary(files, 0)).toEqual(["r:http.ts:2 {param:init.method} /api{param:path} []"]);
  });

  it("keeps an id in a path segment where it is, but lifts a path passed into one", () => {
    expect(
      summary({
        "r:orders.ts": [
          "export function getOrder(id: string) { return fetch(`/api/orders/${id}`); }",
          "export function call(endpoint: string) { return fetch(`/api/${endpoint}`); }",
          "getOrder(order.id);",
          "call('v1/me');",
          "declare const order: { id: string };",
        ].join("\n"),
      }),
    ).toEqual(["r:orders.ts:1 GET /api/orders/{param:id} []", "r:orders.ts:4 GET /api/v1/me [wrapper] lifted"]);
  });

  it("finds callers through namespace imports and re-exports, and ignores query parameters", () => {
    expect(
      summary({
        "r:lib/http.ts": "export function search(q: string) { return fetch(`/api/search?q=${q}`); }\nexport function at(p: string) { return fetch(p); }",
        "r:lib/index.ts": "export { at } from './http.js';",
        "r:main.ts": "import * as lib from './lib/index.js';\nimport { at } from './lib/index.js';\nat('/health');",
      }),
    ).toEqual(["r:lib/http.ts:1 GET /api/search?q={param:q} []", "r:main.ts:3 GET /health [import,reexport,wrapper] lifted"]);
  });

  it("does not loop on recursive wrappers", () => {
    expect(
      summary({
        "r:a.ts": "export function retry(path: string, n: number): unknown { return n > 0 ? retry(path, n - 1) : fetch(path); }\nretry('/x', 3);",
      }),
    ).toEqual(["r:a.ts:2 GET /x [wrapper] lifted"]);
  });
});
