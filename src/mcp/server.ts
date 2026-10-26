import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runClassify } from "../classify/run.js";
import type { LoadedConfig } from "../config/load.js";
import type { DataLayout } from "../core/paths.js";
import { LlmClient } from "../llm/client.js";
import { providerOf } from "../llm/providers/index.js";
import { reader, runResolve } from "../llm/run.js";
import { featureRelations } from "../map/feature.js";
import type { RelationKind } from "../map/graph.js";
import { addFeatureView, buildMap, currentMapDir, currentMapRun, defaultMapRun, graphOf, mapDir } from "../map/run.js";
import { runMatch } from "../match/run.js";
import type { Db } from "../store/db.js";

export interface McpContext {
  loaded: LoadedConfig;
  layout: DataLayout;
  openDb(): Db;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true });

/** Where a developer sees a view: the LikeC4 viewer that `archmap view` starts. */
const VIEWER = "http://localhost:5173/view";

/** The run a variant's map is drawn from: the model's run when one exists. */
function drawnRun(db: Db, variant: string): string {
  const derived = db.prepare("SELECT id FROM run WHERE id LIKE ? ORDER BY created_at DESC LIMIT 1").pluck().get(`${variant}.select.%`) as string | undefined;
  return derived ?? variant;
}

/**
 * The project's own MCP server over stdio, next to the read-only LikeC4
 * server: it rebuilds the map, lists what the method could not resolve
 * (metadata only, never code), and adds feature views. Logs go to stderr;
 * stdout carries the protocol.
 */
export function createServer(ctx: McpContext): McpServer {
  const { config } = ctx.loaded;
  const server = new McpServer({ name: "archmap", version: "0.1.0" });

  server.registerTool(
    "rebuild_map",
    {
      title: "Rebuild the map",
      description:
        "Classifies the call sites, matches them for a variant of the method, lets the language model resolve what the rules leave open (from recorded answers unless llm is 'live'), and writes and validates the LikeC4 model. The model defaults to the cloud model of the config (its channel decides API or Claude Code).",
      inputSchema: {
        variant: z.enum(["full", "no-llm", "no-infra", "no-rules"]).default("full"),
        llm: z.enum(["cache-only", "live"]).default("cache-only"),
        model: z.enum(["local", "cloud", "cloud-cli"]).default("cloud"),
      },
    },
    async ({ variant, llm, model }) => {
      const db = ctx.openDb();
      try {
        const classified = runClassify(db, config);
        const flags = { rules: variant !== "no-rules", infra: variant !== "no-infra", llm: variant !== "no-llm" };
        const matched = runMatch(db, config, flags, { configHash: ctx.loaded.hash });
        let resolved: unknown = null;
        if (flags.llm) {
          const choice = llm === "live" ? model : (`replay-${model}` as const);
          const client = new LlmClient(db, providerOf(config, choice, db), { budgetUsd: config.llm.budgetUsd, log: (m) => process.stderr.write(`${m}\n`) });
          try {
            resolved = await runResolve(db, config, reader(config, ctx.layout, ctx.loaded.path), client, { base: matched.run, mode: "select", scope: "open", configHash: ctx.loaded.hash });
          } catch (error) {
            resolved = { skipped: error instanceof Error ? error.message : String(error) };
          }
        }
        const run = drawnRun(db, matched.run);
        const dir = mapDir(ctx.layout.root, config.name, run);
        const { graph, diagnostics } = await buildMap(db, config, run, dir, currentMapDir(ctx.layout.root, config.name));
        return json({ run, dir, open: `${VIEWER}/index/`, cases: classified.byCase, status: matched.byStatus, resolved, elements: graph.elements.length, relations: graph.relations.length, diagnostics });
      } catch (error) {
        return failure(error);
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    "list_unresolved",
    {
      title: "List unresolved call sites",
      description:
        "Call sites a run left without a target or with several, with their predicted case and location. Only metadata: no code, and no address from files of closed licence zones.",
      inputSchema: {
        run: z.string().default("full"),
        cases: z.array(z.number().int().min(1).max(8)).optional(),
        type: z.enum(["http", "ddp", "broker", "db", "trigger"]).optional(),
        component: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ run, cases, type, component, limit }) => {
      const db = ctx.openDb();
      try {
        const rows = db
          .prepare(
            `SELECT l.site, s.repo, s.path, s.line, s.type, s.role, s.detector, s.display, s.components, l.status, l.reason, l.case_no, l.alternatives, f.publishable
             FROM link l JOIN call_site s ON s.id = l.site JOIN file f ON f.repo_id = s.repo AND f.path = s.path
             WHERE l.run = ? AND l.status IN ('unresolved', 'ambiguous') ORDER BY s.repo, s.path, s.line`,
          )
          .all(run) as Array<Record<string, unknown>>;
        const picked = rows
          .filter((r) => (cases ? cases.includes(Number(r.case_no)) : true))
          .filter((r) => (type ? r.type === type : true))
          .filter((r) => (component ? (JSON.parse(String(r.components)) as string[]).includes(component) : true));
        return json({
          run,
          total: picked.length,
          sites: picked.slice(0, limit).map((r) => ({
            site: r.site,
            location: `${r.repo}:${r.path}:${r.line}`,
            type: r.type,
            role: r.role,
            detector: r.detector,
            address: r.publishable === 1 ? r.display : "(closed licence zone)",
            components: JSON.parse(String(r.components)),
            status: r.status,
            reason: r.reason,
            predictedCase: r.case_no,
            alternatives: JSON.parse(String(r.alternatives)),
          })),
        });
      } catch (error) {
        return failure(error);
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    "create_feature_view",
    {
      title: "Create a feature view",
      description:
        "Adds a LikeC4 view of the parts a feature uses: from seeds (element ids, route patterns like /api/v1/rooms.*, ns:<broker service>, coll:<collection>, or keywords), breadth first along relations of the given kinds and direction, and validates the model. Returns the parts, the links between them with their routes, and where to open the view.",
      inputSchema: {
        name: z.string().min(1),
        seeds: z.array(z.string().min(1)).min(1),
        depth: z.number().int().min(1).max(4).default(1),
        kinds: z.array(z.enum(["http", "ddp", "rpc", "event", "db", "trigger", "route"])).optional(),
        direction: z.enum(["in", "out", "both"]).default("both"),
        run: z.string().optional(),
      },
    },
    async ({ name, seeds, depth, kinds, direction, run }) => {
      const db = ctx.openDb();
      try {
        const drawn = run ?? currentMapRun(ctx.layout.root, config.name) ?? defaultMapRun(db);
        const dir = mapDir(ctx.layout.root, config.name, drawn);
        const graph = graphOf(db, config, drawn);
        const { feature, diagnostics } = await addFeatureView(graph, dir, { name, seeds, depth, kinds: kinds as RelationKind[] | undefined, direction }, drawn);
        const links = featureRelations(graph, feature).map((r) => ({ from: r.source, to: r.target, kind: r.kind, what: r.description ?? r.title, tags: r.tags, sites: r.sites.length }));
        return json({
          view: `feature_${feature.slug}`,
          open: `${VIEWER}/feature_${feature.slug}/ (start the viewer with \`archmap view\`)`,
          run: drawn,
          elements: feature.elements,
          links,
          seeds: feature.seeds,
          unmatched: feature.unmatched,
          diagnostics,
        });
      } catch (error) {
        return failure(error);
      } finally {
        db.close();
      }
    },
  );

  return server;
}

export async function serveMcp(ctx: McpContext): Promise<void> {
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`archmap MCP server ready for ${ctx.loaded.config.name}\n`);
}
