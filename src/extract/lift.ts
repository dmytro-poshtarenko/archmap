import { ts } from "ts-morph";
import type { AbstractValue, Hop } from "../core/types.js";
import type { CallMatcher, RawSite } from "./calls.js";
import { type Evaluator, NO_PARAMS, type ParamArg, type ParamEnv } from "./evaluate.js";
import type { Program } from "./program.js";
import { inRepoGlob } from "./calls.js";
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
  private memberCalls: Map<string, ts.CallExpression[]> | undefined;

  constructor(
    private readonly program: Program,
    private readonly matcher: CallMatcher,
    private readonly evaluator: Evaluator,
    private readonly opts: {
      maxDepth: number;
      files: string[];
      /** Client library code: its calls are sites only where application code calls the library. */
      libraries?: string[];
      /** Library classes whose methods are followed to the calls on their instances. */
      facades?: Array<{ class: string; file: string }>;
    },
  ) {}

  private inLibrary(node: ts.Node): boolean {
    const id = this.program.idOf(node);
    return (this.opts.libraries ?? []).some((g) => inRepoGlob(g, id));
  }

  place(raw: RawSite): PlacedSite[] {
    const keep: PlacedSite = { raw, at: raw.node, address: raw.address, method: raw.method, liftedFrom: null };
    const library = this.inLibrary(raw.node);
    const fn = enclosingFunction(raw.node);
    if (!fn || this.opts.maxDepth === 0) return library ? [] : [keep];
    const decision = library ? "lift" : this.decision(raw, fn);
    if (decision === "keep") return [keep];
    // A recursive call passes the address along; it never fixes it.
    const callers = this.callersOf(fn).filter((c) => enclosingFunction(c.call) !== fn);
    if (callers.length === 0) return library ? [] : [keep];
    if (decision === "maybe" && !callers.every((c) => this.passesPaths(raw, fn, c.call))) return [keep];
    const out: PlacedSite[] = [];
    const seen = new Set<string>();
    for (const c of callers) this.liftThrough(raw, [{ fn, caller: c }], out, seen, library);
    if (out.length > 0) return out;
    return library ? [] : [keep];
  }

  /** Whether the site's values depend on the function's parameters in a way that decides the target. */
  private decision(raw: RawSite, fn: Fn): "keep" | "lift" | "maybe" {
    return this.decide(raw.binding.type, raw.address, raw.method, fn);
  }

  private decide(type: string, address: AbstractValue, method: AbstractValue | null, fn: Fn): "keep" | "lift" | "maybe" {
    const fnId = this.program.nodeId(fn);
    const ownMethod = method ? paramParts(method).some((p) => p.fn === fnId) : false;
    const positions = paramPositions(address).filter((p) => p.param.fn === fnId);
    if (ownMethod) return "lift";
    if (positions.length === 0) return "keep";
    if (type !== "http") return "lift";
    if (positions.some((p) => p.position === "inside")) return "lift";
    return positions.every((p) => p.position === "query") ? "keep" : "maybe";
  }

  /** Whether a caller passes a path (text with a slash) for every segment parameter. */
  private passesPaths(raw: RawSite | { address: AbstractValue }, fn: Fn, call: ts.CallExpression): boolean {
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

  private liftThrough(raw: RawSite, chain: Array<{ fn: Fn; caller: Caller }>, out: PlacedSite[], seen: Set<string>, library: boolean): void {
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
    const stillInLibrary = library && this.inLibrary(outer.caller.call);
    if (next && chain.length < this.opts.maxDepth + (library ? 2 : 0)) {
      // Inside a library every level is lifted; in application code only a
      // parameter that decides the target is (an id in a path segment is not).
      const decision = stillInLibrary ? "lift" : this.decide(raw.binding.type, values.address, values.method, next);
      const inChain = new Set<ts.Node>([...chain.map((l) => l.fn), next]);
      const callers =
        decision === "keep"
          ? []
          : this.callersOf(next).filter((c) => {
              const at = enclosingFunction(c.call);
              return !at || !inChain.has(at);
            });
      const lift = callers.length > 0 && (decision === "lift" || callers.every((c) => this.passesPaths({ address: values.address }, next, c.call)));
      if (lift) {
        for (const c of callers) this.liftThrough(raw, [...chain, { fn: next, caller: c }], out, seen, library);
        return;
      }
    }
    // A library call that never reaches application code is no site.
    if (stillInLibrary) return;
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

  /** Calls of a named function, in its own file and in the files importing it; or of a facade method on its instances. */
  callersOf(fn: Fn): Caller[] {
    if (ts.isMethodDeclaration(fn)) return this.facadeCallers(fn);
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

  /** `x.method(...)` where `x` is an instance of the facade class declaring the method, and `this.method(...)` inside it. */
  private facadeCallers(method: ts.MethodDeclaration): Caller[] {
    const cls = method.parent;
    if (!ts.isClassDeclaration(cls) || !cls.name || !method.name || !ts.isIdentifier(method.name)) return [];
    const id = this.program.idOf(cls);
    const facade = (this.opts.facades ?? []).some((f) => f.class === cls.name?.text && inRepoGlob(f.file, id));
    if (!facade) return [];
    if (!this.memberCalls) {
      this.memberCalls = new Map();
      for (const fileId of this.opts.files) {
        for (const call of this.callsIn(fileId)) {
          if (!ts.isPropertyAccessExpression(call.expression)) continue;
          const name = call.expression.name.text;
          const list = this.memberCalls.get(name) ?? [];
          list.push(call);
          this.memberCalls.set(name, list);
        }
      }
    }
    const out: Caller[] = [];
    for (const call of this.memberCalls.get(method.name.text) ?? []) {
      const receiver = (call.expression as ts.PropertyAccessExpression).expression;
      const found = this.classOf(receiver, 0);
      if (found?.cls === cls) out.push({ call, hops: found.hops });
    }
    return out;
  }

  /** The class an expression is an instance of: `new C()`, `C.create()`, `this`, or a constant holding one. */
  private classOf(expr: ts.Expression, depth: number): { cls: ts.ClassDeclaration; hops: Hop[] } | undefined {
    if (depth > 6) return undefined;
    let e = expr;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    if (e.kind === ts.SyntaxKind.ThisKeyword) {
      for (let n: ts.Node | undefined = e.parent; n; n = n.parent) if (ts.isClassDeclaration(n)) return { cls: n, hops: [] };
      return undefined;
    }
    const classNamed = (id: ts.Identifier) => {
      const r = resolveSymbol(this.program, id);
      return r.target.kind === "binding" && r.target.binding.kind === "class" && ts.isClassDeclaration(r.target.binding.decl)
        ? { cls: r.target.binding.decl, hops: r.hops }
        : undefined;
    };
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression)) return classNamed(e.expression);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      return classNamed(e.expression.expression);
    }
    if (ts.isIdentifier(e)) {
      const r = resolveSymbol(this.program, e);
      const t = r.target;
      if (t.kind === "binding" && t.binding.kind === "var" && t.binding.decl.initializer && !t.binding.element) {
        const inner = this.classOf(t.binding.decl.initializer, depth + 1);
        return inner && { cls: inner.cls, hops: [...r.hops, { kind: "const", at: this.program.where(t.binding.decl), name: e.text }, ...inner.hops] };
      }
    }
    return undefined;
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
