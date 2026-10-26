import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the tool repository (works from both `src/` and `dist/`). */
export const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The config file `archmap init` writes and every command looks for. */
export const CONFIG_FILE = "archmap.yaml";

/** The data folder next to a project's config. */
export const PROJECT_DATA = ".archmap";

/** Whether a path lies inside the tool's own folder (its bundled configs and fixtures). */
function insideTool(path: string): boolean {
  const rel = relative(toolRoot, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/**
 * The config a command reads, the first that applies:
 * 1. `--config <file>`;
 * 2. `$ARCHMAP_CONFIG`;
 * 3. `archmap.yaml` in the current folder or the nearest folder above it;
 * 4. inside the tool's own folder, the bundled Rocket.Chat config of the measurements.
 */
export function resolveConfigPath(explicit?: string, cwd = process.cwd()): string {
  if (explicit) return resolve(explicit);
  if (process.env.ARCHMAP_CONFIG) return resolve(process.env.ARCHMAP_CONFIG);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return join(dir, CONFIG_FILE);
    if (dirname(dir) === dir) break;
  }
  if (insideTool(cwd)) return join(toolRoot, "configs", "rocketchat.yaml");
  throw new Error(`no ${CONFIG_FILE} in ${resolve(cwd)} or the folders above it; create one with \`archmap init\`, or name one with --config`);
}

/**
 * Where a project's data lives: `--data <dir>`, else `$ARCHMAP_DATA`, else
 * `.archmap` next to the project's config. The tool's own configs (Rocket.Chat
 * and the fixtures) keep the measurement workspace, `../data` next to the tool.
 */
export function resolveDataDir(explicit?: string, configPath?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.ARCHMAP_DATA) return resolve(process.env.ARCHMAP_DATA);
  if (configPath && !insideTool(configPath)) return join(dirname(resolve(configPath)), PROJECT_DATA);
  return resolve(join(toolRoot, "..", "data"));
}

/** Creates a project's data folder with a `.gitignore` of its own, so git never picks it up. */
export function ensureProjectData(dir: string): void {
  if (basename(dir) !== PROJECT_DATA || existsSync(join(dir, ".gitignore"))) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "# archmap's data: the database, checkouts and maps\n*\n");
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
