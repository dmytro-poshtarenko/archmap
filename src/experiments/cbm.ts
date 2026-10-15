import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TargetConfig } from "../config/schema.js";
import type { DataLayout } from "../core/paths.js";
import type { Db } from "../store/db.js";
import { locateRepo } from "../workspace/repos.js";

/** One answer of the baseline: what a code entity calls, with its file and lines. */
export interface CbmPrediction {
  repo: string;
  path: string;
  /** Lines of the calling entity; 0 when the index does not know them. */
  start: number;
  end: number;
  type: "http" | "broker";
  method: string;
  /** URL path of an HTTP call, or the channel of an event. */
  name: string;
  /** Part of the system the index attributes the target to, when a cross-repository match gave one. */
  component: string | null;
  edge: string;
}

type Row = Record<string, unknown>;

/**
 * The baseline: codebase-memory-mcp run as an MCP server over stdio. Every
 * code repository of the target is indexed (`full` mode), then matched
 * across repositories; HTTP calls and event channels are read with
 * `query_graph`. Its routes are made from the URLs at call sites, not from
 * declarations, so it names the path a call uses but not the part of the
 * system that serves it.
 */
export async function collectCbm(config: TargetConfig, layout: DataLayout, configPath: string, binary = "codebase-memory-mcp"): Promise<{ version: string; predictions: CbmPrediction[] }> {
  const client = new Client({ name: "archmap", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: binary, args: [], stderr: "ignore" }));
  try {
    const version = client.getServerVersion()?.version ?? "unknown";
    const call = async (name: string, args: Record<string, unknown>): Promise<Row> => {
      const r = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
      const text = r.content?.[0]?.text ?? "{}";
      if (r.isError) throw new Error(`codebase-memory-mcp ${name}: ${text}`);
      return JSON.parse(text) as Row;
    };
    const projects: Array<{ repo: string; project: string }> = [];
    for (const repo of config.repos.filter((r) => r.role !== "heldout" && r.role !== "infra")) {
      const dir = locateRepo(repo, layout, configPath).dir;
      const indexed = await call("index_repository", { repo_path: dir, mode: "full" });
      projects.push({ repo: repo.id, project: String(indexed.project) });
    }
    if (projects.length > 1) {
      const first = projects[0] as { repo: string; project: string };
      const dir = locateRepo(config.repos.find((r) => r.id === first.repo) as never, layout, configPath).dir;
      await call("index_repository", { repo_path: dir, mode: "cross-repo-intelligence", target_projects: projects.map((p) => p.project) });
    }
    const repoOfProject = new Map(projects.map((p) => [p.project, p.repo]));
    const predictions: CbmPrediction[] = [];
    const rows = async (project: string, query: string): Promise<Row[]> => {
      try {
        const r = await call("query_graph", { project, query, max_rows: 100000 });
        const columns = r.columns as string[];
        return ((r.rows as unknown[][]) ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      } catch {
        return [];
      }
    };
    for (const { repo, project } of projects) {
      for (const edge of ["HTTP_CALLS", "CROSS_HTTP_CALLS"]) {
        for (const r of await rows(project, `MATCH (a)-[r:${edge}]->(b) RETURN a.file_path, a.start_line, a.end_line, r.method, r.url_path, b.name, b.file_path, b.project`)) {
          const name = String(r["r.url_path"] || r["b.name"] || "");
          if (!name) continue;
          const targetRepo = r["b.project"] ? (repoOfProject.get(String(r["b.project"])) ?? null) : null;
          predictions.push({
            repo,
            path: String(r["a.file_path"]),
            start: Number(r["a.start_line"]) || 0,
            end: Number(r["a.end_line"]) || 0,
            type: "http",
            method: String(r["r.method"] || "*").toUpperCase(),
            name,
            component: edge === "CROSS_HTTP_CALLS" && targetRepo ? (config.components.find((c) => c.include.some((g) => g.startsWith(`${targetRepo}:`)))?.id ?? null) : null,
            edge,
          });
        }
      }
      for (const edge of ["EMITS", "LISTENS_ON"]) {
        for (const r of await rows(project, `MATCH (a)-[r:${edge}]->(c) RETURN a.file_path, a.start_line, a.end_line, c.name, r.transport`)) {
          predictions.push({ repo, path: String(r["a.file_path"]), start: Number(r["a.start_line"]) || 0, end: Number(r["a.end_line"]) || 0, type: "broker", method: "-", name: String(r["c.name"]), component: null, edge });
        }
      }
    }
    return { version, predictions };
  } finally {
    await client.close();
  }
}

