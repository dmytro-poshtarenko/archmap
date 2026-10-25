import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../core/hash.js";
import { toolRoot } from "../core/paths.js";

export const GUIDE_PATH = join(toolRoot, "docs", "labelling-guide.md");

/** `<version>+<content hash>` of the labelling guide, recorded with every label and in the freeze manifest. */
export function guideVersion(path = GUIDE_PATH): string {
  const text = readFileSync(path, "utf8");
  const version = /^Версія:\s*(\S+)/m.exec(text)?.[1] ?? "0";
  return `${version}+${sha256Hex(text).slice(0, 8)}`;
}
