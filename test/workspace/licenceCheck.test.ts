import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataLayout } from "../../src/core/paths.js";
import { fingerprintText, licenceCheck, WINDOW } from "../../src/workspace/licenceCheck.js";
import { gitRepo, makeConfig, tempDir, writeTree } from "../helpers.js";

const SECRET = Array.from(
  { length: 20 },
  (_, i) => `  const enterpriseValue${i} = computeLicensedFeature(${i}, "seat-${i * 7}");`,
).join("\n");
const OPEN = Array.from({ length: 20 }, (_, i) => `export function openHelper${i}(input: string) { return input + "${i}"; }`).join(
  "\n",
);

function setup() {
  const root = tempDir();
  writeTree(root, {
    "up/ee/secret.ts": `${SECRET}\n`,
    "up/lib/open.ts": `${OPEN}\n`,
  });
  const config = makeConfig({
    repos: [{ id: "up", path: "up", role: "main", licence: "MIT", publishable: true }],
    licenceZones: [{ repo: "up", globs: ["ee/**"], licence: "EE", publishable: false }],
  });
  return { root, config, layout: dataLayout(join(root, "data")), configPath: join(root, "c.yaml") };
}

describe("fingerprints", () => {
  it("ignores indentation and trivial lines", () => {
    const a = fingerprintText(SECRET);
    const b = fingerprintText(SECRET.split("\n").map((l) => `\t\t${l.trim()}\n}\n`).join(""));
    expect(a.length).toBe(20 - WINDOW + 1);
    expect(b.map((w) => w.fp)).toEqual(a.map((w) => w.fp));
    expect(fingerprintText("}\n});\n\n// x\n")).toEqual([]);
  });
});

describe("licence-check", () => {
  it("finds a planted protected fragment and nothing else", () => {
    const env = setup();
    const planted = SECRET.split("\n").slice(4, 13).map((l) => `    ${l.trim()}`).join("\n");
    const scan = join(env.root, "tool");
    gitRepo(scan, {
      ".gitignore": "ignored.ts\n",
      "src/clean.ts": "export const ok = true;\n",
      "fixtures/copied.ts": `// fixture\n${planted}\n`,
      "fixtures/open-copy.ts": `${OPEN}\n`,
    });
    writeTree(scan, { "draft.ts": `${planted}\n`, "ignored.ts": `${planted}\n` });

    const result = licenceCheck(env.config, env.layout, env.configPath, { scanRoot: scan, allowHeldout: false });
    expect(result.protectedRepos).toEqual([{ id: "up", files: 1, fingerprints: 20 - WINDOW + 1, cached: false }]);
    expect(result.findings.map((f) => f.file).sort()).toEqual(["draft.ts", "fixtures/copied.ts"]);
    const copied = result.findings.find((f) => f.file === "fixtures/copied.ts");
    expect(copied).toMatchObject({ startLine: 2, endLine: 10, source: "up:ee/secret.ts:5" });
    expect(existsSync(env.layout.fingerprints)).toBe(false);
  });

  it("scans plain directories too", () => {
    const env = setup();
    const scan = join(env.root, "export");
    writeTree(scan, { "out/table.csv": "repo,path,line\nup,ee/secret.ts,4\n", "out/leak.ts": SECRET });
    const result = licenceCheck(env.config, env.layout, env.configPath, { scanRoot: scan, allowHeldout: false });
    expect(result.findings.map((f) => f.file)).toEqual(["out/leak.ts"]);
  });

  it("reports protected repositories it cannot read", () => {
    const env = setup();
    const config = makeConfig({
      repos: [{ id: "far", url: "github.com/example/far", sha: "a".repeat(40), role: "infra", publishable: false }],
    });
    const result = licenceCheck(config, env.layout, env.configPath, { scanRoot: env.root, allowHeldout: false });
    expect(result.unavailable).toEqual(["far"]);
  });
});
