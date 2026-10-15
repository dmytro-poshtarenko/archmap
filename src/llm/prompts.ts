import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolRoot } from "../core/paths.js";
import { hashOf } from "../core/hash.js";

export interface Template {
  id: string;
  version: number;
  system: string;
  user: string;
}

/** Reads `prompts/<id>@<version>.md`: front matter, then `## system` and `## user` sections. */
export function loadTemplate(ref: string, root = toolRoot): Template {
  const text = readFileSync(join(root, "prompts", `${ref}.md`), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n## system\n([\s\S]*?)\n## user\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`prompt ${ref}: expected front matter, '## system' and '## user'`);
  const meta = Object.fromEntries((m[1] ?? "").split("\n").map((l) => l.split(/:\s*/, 2) as [string, string]));
  const t = { id: String(meta.id), version: Number(meta.version), system: (m[2] ?? "").trim(), user: (m[3] ?? "").trim() };
  if (`${t.id}@${t.version}` !== ref) throw new Error(`prompt ${ref} declares ${t.id}@${t.version}`);
  return t;
}

/** Fills `{{name}}` placeholders; every placeholder must be given. */
export function render(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`no value for {{${name}}}`);
    return v;
  });
}

/** Hash of the templates in use, for the freeze manifest. */
export function templatesHash(refs: string[], root = toolRoot): string {
  return hashOf(refs.map((r) => readFileSync(join(root, "prompts", `${r}.md`), "utf8")));
}

export const TEMPLATES = { extract: "extract-routes@1", select: "resolve-select@1", free: "resolve-free@1", probe: "memo-probe@1" } as const;
