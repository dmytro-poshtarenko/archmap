import { describe, expect, it } from "vitest";
import { programFrom } from "./helpers.js";

describe("module resolution", () => {
  const program = programFrom({
    "main:packages/models/package.json": JSON.stringify({ name: "@rc/models", main: "./dist/index.js", types: "./dist/index.d.ts" }),
    "main:packages/models/src/index.ts": "export const Users = {};",
    "main:packages/models/src/raw/Users.ts": "export class UsersRaw {}",
    "main:packages/tools/package.json": JSON.stringify({ name: "@rc/tools", exports: { ".": { import: "./lib/esm/index.mjs" } } }),
    "main:packages/tools/src/index.ts": "export const x = 1;",
    "main:apps/server/src/a.ts": "import { b } from './b.js';",
    "main:apps/server/src/b.ts": "export const b = 1;",
    "main:apps/server/src/lib/index.tsx": "export const c = 1;",
    "desktop:src/main.ts": "import { Users } from '@rc/models';",
  });

  it("maps relative imports with JS extensions and index files to sources", () => {
    expect(program.resolveImport("main:apps/server/src/a.ts", "./b.js")).toEqual({ kind: "file", id: "main:apps/server/src/b.ts" });
    expect(program.resolveImport("main:apps/server/src/a.ts", "./lib")).toEqual({ kind: "file", id: "main:apps/server/src/lib/index.tsx" });
    expect(program.resolveImport("main:apps/server/src/a.ts", "./missing")).toEqual({ kind: "external", module: "./missing" });
  });

  it("redirects workspace packages from their unbuilt output to their sources, across repositories", () => {
    expect(program.resolveImport("main:apps/server/src/a.ts", "@rc/models")).toEqual({ kind: "file", id: "main:packages/models/src/index.ts" });
    expect(program.resolveImport("main:apps/server/src/a.ts", "@rc/models/raw/Users")).toEqual({
      kind: "file",
      id: "main:packages/models/src/raw/Users.ts",
    });
    expect(program.resolveImport("main:apps/server/src/a.ts", "@rc/tools")).toEqual({ kind: "file", id: "main:packages/tools/src/index.ts" });
    expect(program.resolveImport("desktop:src/main.ts", "@rc/models")).toEqual({ kind: "file", id: "main:packages/models/src/index.ts" });
    expect(program.resolveImport("main:apps/server/src/a.ts", "express")).toEqual({ kind: "external", module: "express" });
  });
});
