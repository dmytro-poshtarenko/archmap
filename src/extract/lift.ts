import { ts } from "ts-morph";
import type { AbstractValue, Hop } from "../core/types.js";
import type { CallMatcher, RawSite } from "./calls.js";
import { type Evaluator, NO_PARAMS, type ParamArg, type ParamEnv } from "./evaluate.js";
import type { Program } from "./program.js";
import { enclosingFunction, resolveExport, resolveSymbol } from "./scope.js";
import { literalOf, paramParts, paramPositions, withHop } from "./value.js";

type Fn = ts.SignatureDeclaration;

/** A site after lifting: where it is reported, and the call it came from if lifted. */
export interface PlacedSite {
  raw: RawSite;
  at: ts.CallExpression | ts.NewExpression;
  address: AbstractValue;
  method: AbstractValue | null;
  liftedFrom: RawSite | null;
}

interface Caller {
  call: ts.CallExpression;
  hops: Hop[];
}

/**
 * Moves a call whose address depends on a parameter of its function to the
 * calls of that function, where the address is fixed (`postJson('/orders')`
 * rather than the `fetch` inside `postJson`), through at most `maxDepth`
 * wrappers. The inner call is then no site of its own. A parameter that only
 * fills a path segment (`/orders/${id}`) is an id, not a choice of route, and
 * is lifted only when every caller passes a path.
 */
export class Lifter {
  private importers: Map<string, Set<string>> | undefined;
  private readonly calls = new Map<string, ts.CallExpression[]>();

  constructor(
    private readonly program: Program,
    private readonly matcher: CallMatcher,
    private readonly evaluator: Evaluator,
    private readonly opts: { maxDepth: number; files: string[] },
  ) {}

  place(raw: RawSite): PlacedSite[] {
    const keep: PlacedSite = { raw, at: raw.node, address: raw.address, method: raw.method, liftedFrom: null };
    const fn = enclosingFunction(raw.node);
    if (!fn || this.opts.maxDepth === 0) return [keep];
    const decision = this.decision(raw, fn);
    if (decision === "keep") return [keep];
    // A recursive call passes the address along; it never fixes it.
    const callers = this.callersOf(fn).filter((c) => enclosingFunction(c.call) !== fn);
    if (callers.length === 0) return [keep];
    if (decision === "maybe" && !callers.every((c) => this.passesPaths(raw, fn, c.call))) return [keep];
    const out: PlacedSite[] = [];
    const seen = new Set<string>();
    for (const c of callers) this.liftThrough(raw, [{ fn, caller: c }], out, seen);
    return out.length > 0 ? out : [keep];
  }

  /** Whether the site's values depend on the function's parameters in a way that decides the target. */
  private decision(raw: RawSite, fn: Fn): "keep" | "lift" | "maybe" {
    const fnId = this.program.nodeId(fn);
    const ownMethod = raw.method ? paramParts(raw.method).some((p) => p.fn === fnId) : false;
    const positions = paramPositions(raw.address).filter((p) => p.param.fn === fnId);
    if (ownMethod) return "lift";
    if (positions.length === 0) return "keep";
    if (raw.binding.type !== "http") return "lift";
    if (positions.some((p) => p.position === "inside")) return "lift";
    return positions.every((p) => p.position === "query") ? "keep" : "maybe";
  }

  /** Whether a caller passes a path (text with a slash) for every segment parameter. */
  private passesPaths(raw: RawSite, fn: Fn, call: ts.CallExpression): boolean {
    const fnId = this.program.nodeId(fn);
    for (const p of paramPositions(raw.address)) {
      if (p.param.fn !== fnId || p.position !== "segment") continue;
      const arg = call.arguments[p.param.index];
      const value = arg && (p.param.path.length > 0 ? this.evaluator.property(arg, p.param.path) : this.evaluator.evaluate(arg));
      const text = value ? literalOf(value) : undefined;
      if (text === undefined || !text.includes("/")) return false;
    }
    return true;
  }

