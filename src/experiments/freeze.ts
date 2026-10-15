import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "../config/load.js";
import type { DataLayout } from "../core/paths.js";
import { sampleFrame } from "../eval/run.js";
import { ENGINE_VERSION, loadRules } from "../extract/rules.js";
import { caseCounts, openCandidates } from "../labelling/store.js";
import { templatesHash, TEMPLATES } from "../llm/prompts.js";
import { git, isClean } from "../workspace/git.js";

export interface FreezeManifest {
  tag: string;
  /** The commit holding the frozen method; the manifest is committed on top of it. */
  commit: string;
  configHash: string;
  createdAt: string;
  engineVersion: number;
  rulesHash: string;
  promptsHash: string;
  templates: string[];
  models: { cloud: string; local: string };
  chunking: { local: boolean; cloud: boolean; maxTokens: number };
  guide: string;
  /** Hypothesis 1: share of the recoverable links (cases 1–7) each component alone resolves, weighted by strata. */
  predictedShares: { rules: number; infra: number; llm: number; units: number };
  devReport: { path: string; sha256: string };
  h3Decision: { path: string; splitFilesFor: Record<string, boolean> };
}

export interface FreezeInput {
  /** The tool repository. */
  root: string;
  loaded: LoadedConfig;
  layout: DataLayout;
  tag: string;
  annotator: string;
}

const GROUPS = { rules: [1, 2, 3], infra: [4, 7], llm: [5, 6] } as const;

/** What stops a freeze; empty when it may go ahead. */
export function freezeProblems(input: FreezeInput): string[] {
  const { root, loaded, layout } = input;
  const target = loaded.config.name;
  const problems: string[] = [];
  if (existsSync(join(root, "freeze", "manifest.json"))) problems.push("the method is frozen already (freeze/manifest.json exists)");
  if (!isClean(root)) problems.push("the tool repository has uncommitted changes");
  if (!existsSync(join(layout.root, "reports", target, "dev", "summary.json"))) problems.push(`no dev report (${join("reports", target, "dev", "summary.json")}); run the analysis on the dev split first`);
  const decision = join(layout.root, "out", target, "h3", "decision.json");
  if (!existsSync(decision)) problems.push("hypothesis 3 has not decided file splitting (out/<target>/h3/decision.json)");
  else {
    const d = JSON.parse(readFileSync(decision, "utf8")) as { splitFilesFor?: Record<string, boolean> };
    const { chunking, local, cloud } = loaded.config.llm;
    const want = { local: d.splitFilesFor?.[local.model], cloud: d.splitFilesFor?.[cloud.model] };
    for (const [which, value] of Object.entries(want)) {
      if (value !== undefined && chunking[which as "local" | "cloud"] !== value) problems.push(`llm.chunking.${which} is ${chunking[which as "local" | "cloud"]}, but hypothesis 3 decided ${value}`);
    }
  }
  try {
    git(["rev-parse", "--verify", `refs/tags/${input.tag}`], root);
    problems.push(`tag ${input.tag} exists already`);
  } catch {
    // the tag is free
  }
  return problems;
}

/**
 * Hypothesis 1's predicted shares from the test labels: for each component,
 * the share of recoverable links (cases 1–7) of the cases only it resolves,
 * each unit weighted by its stratum's population / sample.
 */
