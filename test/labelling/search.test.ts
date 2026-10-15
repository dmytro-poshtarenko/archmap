import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { candidatesInText, findCandidates, storeCandidates } from "../../src/labelling/candidates.js";
import { compilePacks, PackError } from "../../src/labelling/patterns.js";
import { openCandidates } from "../../src/labelling/store.js";
import { dataLayout } from "../../src/core/paths.js";
import { tempDir, writeTree } from "../helpers.js";
import { fakeSnapshot } from "./fixtures.js";

const SERVICES = "export const Presence = proxify<IPresence>('presence');\nexport const Team = proxify<ITeamService>('team');\n";
const MODELS = "export const Users = proxify<IUsersModel>('IUsersModel');\n";
const lists = (repo: string, path: string) => {
  if (repo === "main" && path === "packages/core-services/src/index.ts") return SERVICES;
  if (repo === "main" && path === "packages/models/src/index.ts") return MODELS;
  throw new Error(`unexpected ${repo}:${path}`);
};

describe("pattern packs", () => {
  it("compiles the packs shipped with the tool and expands lists", () => {
    const packs = compilePacks(["generic@1", "rocketchat@1"], lists);
    const proxy = packs.patterns.find((p) => p.id === "rocketchat.service-proxy");
    expect(proxy?.regex.test("await Presence.setStatus(uid, status);")).toBe(true);
    expect(proxy?.regex.test("await myPresence.setStatus(uid);")).toBe(false);
    expect(packs.patterns.find((p) => p.id === "rocketchat.model-call")?.regex.test("Users.findOneById(uid)")).toBe(true);
    expect(packs.gapImports.length).toBeGreaterThan(0);
  });

  it("changes its hash when a list changes", () => {
    const a = compilePacks(["rocketchat@1"], lists).hash;
    const b = compilePacks(["rocketchat@1"], (r, p) =>
      p.endsWith("core-services/src/index.ts") ? `${SERVICES}export const Room = proxify<IRoomService>('room');\n` : lists(r, p),
    ).hash;
    expect(a).not.toBe(b);
  });

  it("rejects broken packs", () => {
    const root = tempDir();
    writeTree(root, {
      "labelling/patterns/bad@1.yaml": "id: bad\nversion: 1\ndescription: x\npatterns:\n  - { id: a, type: http, regex: 'x{{missing}}' }\n",
      "labelling/patterns/dup@1.yaml": "id: dup\nversion: 1\ndescription: x\npatterns:\n  - { id: a, type: http, regex: 'x' }\n  - { id: a, type: db, regex: 'y' }\n",
      "labelling/patterns/wrong@1.yaml": "id: other\nversion: 1\ndescription: x\npatterns: []\n",
    });
    expect(() => compilePacks(["bad@1"], lists, root)).toThrow(/unknown list/);
    expect(() => compilePacks(["dup@1"], lists, root)).toThrow(/duplicate pattern id/);
    expect(() => compilePacks(["wrong@1"], lists, root)).toThrow(PackError);
    expect(() => compilePacks(["absent@1"], lists, root)).toThrow(/not found/);
  });

  it("drops REST path literals that are keys of type maps", () => {
    const rest = compilePacks(["rocketchat@1"], lists).patterns.find((p) => p.id === "rocketchat.rest-path");
    expect(rest?.regex.test("\t'/v1/rooms.info': {")).toBe(false);
    expect(rest?.regex.test("const info = useEndpoint('GET', '/v1/rooms.info');")).toBe(true);
    expect(rest?.regex.test("  info: `${serverUrl}api/info` as const,")).toBe(true);
  });
});

describe("candidates", () => {
  const packs = () => compilePacks(["generic@1", "rocketchat@1"], lists);

  it("reports one candidate per line with every matching pattern", () => {
    const text = [
      "import { useEndpoint } from '@rocket.chat/ui-contexts';",
      "const getInfo = useEndpoint('GET', '/v1/rooms.info');",
      "const user = await Users.findOneById(uid);",
      "await fetch(",
      "  url,",
      ");",
    ].join("\n");
    const found = candidatesInText({ repo: "main", path: "a.ts", lang: "ts", split: "dev", component: "web-client" }, text, packs().patterns);
    expect(found.map((c) => [c.line, c.stratum, c.patterns])).toEqual([
      [2, "http", ["rocketchat.use-endpoint", "rocketchat.rest-path"]],
      [3, "db", ["rocketchat.model-call"]],
      [4, "http", ["generic.fetch"]],
    ]);
    expect(found[0]).toMatchObject({ id: "main:a.ts:2", component: "web-client", split: "dev" });
  });

  it("searches only code files and is deterministic", () => {
    const snapshot = fakeSnapshot({
      "main:b.ts": { text: "api.broadcast('user.nameChanged', user);\n", split: "test" },
      "main:a.tsx": { text: "useStream('notify-room');\n" },
      "main:README.md": { text: "fetch('/api/v1/x')\n" },
      "main:compose.yml": { text: "fetch(\n", lang: "yaml" },
    });
    const first = findCandidates(snapshot, packs());
    expect(first.map((c) => `${c.id}:${c.stratum}:${c.split}`)).toEqual(["main:a.tsx:1:ddp:dev", "main:b.ts:1:broker:test"]);
    expect(findCandidates(snapshot, packs())).toEqual(first);
  });

  it("refuses to replace candidates a sample was drawn from", () => {
    const layout = dataLayout(join(tempDir(), "data"));
    const db = openCandidates(layout, "t");
    const snapshot = fakeSnapshot({ "main:a.ts": { text: "fetch(x)\n" } });
    const found = findCandidates(snapshot, packs());
    expect(storeCandidates(db, found, { packsHash: "p", inventoryHash: "i" }).changed).toBe(true);
    expect(storeCandidates(db, found, { packsHash: "p", inventoryHash: "i" }).changed).toBe(false);
    db.prepare("INSERT INTO sample(candidate, pool, rank, double) VALUES (?, 'main', 1, 0)").run(found[0]?.id);
    expect(() => storeCandidates(db, [], { packsHash: "p", inventoryHash: "i" })).toThrow(/sample has already been drawn/);
  });
});
