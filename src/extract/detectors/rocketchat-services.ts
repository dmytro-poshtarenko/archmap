import { ts } from "ts-morph";
import { guardOf } from "../guard.js";
import { resolveSymbol } from "../scope.js";
import type { DetectorContext, FoundRoute, RouteDetector } from "./types.js";

/** Methods every service inherits; not actions of its own. */
const LIFECYCLE = new Set(["constructor", "created", "started", "stopped", "getName", "isInternal", "onEvent", "emit", "onSettingChanged"]);

export interface Registration {
  /** `<repo>:<path>:<line>` of the `registerService` call. */
  at: string;
  /** Components running the registering code. */
  components: string[];
  /** Condition the registration runs under, e.g. `!isRunningMs()`; empty when unconditional. */
  guard: string;
}

/**
 * Broker actions of Rocket.Chat services: a class extending `ServiceClass`
 * (or `ServiceClassInternal`) named by `protected name = 'presence'` exposes
 * each of its public methods as the action `presence.<method>`. The service
 * runs where `api.registerService(new Presence())` is executed, under the
 * condition around that call (`if (!isRunningMs())` in the monolith), which
 * the deployment profile decides when matching.
 */
export const rocketchatServices: RouteDetector = {
  kind: "routes",
  version: 2,
  run(ctx: DetectorContext): FoundRoute[] {
    const { program } = ctx;
    const services = new Map<ts.ClassDeclaration, { ns: string; methods: ts.Identifier[] }>();
    for (const f of ctx.files) {
      const id = `${f.repo}:${f.path}`;
      if (!/extends\s+ServiceClass/.test(program.text(id))) continue;
      const visit = (n: ts.Node) => {
        if (ts.isClassDeclaration(n) && extendsService(n)) {
          const ns = serviceName(n);
          if (ns) services.set(n, { ns, methods: actionsOf(n) });
        }
        ts.forEachChild(n, visit);
      };
      visit(program.source(id));
    }

    const registrations = new Map<ts.ClassDeclaration, Registration[]>();
    for (const f of ctx.files) {
      const id = `${f.repo}:${f.path}`;
      if (!program.text(id).includes("registerService(")) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && calleeName(n.expression) === "registerService") {
          const created = n.arguments[0];
          if (created && ts.isNewExpression(created) && ts.isIdentifier(created.expression)) {
            const r = resolveSymbol(program, created.expression);
            const cls = r.target.kind === "binding" && r.target.binding.kind === "class" ? r.target.binding.decl : undefined;
            if (cls && ts.isClassDeclaration(cls) && services.has(cls)) {
              const list = registrations.get(cls) ?? [];
              list.push({ at: program.where(n), components: ctx.usage?.get(id) ?? [], guard: guardOf(n) });
              registrations.set(cls, list);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(program.source(id));
    }

    const out: FoundRoute[] = [];
    for (const [cls, { ns, methods }] of services) {
      const regs = registrations.get(cls) ?? [];
      const components = regs.length > 0 ? [...new Set(regs.flatMap((r) => r.components))].sort() : undefined;
      for (const m of methods) {
        out.push({
          node: m,
          kind: "broker-action",
          method: null,
          template: `${ns}.${m.text}`,
          ...(components ? { components } : {}),
          extra: { service: ns, registrations: regs },
        });
      }
    }
    return out;
  },
};

function actionsOf(cls: ts.ClassDeclaration): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  for (const m of cls.members) {
    if (!ts.isMethodDeclaration(m) || !m.name || !ts.isIdentifier(m.name) || LIFECYCLE.has(m.name.text)) continue;
    const mods = ts.getModifiers(m) ?? [];
    const hidden = mods.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword || x.kind === ts.SyntaxKind.StaticKeyword);
    if (!hidden) out.push(m.name);
  }
  return out;
}

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function extendsService(cls: ts.ClassDeclaration): boolean {
  const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base !== undefined && ts.isIdentifier(base) && /^ServiceClass(?:Internal)?$/.test(base.text);
}

function serviceName(cls: ts.ClassDeclaration): string | undefined {
  for (const m of cls.members) {
    if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.name.text === "name" && m.initializer && ts.isStringLiteral(m.initializer)) {
      return m.initializer.text;
    }
  }
  return undefined;
}