/** A place in the code the baseline answers for: a line of a file. */
export interface CbmSite {
  id: string;
  repo: string;
  path: string;
  line: number;
  prediction: CbmPrediction;
}

/**
 * Where the baseline's answers sit in the code. The index reports the
 * calling function, often by one line only, so each answer is placed on
 * the lines of its file that quote its URL path or channel name: there the
 * labelled units meet it, exactly as they meet the method's own sites, and
 * an answer on a line that is no call counts against it.
 */
export function placeCbm(predictions: CbmPrediction[], read: (repo: string, path: string) => string): CbmSite[] {
  const out = new Map<string, CbmSite>();
  const texts = new Map<string, string[] | null>();
  for (const p of predictions) {
    const file = `${p.repo}:${p.path}`;
    if (!texts.has(file)) {
      try {
        texts.set(file, read(p.repo, p.path).split("\n"));
      } catch {
        texts.set(file, null);
      }
    }
    const lines = texts.get(file);
    if (!lines) continue;
    const needle = p.type === "http" ? p.name.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "") : p.name;
    if (needle.length < 2) continue;
    const quoted = new RegExp(`['"\`][^'"\`]*${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^'"\`]*['"\`]`);
    lines.forEach((text, i) => {
      if (!quoted.test(text)) return;
      const id = `cbm:${file}:${i + 1}`;
      if (!out.has(id)) out.set(id, { id, repo: p.repo, path: p.path, line: i + 1, prediction: p });
    });
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** The baseline's answer as a target key; `?` where it cannot name the part of the system. */
export function cbmKey(p: CbmPrediction): string {
  if (p.type === "http") return `http:${p.method === "" ? "*" : p.method}:/${p.name.replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/^\/+/, "")}@${p.component ?? "?"}`;
  return `event:-:${p.name}@*`;
}

/**
 * Stores the baseline as run `cbm`: one link row per place it answers for,
 * keyed `cbm:<repo>:<path>:<line>`; evaluation aligns these places with the
 * labelled units like the method's sites.
 */
export function writeCbmRun(db: Db, version: string, predictions: CbmPrediction[], read: (repo: string, path: string) => string, configHash: string): { run: string; places: number } {
  const places = placeCbm(predictions, read);
  const insert = db.prepare(
    `INSERT INTO link(run, site, status, target, route, component, reason, via, provenance, case_no, alternatives, llm_answer)
     VALUES ('cbm', ?, 'linked', ?, NULL, ?, ?, '[]', 'baseline', NULL, '[]', NULL)`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM run WHERE id = 'cbm'").run();
    db.prepare(
      `INSERT INTO run(id, created_at, variant, llm_mode, models, tool_sha, config_hash, inputs, timings, cost_usd)
       VALUES ('cbm', ?, ?, NULL, NULL, NULL, ?, ?, NULL, 0)`,
    ).run(new Date().toISOString(), JSON.stringify({ baseline: "codebase-memory-mcp", version, mode: "full" }), configHash, JSON.stringify({ predictions: predictions.length }));
    for (const p of places) insert.run(p.id, cbmKey(p.prediction), p.prediction.component, `cbm:${p.prediction.edge}`);
  })();
  return { run: "cbm", places: places.length };
}
