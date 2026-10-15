import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { InteractionType, RepoGlob, splitRepoGlob } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import { toolRoot } from "../core/paths.js";

/**
 * A pattern pack is the versioned text search that proposes candidate call
 * sites for the reference labelling. It is deliberately independent of the
 * extraction rules: plain regular expressions over source lines, so the
 * reference does not inherit the method's blind spots.
 */
const PackFile = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  description: z.string(),
  /** Languages (inventory `lang`) searched by default. */
  langs: z.array(z.string()).default(["ts", "tsx", "js", "jsx"]),
  /**
   * Named alternations built from declaration files of the target, e.g. every
   * model proxy exported by a package; patterns use them as `{{name}}`.
   */
  lists: z.record(z.string(), z.strictObject({ file: RepoGlob, regex: z.string() })).default({}),
  patterns: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
      type: InteractionType,
      regex: z.string(),
      note: z.string().optional(),
    }),
  ),
  /** Whole-file patterns marking files that use an HTTP or queue client (gap check). */
  gapImports: z.array(z.string()).default([]),
});
export type PackFile = z.infer<typeof PackFile>;

export interface CompiledPattern {
  id: string;
  type: InteractionType;
  regex: RegExp;
  langs: Set<string>;
}

export interface CompiledPacks {
  refs: string[];
  /** Hash of the pack files and resolved lists; changes whenever the search changes. */
  hash: string;
  patterns: CompiledPattern[];
  gapImports: RegExp[];
}

export class PackError extends Error {}

export function packPath(ref: string, root = toolRoot): string {
  return join(root, "labelling", "patterns", `${ref}.yaml`);
}

export function loadPack(ref: string, root = toolRoot): PackFile {
  const file = packPath(ref, root);
  if (!existsSync(file)) throw new PackError(`pattern pack ${ref} not found at ${file}`);
  const parsed = PackFile.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!parsed.success) throw new PackError(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  const pack = parsed.data;
  if (`${pack.id}@${pack.version}` !== ref) throw new PackError(`${file} declares ${pack.id}@${pack.version}, expected ${ref}`);
  return pack;
}

/**
 * Compiles packs in order. `readRepoFile(repo, path)` returns a file of the
 * pinned snapshot, used to resolve lists; the resolved names are part of the
 * hash, so the same packs on another snapshot are a different search.
 */
export function compilePacks(
  refs: string[],
  readRepoFile: (repo: string, path: string) => string,
  root = toolRoot,
): CompiledPacks {
  const patterns: CompiledPattern[] = [];
  const gapImports: RegExp[] = [];
  const material: unknown[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const pack = loadPack(ref, root);
    const lists = resolveLists(pack, readRepoFile);
    material.push({ pack, lists });
    for (const p of pack.patterns) {
      const id = `${pack.id}.${p.id}`;
      if (seen.has(id)) throw new PackError(`duplicate pattern id ${id}`);
      seen.add(id);
      patterns.push({ id, type: p.type, regex: compile(expand(p.regex, lists, id), id), langs: new Set(pack.langs) });
    }
    for (const g of pack.gapImports) gapImports.push(compile(g, `${pack.id} gap import`));
  }
  return { refs, hash: hashOf(material), patterns, gapImports };
}

function resolveLists(pack: PackFile, readRepoFile: (repo: string, path: string) => string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(pack.lists)) {
    const { repo, glob: path } = splitRepoGlob(spec.file);
    const re = compile(spec.regex, `list ${name}`);
    const names = new Set<string>();
    for (const line of readRepoFile(repo, path).split("\n")) {
      const m = re.exec(line);
      if (m?.[1]) names.add(m[1]);
    }
    if (names.size === 0) throw new PackError(`list ${name} of ${pack.id}@${pack.version} is empty`);
    out[name] = [...names].sort();
  }
  return out;
}

function expand(regex: string, lists: Record<string, string[]>, id: string): string {
  return regex.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const names = lists[name];
    if (names === undefined) throw new PackError(`pattern ${id} uses unknown list {{${name}}}`);
    return `(?:${names.map(escapeRegex).join("|")})`;
  });
}

function compile(source: string, what: string): RegExp {
  try {
    return new RegExp(source);
  } catch (error) {
    throw new PackError(`${what}: invalid regular expression: ${(error as Error).message}`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
