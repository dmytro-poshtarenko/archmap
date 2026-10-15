import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the tool repository (works from both `src/` and `dist/`). */
export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The experiment data workspace lives outside the tool's git repository:
 * by default `magister-diplom/data`, next to `magister-diplom/tool`.
 */
export function resolveDataDir(explicit?: string): string {
  return resolve(explicit ?? process.env.ARCHMAP_DATA ?? join(toolRoot, "..", "data"));
}

export interface DataLayout {
  root: string;
  repos: string;
  db: string;
  fingerprints: string;
}

export function dataLayout(dataDir: string): DataLayout {
  return {
    root: dataDir,
    repos: join(dataDir, "repos"),
    db: join(dataDir, "db"),
    fingerprints: join(dataDir, "fingerprints"),
  };
}

export function repoDirName(repoId: string, sha: string): string {
  return `${repoId}@${sha}`;
}
