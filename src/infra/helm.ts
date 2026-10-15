import { spawnSync } from "node:child_process";

export type HelmRenderer = (chartDir: string, valueFiles: string[], release: string) => { manifests: string } | { error: string };

/** `helm template`, the chart rendered with its values, without a cluster. */
export const helmTemplate: HelmRenderer = (chartDir, valueFiles, release) => {
  const args = ["template", release, chartDir, ...valueFiles.flatMap((f) => ["-f", f])];
  const r = spawnSync("helm", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) {
    const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
    return { error: missing ? "helm is not installed (brew install helm)" : r.error.message };
  }
  if (r.status !== 0) return { error: `helm template failed: ${r.stderr.trim().split("\n").slice(-3).join(" ")}` };
  return { manifests: r.stdout };
};