  private liftThrough(raw: RawSite, chain: Array<{ fn: Fn; caller: Caller }>, out: PlacedSite[], seen: Set<string>): void {
    // Bind each function's parameters to its caller's arguments, outermost first.
    let env: ParamEnv = NO_PARAMS;
    for (let i = chain.length - 1; i >= 0; i--) {
      const link = chain[i];
      if (!link) continue;
      const bound = new Map<ts.ParameterDeclaration, ParamArg>();
      link.fn.parameters.forEach((p, k) => bound.set(p, { expr: link.caller.call.arguments[k], env }));
      env = bound;
    }
    const values = this.matcher.values(raw.node, raw.binding, raw.members, raw.factory, env);
    if (!values) return;
    const outer = chain[chain.length - 1];
    if (!outer) return;
    const hops: Hop[] = chain.flatMap((link) => [
      ...link.caller.hops,
      { kind: "wrapper" as const, at: this.program.where(link.fn), name: fnName(link.fn) },
    ]);
    const decorate = (v: AbstractValue) => hops.reduceRight((acc, h) => withHop(acc, h), v);

    const next = enclosingFunction(outer.caller.call);
    const nextId = next ? this.program.nodeId(next) : undefined;
    const dependsOnNext =
      nextId !== undefined &&
      (paramParts(values.address).some((p) => p.fn === nextId) || (values.method ? paramParts(values.method).some((p) => p.fn === nextId) : false));
    if (next && dependsOnNext && chain.length < this.opts.maxDepth) {
      const inChain = new Set<ts.Node>([...chain.map((l) => l.fn), next]);
      const callers = this.callersOf(next).filter((c) => {
        const at = enclosingFunction(c.call);
        return !at || !inChain.has(at);
      });
      if (callers.length > 0) {
        for (const c of callers) this.liftThrough(raw, [...chain, { fn: next, caller: c }], out, seen);
        return;
      }
    }
    const key = this.program.nodeId(outer.caller.call);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      raw,
      at: outer.caller.call,
      address: decorate(values.address),
      method: values.method,
      liftedFrom: raw,
    });
  }

  /** Calls of a named function, in its own file and in the files importing it. */
  callersOf(fn: Fn): Caller[] {
    const decl = declarationOf(fn);
    if (!decl) return [];
    const home = this.program.idOf(fn);
    const out: Caller[] = [];
    for (const fileId of [home, ...(this.importersOf(home) ?? [])]) {
      for (const call of this.callsIn(fileId)) {
        const callee = call.expression;
        if (ts.isIdentifier(callee)) {
          const r = resolveSymbol(this.program, callee);
          if (r.target.kind === "binding" && declOf(r.target.binding) === decl) out.push({ call, hops: r.hops });
        } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const r = resolveSymbol(this.program, callee.expression);
          if (r.target.kind !== "namespace") continue;
          const e = resolveExport(this.program, r.target.fileId, callee.name.text, new Set());
          if (e.target.kind === "binding" && declOf(e.target.binding) === decl) out.push({ call, hops: [...r.hops, ...e.hops] });
        }
      }
    }
    return out;
  }

  private callsIn(fileId: string): ts.CallExpression[] {
    let list = this.calls.get(fileId);
    if (!list) {
      const found: ts.CallExpression[] = [];
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) found.push(n);
        ts.forEachChild(n, visit);
      };
      visit(this.program.source(fileId));
      list = found;
      this.calls.set(fileId, list);
    }
    return list;
  }

  /** Files that import a file, directly or through modules re-exporting it. */
  private importersOf(fileId: string): Set<string> | undefined {
    if (!this.importers) {
      const direct = new Map<string, Set<string>>();
      const reexports = new Map<string, Set<string>>();
      for (const id of this.opts.files) {
        const sf = this.program.source(id);
        for (const s of sf.statements) {
          const spec = (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : undefined;
          if (!spec) continue;
          const r = this.program.resolveImport(id, spec);
          if (r.kind !== "file") continue;
          addTo(direct, r.id, id);
          if (ts.isExportDeclaration(s)) addTo(reexports, r.id, id);
        }
      }
      this.importers = new Map();
      for (const target of direct.keys()) {
        const all = new Set<string>();
        const stack = [target];
        const visited = new Set<string>();
        while (stack.length > 0) {
          const t = stack.pop() as string;
          if (visited.has(t)) continue;
          visited.add(t);
          for (const i of direct.get(t) ?? []) all.add(i);
          for (const r of reexports.get(t) ?? []) stack.push(r);
        }
        this.importers.set(target, all);
      }
    }
    return this.importers.get(fileId);
  }
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

/** The declaration a function is known by: its own, or the variable it is assigned to. */
function declarationOf(fn: Fn): ts.Node | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent)) return fn.parent;
  return undefined;
}

function declOf(binding: Extract<ReturnType<typeof resolveSymbol>["target"], { kind: "binding" }>["binding"]): ts.Node {
  return binding.decl;
}

function fnName(fn: Fn): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}
