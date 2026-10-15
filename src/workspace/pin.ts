import type { LockFile, TargetConfig } from "../config/schema.js";
import { lsRemote } from "./git.js";

export interface PinResult {
  lock: LockFile;
  pinned: Array<{ id: string; ref: string; sha: string }>;
  kept: string[];
}

/**
 * Resolves every remote repository to a commit with `git ls-remote`, which
 * reads refs only, so pinning the held-out repository reveals none of its code.
 * Existing pins are kept unless `refresh` is set; a sha written in the config
 * itself always wins.
 */
export function pinRepos(
  config: TargetConfig,
  previous: LockFile | undefined,
  opts: { ids?: string[]; fixed?: string[]; refresh?: boolean; now?: () => Date } = {},
): PinResult {
  const repos: Record<string, string> = { ...previous?.repos };
  const pinned: PinResult["pinned"] = [];
  const kept: string[] = [];
  for (const repo of config.repos) {
    if (repo.url === undefined) continue;
    if (opts.ids !== undefined && opts.ids.length > 0 && !opts.ids.includes(repo.id)) continue;
    if (opts.fixed?.includes(repo.id) || (repos[repo.id] !== undefined && !opts.refresh)) {
      kept.push(repo.id);
      continue;
    }
    const ref = repo.branch ?? "HEAD";
    const sha = lsRemote(repo.url, ref);
    repos[repo.id] = sha;
    pinned.push({ id: repo.id, ref, sha });
  }
  const sorted = Object.fromEntries(Object.entries(repos).sort(([a], [b]) => a.localeCompare(b)));
  return { lock: { pinnedAt: (opts.now?.() ?? new Date()).toISOString(), repos: sorted }, pinned, kept };
}
