import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TargetConfig } from "../config/schema.js";
import type { DataLayout } from "../core/paths.js";
import { git, headCommit, isClean, remoteUrl } from "./git.js";
import { HeldoutLockedError, locateRepo, selectRepos } from "./repos.js";

export type FetchStatus = "fetched" | "present" | "local" | "held-out";

export interface FetchOptions {
  ids?: string[];
  /** True only when the method is frozen (see `checkFrozen`). */
  allowHeldout: boolean;
  log?: (message: string) => void;
}

export class CheckoutError extends Error {}

/**
 * Materialises every remote repository at its pinned commit under
 * `data/repos/<id>@<sha>`: a shallow fetch of exactly that commit, checked out
 * in a temporary directory and renamed into place only when complete.
 *
 * The held-out repository is never fetched before the freeze: it is skipped
 * when fetching everything and refused when asked for by id.
 */
export function fetchRepos(
  config: TargetConfig,
  layout: DataLayout,
  configPath: string,
  opts: FetchOptions,
): Array<{ id: string; status: FetchStatus; dir?: string }> {
  const explicit = opts.ids !== undefined && opts.ids.length > 0;
  const results: Array<{ id: string; status: FetchStatus; dir?: string }> = [];
  for (const repo of selectRepos(config.repos, opts.ids)) {
    if (repo.role === "heldout" && !opts.allowHeldout) {
      if (explicit) throw new HeldoutLockedError(`repo '${repo.id}' is held out until the method is frozen`);
      opts.log?.(`${repo.id}: held out until the method is frozen, skipped`);
      results.push({ id: repo.id, status: "held-out" });
      continue;
    }
    const loc = locateRepo(repo, layout, configPath);
    if (repo.url === undefined) {
      results.push({ id: repo.id, status: "local", dir: loc.dir });
      continue;
    }
    if (loc.present) {
      verifyCheckout(loc.dir, loc.sha);
      opts.log?.(`${repo.id}: present at ${loc.sha.slice(0, 12)}`);
      results.push({ id: repo.id, status: "present", dir: loc.dir });
      continue;
    }
    opts.log?.(`${repo.id}: fetching ${loc.sha.slice(0, 12)} from ${remoteUrl(repo.url)}`);
    const tmp = join(layout.repos, `.tmp-${repo.id}-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      git(["init", "--quiet"], tmp);
      git(["remote", "add", "origin", remoteUrl(repo.url)], tmp);
      git(["fetch", "--quiet", "--depth", "1", "--no-tags", "origin", loc.sha], tmp);
      git(["-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", loc.sha], tmp);
      verifyCheckout(tmp, loc.sha);
      renameSync(tmp, loc.dir);
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
    results.push({ id: repo.id, status: "fetched", dir: loc.dir });
  }
  return results;
}

function verifyCheckout(dir: string, sha: string): void {
  const head = headCommit(dir);
  if (head !== sha) throw new CheckoutError(`${dir} is at ${head}, expected ${sha}`);
  if (!isClean(dir)) throw new CheckoutError(`${dir} has local modifications; restore it with 'git checkout -- .'`);
}
