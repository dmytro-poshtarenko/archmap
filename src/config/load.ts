import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { hashOf } from "../core/hash.js";
import { LockFile, TargetConfig } from "./schema.js";

export interface LoadedConfig {
  /** Absolute path of the YAML file. */
  path: string;
  /** Effective config: YAML merged with the lock file. */
  config: TargetConfig;
  lock: LockFile | undefined;
  /** Repos whose commit is written in the YAML itself; `archmap pin` never changes them. */
  fixedShas: string[];
  /** Hash of the effective config; part of every run and of the freeze manifest. */
  hash: string;
}

export class ConfigError extends Error {}

export function lockPathFor(configPath: string): string {
  return resolve(dirname(configPath), `${basename(configPath, ".yaml")}.lock.json`);
}

export function parseConfig(raw: unknown, source = "config"): TargetConfig {
  const result = TargetConfig.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`${source} is invalid:\n${z.prettifyError(result.error)}`);
  }
  const ids = new Set<string>();
  for (const repo of result.data.repos) {
    if (ids.has(repo.id)) throw new ConfigError(`${source}: duplicate repo id '${repo.id}'`);
    ids.add(repo.id);
  }
  return result.data;
}

export function loadConfig(file: string): LoadedConfig {
  const path = resolve(file);
  if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);
  const config = parseConfig(parseYaml(readFileSync(path, "utf8")), path);
  const fixedShas = config.repos.filter((r) => r.sha !== undefined).map((r) => r.id);

  const lockPath = lockPathFor(path);
  let lock: LockFile | undefined;
  if (existsSync(lockPath)) {
    lock = LockFile.parse(JSON.parse(readFileSync(lockPath, "utf8")));
    for (const repo of config.repos) {
      const pinned = lock.repos[repo.id];
      if (repo.sha && pinned && repo.sha !== pinned) {
        throw new ConfigError(`repo '${repo.id}': sha in config differs from ${lockPath}`);
      }
      repo.sha ??= pinned;
    }
  }
  return { path, config, lock, fixedShas, hash: hashOf(config) };
}

export function writeLock(configPath: string, lock: LockFile): string {
  const lockPath = lockPathFor(configPath);
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return lockPath;
}
