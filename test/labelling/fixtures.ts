import type { Snapshot, SourceFile } from "../../src/labelling/snapshot.js";
import type { Split } from "../../src/labelling/store.js";

export interface FakeFile {
  text: string;
  split?: Split;
  lang?: string | null;
  component?: string | null;
}

/** An in-memory snapshot: `files` maps '<repo>:<path>' to its text and inventory fields. */
export function fakeSnapshot(files: Record<string, FakeFile>): Snapshot {
  const list: Array<SourceFile & { text: string }> = Object.entries(files)
    .map(([key, f]) => {
      const at = key.indexOf(":");
      const path = key.slice(at + 1);
      return {
        repo: key.slice(0, at),
        path,
        lang: f.lang === undefined ? (/\.(tsx?|jsx?)$/.exec(path)?.[1] ?? null) : f.lang,
        split: f.split ?? "dev",
        component: f.component ?? null,
        text: f.text,
      };
    })
    .sort((a, b) => (`${a.repo}:${a.path}` < `${b.repo}:${b.path}` ? -1 : 1));
  const index = new Map(list.map((f) => [`${f.repo}:${f.path}`, f]));
  return {
    files: list.map(({ text: _text, ...f }) => f),
    inventoryHash: "fake",
    has: (repo, path) => index.has(`${repo}:${path}`),
    file: (repo, path) => {
      const f = index.get(`${repo}:${path}`);
      if (!f) return undefined;
      const { text: _text, ...rest } = f;
      return rest;
    },
    read(repo, path) {
      const f = index.get(`${repo}:${path}`);
      if (!f) throw new Error(`${repo}:${path} is not in the inventory`);
      return f.text;
    },
  };
}
