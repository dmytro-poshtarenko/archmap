import { describe, expect, it } from "vitest";
import { display, hopKinds } from "../../src/extract/value.js";
import { evaluatorOf, probe, programFrom } from "./helpers.js";

function evaluate(files: Record<string, string>, at = "r:main.ts", valueSources = []) {
  const program = programFrom(files);
  const value = evaluatorOf(program, valueSources).evaluate(probe(program, at));
  return { text: display(value), hops: hopKinds(value) };
}

describe("evaluator", () => {
  it("reads literals, templates, concatenation and alternatives", () => {
    expect(evaluate({ "r:main.ts": "const probe = '/a' + `/b/${'c'}`;" })).toEqual({ text: "/a/b/c", hops: [] });
    expect(evaluate({ "r:main.ts": "const probe = process.env.API_URL ?? 'http://localhost:3000';" }).text).toBe(
      "{{env:API_URL}|http://localhost:3000}",
    );
    expect(evaluate({ "r:main.ts": "declare const c: boolean; const probe = c ? '/x' : '/y';" }).text).toBe("{/x|/y}");
    expect(evaluate({ "r:main.ts": "const probe = import.meta.env.VITE_API;" }).text).toBe("{env:VITE_API}");
  });

  it("follows constants, objects, enums and imports, recording each hop", () => {
    const files = {
      "r:config.ts": "export const API = { base: '/api', v1: { orders: '/orders' } } as const;\nexport enum Paths { Users = '/users' }",
      "r:index.ts": "export * from './config.js';\nexport { default as root } from './root.js';",
      "r:root.ts": "const ROOT = '/root';\nexport default ROOT;",
      "r:main.ts": "import { API, Paths, root } from './index.js';\nconst probe = `${API.base}${API.v1.orders}${Paths.Users}${root}`;",
    };
    expect(evaluate(files)).toEqual({ text: "/api/orders/users/root", hops: ["const", "import", "reexport"] });
  });

  it("resolves namespace imports and CommonJS exports", () => {
    expect(
      evaluate({
        "r:urls.js": "exports.ORDERS = '/orders';\nmodule.exports.USERS = '/users';",
        "r:main.ts": "import * as urls from './urls.js';\nconst probe = urls.ORDERS + urls.USERS;",
      }).text,
    ).toBe("/orders/users");
  });

  it("inlines small functions with their arguments, defaults and destructured parameters", () => {
    const files = {
      "r:urls.ts": [
        "export const base = (p: string, prefix = '/api') => prefix + p;",
        "export function join({ a, b }: { a: string; b: string }) { return `${a}/${b}`; }",
      ].join("\n"),
      "r:main.ts": "import { base, join } from './urls.js';\nconst probe = base(join({ a: '/x', b: 'y' }));",
    };
    expect(evaluate(files)).toEqual({ text: "/api/x/y", hops: ["import", "wrapper"] });
  });

  it("keeps parameters it cannot bind, and settings and environment values", () => {
    const program = programFrom({
      "r:main.ts": "function f(id: string, opts: { base: string }) { const probe = `${opts.base}/orders/${encodeURIComponent(id)}`; }",
    });
    expect(display(evaluatorOf(program).evaluate(probe(program, "r:main.ts")))).toBe("{param:opts.base}/orders/{param:id}");
    expect(
      evaluate({ "r:main.ts": "declare const settings: any; const probe = `${settings.get('Site_Url')}/api`;" }, "r:main.ts", [
        { callee: "settings.get", kind: "setting", arg: 0 },
      ] as never).text,
    ).toBe("{setting:Site_Url}/api");
    expect(evaluate({ "r:main.ts": "declare const Meteor: any; const probe = Meteor.settings.public.cdn;" }).text).toBe(
      "{setting:public.cdn}",
    );
  });

  it("resolves URLs against their base like the URL constructor", () => {
    expect(evaluate({ "r:main.ts": "const probe = new URL('/api/info', 'https://chat.example.org/app/').href;" }).text).toBe(
      "https://chat.example.org/api/info",
    );
    expect(evaluate({ "r:main.ts": "const probe = new URL('api/info', process.env.SERVER_URL).toString();" }).text).toBe(
      "{env:SERVER_URL}/api/info",
    );
    expect(evaluate({ "r:main.ts": "import path from 'path';\nconst probe = path.join('/api', 'v1', 'me');" }).text).toBe("/api/v1/me");
    expect(evaluate({ "r:main.ts": "const probe = ['', 'api', 'me'].join('/');" }).text).toBe("/api/me");
  });

  it("gives up cleanly on run-time values, reassigned variables and cycles", () => {
    expect(evaluate({ "r:main.ts": "declare function load(): Promise<string>;\nconst url = await load();\nconst probe = url;" })).toEqual({
      text: "{?}",
      hops: [],
    });
    expect(evaluate({ "r:main.ts": "let u = '/a';\nu = '/b';\nconst probe = u;" }).text).toBe("{dyn}");
    expect(evaluate({ "r:main.ts": "let u = '/a';\nconst probe = u;" }).text).toBe("/a");
    expect(evaluate({ "r:main.ts": "const a: string = b;\nconst b: string = a;\nconst probe = a;" }).text).toBe("{?}");
  });
});
