import { spawnSync } from "node:child_process";

export class GitError extends Error {}

/** Runs git without a terminal prompt and returns stdout; throws `GitError` on a non-zero exit. */
export function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new GitError(`git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Bare `github.com/owner/name` becomes an https URL; anything with a scheme, an scp-style user or a path is kept. */
export function remoteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/@\s]+@[^:\s]+:/.test(url) || /^[./~]/.test(url)) return url;
  return `https://${url}`;
}

/**
 * Resolves a branch or tag (or `HEAD`, the default branch) on the remote to a
 * commit without fetching anything. Annotated tags resolve to their commit.
 */
export function lsRemote(url: string, ref = "HEAD"): string {
  const candidates = ref === "HEAD" ? ["HEAD"] : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  const out = git(["ls-remote", remoteUrl(url), ...candidates]);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name) refs.set(name, sha);
  }
  for (const name of candidates) {
    const sha = refs.get(name);
    if (sha) return sha;
  }
  throw new GitError(`ref '${ref}' not found on ${url}`);
}

export function headCommit(dir: string): string {
  return git(["rev-parse", "HEAD"], dir).trim();
}

export function isClean(dir: string, excludes: string[] = []): boolean {
  const pathspec = excludes.length > 0 ? ["--", ".", ...excludes.map((e) => `:(exclude)${e}`)] : [];
  return git(["status", "--porcelain", ...pathspec], dir).trim() === "";
}

/** Tracked files plus untracked files that are not ignored. */
export function listWorkingFiles(dir: string): string[] {
  return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir)
    .split("\0")
    .filter((p) => p !== "")
    .sort();
}
