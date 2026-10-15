import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";
import { parseConfig } from "../src/config/load.js";
import type { TargetConfig } from "../src/config/schema.js";
import { git } from "../src/workspace/git.js";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh directory removed after the current test. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "archmap-test-"));
  created.push(dir);
  return dir;
}

export function writeTree(root: string, files: Record<string, string | Uint8Array>): void {
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** Creates a git repository holding `files` in one commit and returns the commit. */
export function gitRepo(dir: string, files: Record<string, string | Uint8Array>): string {
  mkdirSync(dir, { recursive: true });
  git(["init", "--quiet", "--initial-branch", "main"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  return commit(dir, files, "initial");
}

export function commit(dir: string, files: Record<string, string | Uint8Array>, message: string): string {
  writeTree(dir, files);
  git(["add", "--all"], dir);
  git(["commit", "--quiet", "--allow-empty", "-m", message], dir);
  return git(["rev-parse", "HEAD"], dir).trim();
}

/** Minimal valid config; `overrides` replace top-level keys. */
export function makeConfig(overrides: Record<string, unknown> = {}): TargetConfig {
  return parseConfig({
    name: "test",
    repos: [{ id: "main", path: "main", role: "main", licence: "MIT", publishable: true }],
    experiment: {
      seeds: { split: 1, sample: 2, bootstrap: 3 },
      devShare: 0.3,
      sample: { main: 10, minPerType: 1, heldout: 5 },
      secondAnnotator: 0.2,
    },
    ...overrides,
  });
}
