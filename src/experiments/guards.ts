import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { git, GitError, isClean } from "../workspace/git.js";

/**
 * The part of `freeze/manifest.json` the guards rely on. `archmap freeze`
 * (milestone M10) writes the full manifest; extra fields are kept as is.
 */
export const FreezeManifest = z.looseObject({
  tag: z.string(),
  /** Commit holding the frozen method; the manifest itself is committed on top of it. */
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  configHash: z.string(),
  createdAt: z.string(),
});
export type FreezeManifest = z.infer<typeof FreezeManifest>;

export type FrozenCheck = { ok: true; manifest: FreezeManifest } | { ok: false; reason: string };

/** Paths that may change after the frozen commit: the manifest itself and the evaluation log. */
const COMMITTED_AFTER_FREEZE = ["freeze", "audit"];
const UNCOMMITTED_AFTER_FREEZE = ["audit"];

/**
 * The method counts as frozen only when the manifest exists, the effective
 * config is the frozen one, the freeze tag is in the history of HEAD, and
 * nothing but the manifest and the evaluation log changed since the frozen
 * commit, committed or not. Test-split evaluation and the held-out
 * repository are gated on this.
 */
export function checkFrozen(opts: { root: string; configHash: string }): FrozenCheck {
  const file = join(opts.root, "freeze", "manifest.json");
  if (!existsSync(file)) return { ok: false, reason: "the method is not frozen (no freeze/manifest.json)" };
  const parsed = FreezeManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) return { ok: false, reason: `freeze/manifest.json is invalid: ${z.prettifyError(parsed.error)}` };
  const manifest = parsed.data;
  if (manifest.configHash !== opts.configHash) return { ok: false, reason: "the config differs from the frozen one" };
  try {
    const tagged = git(["rev-parse", "--verify", "--quiet", `refs/tags/${manifest.tag}^{commit}`], opts.root).trim();
    if (!isAncestor(opts.root, manifest.commit, tagged) || !isAncestor(opts.root, tagged, "HEAD")) {
      return { ok: false, reason: `tag '${manifest.tag}' is not between the frozen commit and HEAD` };
    }
    const changed = git(["diff", "--name-only", manifest.commit, "HEAD"], opts.root).split("\n").filter(Boolean);
    const outside = changed.filter((p) => !COMMITTED_AFTER_FREEZE.some((d) => p.startsWith(`${d}/`)));
    if (outside.length > 0) return { ok: false, reason: `changed since the freeze: ${outside.slice(0, 5).join(", ")}` };
    if (!isClean(opts.root, UNCOMMITTED_AFTER_FREEZE)) return { ok: false, reason: "the working tree has uncommitted changes" };
  } catch (error) {
    if (error instanceof GitError) return { ok: false, reason: `cannot verify the freeze: ${error.message}` };
    throw error;
  }
  return { ok: true, manifest };
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant], root);
    return true;
  } catch (error) {
    if (error instanceof GitError) return false;
    throw error;
  }
}
