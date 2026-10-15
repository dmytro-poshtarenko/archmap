import { join } from "node:path";
import { type LoadedConfig, loadConfig } from "../config/load.js";
import { type DataLayout, dataLayout, resolveDataDir, toolRoot } from "../core/paths.js";
import { checkFrozen } from "../experiments/guards.js";
import { type Db, openDb } from "../store/db.js";

export const DEFAULT_CONFIG = join(toolRoot, "configs", "rocketchat.yaml");

export interface GlobalOptions {
  config: string;
  data?: string;
}

export interface CliContext {
  loaded: LoadedConfig;
  layout: DataLayout;
  /** Database of this target: `data/db/<config name>.sqlite`. */
  dbPath: string;
  openDb(): Db;
  /** Whether the method is frozen, which unlocks the held-out repository and the test split. */
  frozen(): boolean;
  /** Progress and warnings go to stderr; results go to stdout. */
  log(message: string): void;
}

export function createContext(opts: GlobalOptions): CliContext {
  const loaded = loadConfig(opts.config);
  const layout = dataLayout(resolveDataDir(opts.data));
  const dbPath = join(layout.db, `${loaded.config.name}.sqlite`);
  let frozen: boolean | undefined;
  const log = (message: string) => process.stderr.write(`${message}\n`);
  return {
    loaded,
    layout,
    dbPath,
    openDb: () => openDb(dbPath),
    frozen() {
      if (frozen === undefined) {
        const check = checkFrozen({ root: toolRoot, configHash: loaded.hash });
        frozen = check.ok;
        if (!check.ok) log(`not frozen: ${check.reason}`);
      }
      return frozen;
    },
    log,
  };
}
