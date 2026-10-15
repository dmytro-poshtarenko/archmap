import { posix } from "node:path";
import { ts } from "ts-morph";

export interface ProgramFile {
  repo: string;
  path: string;
  lang: string | null;
  component: string | null;
}

export type Resolution = { kind: "file"; id: string } | { kind: "external"; module: string };

const CODE_LANGS = new Set(["ts", "tsx", "js", "jsx"]);
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function fileId(repo: string, path: string): string {
  return `${repo}:${path}`;
}

/**
 * The code of the snapshot as syntax trees, parsed lazily and kept for the
 * run (the whole of Rocket.Chat parses in about a second and fits in under a
 * gigabyte), with module resolution across repositories: relative imports,
 * workspace packages by name (redirected from an unbuilt `dist/` to their
 * sources), and everything else external.
 */
export class Program {
  private readonly files = new Map<string, ProgramFile>();
  private readonly sources = new Map<string, ts.SourceFile>();
  private readonly idOfSource = new WeakMap<ts.SourceFile, string>();
  private readonly packages = new Map<string, { repo: string; dir: string; entries: string[] }>();
  private readonly resolved = new Map<string, Resolution>();

  constructor(
    files: ProgramFile[],
    private readonly read: (repo: string, path: string) => string,
  ) {
    for (const f of files) this.files.set(fileId(f.repo, f.path), f);
    for (const f of files) {
      if (posix.basename(f.path) !== "package.json") continue;
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(read(f.repo, f.path)) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof manifest.name !== "string" || this.packages.has(manifest.name)) continue;
      this.packages.set(manifest.name, { repo: f.repo, dir: posix.dirname(f.path), entries: entryCandidates(manifest) });
    }
  }

  /** Code files in a stable order. */
  codeFiles(): ProgramFile[] {
    return [...this.files.values()].filter((f) => f.lang !== null && CODE_LANGS.has(f.lang));
  }

  file(id: string): ProgramFile | undefined {
    return this.files.get(id);
  }

  text(id: string): string {
    const f = this.files.get(id);
    if (!f) throw new Error(`${id} is not in the inventory`);
    return this.read(f.repo, f.path);
  }

  source(id: string): ts.SourceFile {
    let sf = this.sources.get(id);
    if (!sf) {
      const f = this.files.get(id);
      if (!f) throw new Error(`${id} is not in the inventory`);
      sf = ts.createSourceFile(f.path, this.read(f.repo, f.path), ts.ScriptTarget.Latest, true, scriptKind(f.lang));
      this.sources.set(id, sf);
      this.idOfSource.set(sf, id);
    }
    return sf;
  }

  idOf(node: ts.Node): string {
    const id = this.idOfSource.get(node.getSourceFile());
    if (!id) throw new Error("node of a file outside the program");
    return id;
  }

  /** `<repo>:<path>:<line>` of a node. */
  where(node: ts.Node): string {
    const sf = node.getSourceFile();
    return `${this.idOf(node)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  }

  /**
   * Stable identity of a node within the program. A node and its first child
   * start at the same position (`a + b` and `a`), so the end and the kind are
   * part of it.
   */
  nodeId(node: ts.Node): string {
    return `${this.idOf(node)}#${node.pos}-${node.end}-${node.kind}`;
  }

  resolveImport(fromId: string, specifier: string): Resolution {
    const key = `${fromId}\u0000${specifier}`;
    let r = this.resolved.get(key);
    if (!r) {
      r = this.doResolve(fromId, specifier);
      this.resolved.set(key, r);
    }
    return r;
  }

  private doResolve(fromId: string, specifier: string): Resolution {
    const from = this.files.get(fromId);
    if (!from) return { kind: "external", module: specifier };
    if (specifier.startsWith(".")) {
      const id = this.probe(from.repo, posix.normalize(posix.join(posix.dirname(from.path), specifier)));
      return id ? { kind: "file", id } : { kind: "external", module: specifier };
    }
    const pkg = this.packageOf(specifier);
    if (pkg) {
      const { info, sub } = pkg;
      const tries = sub
        ? [posix.join(info.dir, sub), posix.join(info.dir, "src", sub)]
        : [...info.entries.map((e) => posix.join(info.dir, e)), posix.join(info.dir, "src/index"), posix.join(info.dir, "index")];
      for (const t of tries) {
        const id = this.probe(info.repo, posix.normalize(t));
        if (id) return { kind: "file", id };
      }
    }
    return { kind: "external", module: specifier };
  }

  private packageOf(specifier: string): { info: { repo: string; dir: string; entries: string[] }; sub: string } | undefined {
    const parts = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const info = this.packages.get(parts.slice(0, nameLength).join("/"));
    return info ? { info, sub: parts.slice(nameLength).join("/") } : undefined;
  }

  /** A file of the inventory for an import path: exact, with an extension, or an index file. */
  private probe(repo: string, path: string): string | undefined {
    const stripped = path.replace(/\.(m?js|cjs|jsx)$/, "");
    const candidates = [path, ...EXTENSIONS.map((e) => stripped + e), ...EXTENSIONS.map((e) => `${stripped}/index${e}`)];
    for (const c of candidates) {
      const id = fileId(repo, c);
      const f = this.files.get(id);
      if (f?.lang && CODE_LANGS.has(f.lang)) return id;
    }
    return undefined;
  }
}

/**
 * Entry points of a workspace package, with built output mapped back to its
 * sources (`dist/index.js` → `src/index`), since the snapshot is not built.
 */
function entryCandidates(manifest: Record<string, unknown>): string[] {
  const raw: unknown[] = [];
  const exp = manifest.exports;
  const dot = typeof exp === "object" && exp !== null && "." in exp ? (exp as Record<string, unknown>)["."] : exp;
  if (typeof dot === "string") raw.push(dot);
  else if (typeof dot === "object" && dot !== null) {
    const d = dot as Record<string, unknown>;
    raw.push(d.source, d.types, d.import, d.default, d.require);
  }
  raw.push(manifest.source, manifest.types, manifest.typings, manifest.module, manifest.main);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const clean = entry.replace(/^\.\//, "").replace(/\.d\.ts$/, "").replace(/\.(m?js|cjs|ts|tsx)$/, "");
    out.push(clean, clean.replace(/^(dist|lib|build|esm|cjs)\//, "src/"));
  }
  return [...new Set(out)];
}

function scriptKind(lang: string | null): ts.ScriptKind {
  switch (lang) {
    case "tsx":
      return ts.ScriptKind.TSX;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "js":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}