export function predictedShares(input: FreezeInput): FreezeManifest["predictedShares"] {
  const { layout, loaded, annotator } = input;
  const target = loaded.config.name;
  const candidates = openCandidates(layout, target);
  const frame = sampleFrame(candidates);
  candidates.close();
  const population = new Map<string, number>();
  const sampled = new Map<string, number>();
  for (const c of frame.candidates.values()) if (c.split === "test") population.set(c.stratum, (population.get(c.stratum) ?? 0) + 1);
  for (const id of frame.sampled) {
    const c = frame.candidates.get(id);
    if (c?.split === "test") sampled.set(c.stratum, (sampled.get(c.stratum) ?? 0) + 1);
  }
  const weight = (s: string) => (population.get(s) ?? 1) / (sampled.get(s) ?? 1);
  const counts = caseCounts(layout, target, "test", annotator).filter((c) => c.inCStar && c.caseNo !== null && c.caseNo !== 8);
  const total = counts.reduce((sum, c) => sum + weight(c.stratum) * c.n, 0);
  const share = (cases: readonly number[]) => (total === 0 ? 0 : counts.filter((c) => cases.includes(c.caseNo as number)).reduce((sum, c) => sum + weight(c.stratum) * c.n, 0) / total);
  return { rules: share(GROUPS.rules), infra: share(GROUPS.infra), llm: share(GROUPS.llm), units: counts.reduce((s, c) => s + c.n, 0) };
}

/**
 * Freezes the method: the manifest records the commit of the method, the
 * hashes of config, rules and prompts, the models, the chunking decision and
 * hypothesis 1's predicted shares; it is committed on top of the method
 * with an annotated tag. From then on the guards open the test split and the
 * held-out repository, and close again if anything but the manifest and the
 * evaluation log changes.
 */
export function freeze(input: FreezeInput): { manifest: FreezeManifest; digest: string } {
  const problems = freezeProblems(input);
  if (problems.length > 0) throw new Error(`cannot freeze:\n- ${problems.join("\n- ")}`);
  const { root, loaded, layout, tag } = input;
  const { config } = loaded;
  const target = config.name;
  const report = join(layout.root, "reports", target, "dev", "summary.json");
  const decisionPath = join(layout.root, "out", target, "h3", "decision.json");
  const decision = JSON.parse(readFileSync(decisionPath, "utf8")) as { splitFilesFor: Record<string, boolean> };
  const guide = /Версія:\s*([\d.]+)/.exec(readFileSync(join(root, "docs", "labelling-guide.md"), "utf8"))?.[1] ?? "unknown";
  const templates = Object.values(TEMPLATES);
  const manifest: FreezeManifest = {
    tag,
    commit: git(["rev-parse", "HEAD"], root).trim(),
    configHash: loaded.hash,
    createdAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    rulesHash: loadRules(config.rules.packs, root).hash,
    promptsHash: templatesHash(templates, root),
    templates,
    models: { cloud: config.llm.cloud.model, local: config.llm.local.model },
    chunking: config.llm.chunking,
    guide,
    predictedShares: predictedShares(input),
    devReport: { path: report, sha256: createHash("sha256").update(readFileSync(report)).digest("hex") },
    h3Decision: { path: decisionPath, splitFilesFor: decision.splitFilesFor },
  };
  mkdirSync(join(root, "freeze"), { recursive: true });
  writeFileSync(join(root, "freeze", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  git(["add", "freeze/manifest.json"], root);
  git(["commit", "--quiet", "-m", `freeze: ${tag}`], root);
  git(["tag", "-a", tag, "-m", `Method frozen: ${tag}`], root);
  return { manifest, digest: digestOf(manifest) };
}

/** The text sent to the supervisor before the test run. */
export function digestOf(m: FreezeManifest): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)} %`;
  return [
    `Method frozen: ${m.tag} (${m.createdAt})`,
    `Commit of the method: ${m.commit}`,
    `Config ${m.configHash.slice(0, 12)}, rules ${m.rulesHash.slice(0, 12)}, prompts ${m.promptsHash.slice(0, 12)}, extraction engine v${m.engineVersion}, labelling guide v${m.guide}`,
    `Models: ${m.models.cloud} (cloud), ${m.models.local} (local); file splitting: cloud ${m.chunking.cloud ? "on" : "off"}, local ${m.chunking.local ? "on" : "off"}`,
    `Hypothesis 1, predicted drop of recall R1-7 without each component (${m.predictedShares.units} labelled test units): rules ${pct(m.predictedShares.rules)}, infrastructure ${pct(m.predictedShares.infra)}, language model ${pct(m.predictedShares.llm)}`,
  ].join("\n");
}
