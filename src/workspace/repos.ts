import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RepoConfig } from "../config/schema.js";
import { type DataLayout, repoDirName } from "../core/paths.js";

/** Snapshot id stored for repositories read from a local directory. */
export const LOCAL_SHA = "local";

export interface RepoLocation {
  repo: RepoConfig;
  /** Directory holding the repository's files. */
  dir: string;
  /** Pinned commit, or `LOCAL_SHA` for a local directory. */
  sha: string;
  /** Whether the files are present. */
  present: boolean;
}

export class NotPinnedError extends Error {}

/** Raised when the held-out repository is requested before the method is frozen. */
export class HeldoutLockedError extends Error {}

export function locateRepo(repo: RepoConfig, layout: DataLayout, configPath: string): RepoLocation {
  if (repo.path !== undefined) {
    const dir = resolve(dirname(configPath), repo.path);
    return { repo, dir, sha: LOCAL_SHA, present: existsSync(dir) };
  }
  if (repo.sha === undefined) {
    throw new NotPinnedError(`repo '${repo.id}' has no pinned commit; run 'archmap pin' first`);
  }
  const dir = join(layout.repos, repoDirName(repo.id, repo.sha));
  return { repo, dir, sha: repo.sha, present: existsSync(join(dir, ".git")) };
}

/** Selects repos by id, keeping config order; an unknown id is an error. */
export function selectRepos(repos: RepoConfig[], ids: string[] | undefined): RepoConfig[] {
  if (ids === undefined || ids.length === 0) return repos;
  const known = new Set(repos.map((r) => r.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new Error(`unknown repo id(s): ${unknown.join(", ")}`);
  return repos.filter((r) => ids.includes(r.id));
}
