import { ts } from "ts-morph";
import type { AbstractValue, Hop } from "../core/types.js";
import { importOrigin } from "./detectors/express.js";
import { type Evaluator, memberName, NO_PARAMS, type ParamEnv } from "./evaluate.js";
import type { Program } from "./program.js";
import type { Binding, Callee, Factory, RuleSet, ValueSpec } from "./rules.js";
import { resolveSymbol } from "./scope.js";
import { joinUrl, lit, literalOf, withHop } from "./value.js";

type CallNode = ts.CallExpression | ts.NewExpression;

/** A call recognised by a binding. Its values are computed again when it is lifted. */
export interface RawSite {
  node: CallNode;
  binding: Binding;
  members: string[];
  /** Values captured from the factory that created the callee's root, with the hops to reach it. */
  factory: { values: Record<string, AbstractValue>; hops: Hop[] } | undefined;
  address: AbstractValue;
  method: AbstractValue | null;
}

interface Shape {
  root: ts.Expression;
  members: string[];
}

/** `a.b.c(...)` → root `a`, members `b`, `c`. Returns undefined for computed members. */
function shapeOf(callee: ts.Expression): Shape | undefined {
  const members: string[] = [];
  let e = callee;
  for (;;) {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const name = memberName(e);
      if (name === undefined) return undefined;
      members.unshift(name);
      e = e.expression;
      continue;
    }
    return { root: e, members };
  }
}

/**
 * Recognises calls with the bindings of the rule packs and evaluates their
 * addresses. A binding matches when its callee does (see `Callee`); the first
 * matching binding wins.
 */
export class CallMatcher {
  constructor(
    private readonly program: Program,
    private readonly evaluator: Evaluator,
    private readonly rules: RuleSet,
  ) {}

  detect(fileIds: string[]): RawSite[] {
    const out: RawSite[] = [];
    for (const id of fileIds) {
      const sf = this.program.source(id);
      const imports = fileImports(sf);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const site = this.match(n, imports);
          if (site) out.push(site);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return out;
  }

  private match(node: CallNode, imports: Set<string>): RawSite | undefined {
    const shape = shapeOf(node.expression);
    if (!shape) return undefined;
    for (const binding of this.rules.bindings) {
      const m = this.calleeMatches(binding.callee, node, shape, imports);
      if (!m) continue;
      const site = this.values(node, binding, shape.members, m.factory, NO_PARAMS);
      if (site) return site;
    }
    return undefined;
  }

  /** Whether a call fits a callee description; for instances, the factory values found. */
  calleeMatches(
    callee: Callee,
    node: CallNode,
    shape: Shape,
    imports: Set<string>,
  ): { factory: RawSite["factory"] } | undefined {
    if (callee.new !== ts.isNewExpression(node)) return undefined;
    if (callee.members.length !== shape.members.length) return undefined;
    for (const [i, pattern] of callee.members.entries()) {
      if (!whole(pattern).test(shape.members[i] ?? "")) return undefined;
    }
    if (callee.fileImports && !imports.has(callee.fileImports)) return undefined;
    const root = shape.root;
    if (callee.receiver === "any") return { factory: undefined };
    if (!ts.isIdentifier(root)) return undefined;
    if (callee.global !== undefined) {
      if (root.text !== callee.global) return undefined;
      return resolveSymbol(this.program, root).target.kind === "global" ? { factory: undefined } : undefined;
    }
    if (callee.name !== undefined) return whole(callee.name).test(root.text) ? { factory: undefined } : undefined;
    if (callee.module !== undefined) {
      const origin = importOrigin(this.program, root);
      const wanted = callee.export ?? "default";
      if (!origin || origin.module !== callee.module) return undefined;
      return origin.name === wanted || (wanted === "default" && origin.name === "*") ? { factory: undefined } : undefined;
    }
    if (callee.instance !== undefined) {
      const factory = this.rules.factories.get(callee.instance);
      return factory ? this.instanceOf(root, factory) : undefined;
    }
    return undefined;
  }

  /** Follows a root identifier through constants and imports to the factory call that created it. */
  private instanceOf(root: ts.Identifier, factory: Factory): { factory: RawSite["factory"] } | undefined {
    const hops: Hop[] = [];
    let id: ts.Identifier = root;
    for (let step = 0; step < 8; step++) {
      const r = resolveSymbol(this.program, id);
      hops.push(...r.hops);
      const t = r.target;
      if (t.kind !== "binding" || t.binding.kind !== "var" || !t.binding.decl.initializer || t.binding.element) return undefined;
      hops.push({ kind: "const", at: this.program.where(t.binding.decl), name: t.binding.decl.name.getText() });
      let init = t.binding.decl.initializer;
      while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isIdentifier(init)) {
        id = init;
        continue;
      }
      if (!ts.isCallExpression(init) && !ts.isNewExpression(init)) return undefined;
      const shape = shapeOf(init.expression);
      if (!shape || !this.calleeMatches(factory.callee, init, shape, fileImports(init.getSourceFile()))) return undefined;
      const values: Record<string, AbstractValue> = {};
      for (const [name, specs] of Object.entries(factory.values)) {
        const v = this.spec(specs, init, shape.members, undefined, NO_PARAMS);
        if (v) values[name] = v;
      }
      return { factory: { values, hops } };
    }
    return undefined;
  }

  /**
   * Evaluates a binding's value specs on a call. `params` binds the
   * parameters of enclosing wrappers when the site is being lifted.
   */
  values(node: CallNode, binding: Binding, members: string[], factory: RawSite["factory"], params: ParamEnv): RawSite | undefined {
    let address = this.spec(binding.address, node, members, factory, params);
    if (!address) return undefined;
    if (binding.base) {
      const base = this.spec(binding.base, node, members, factory, params);
      if (base) address = joinUrl(base, address);
    }
    if (factory) address = factory.hops.reduceRight((v, h) => withHop(v, h), address);
    let method: AbstractValue | null = null;
    if (binding.method) {
      method = this.spec(binding.method, node, members, factory, params) ?? null;
      const text = method ? literalOf(method) : undefined;
      if (method && text !== undefined) method = { parts: [{ k: "lit", v: text.toUpperCase() }], hops: method.hops };
    }
    return { node, binding, members, factory, address, method };
  }

  private spec(specs: ValueSpec[], node: CallNode, members: string[], factory: RawSite["factory"], params: ParamEnv): AbstractValue | undefined {
    const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    for (const s of specs) {
      if ("arg" in s) {
        const arg = args[s.arg];
        if (!arg || ts.isSpreadElement(arg)) continue;
        const v = s.key === undefined ? this.evaluator.evaluate(arg, params) : this.evaluator.property(arg, [s.key], params);
        if (v) return v;
        continue;
      }
      if ("member" in s) {
        const name = members.at(s.member);
        if (name !== undefined) return lit(name);
        continue;
      }
      if ("factory" in s) {
        const v = factory?.values[s.factory];
        if (v) return v;
        continue;
      }
      if ("value" in s) return lit(s.value);
      return lit(s.default);
    }
    return undefined;
  }
}

const wholeCache = new Map<string, RegExp>();

/** A pattern matched against a whole name. */
function whole(pattern: string): RegExp {
  let re = wholeCache.get(pattern);
  if (!re) {
    re = new RegExp(`^(?:${pattern})$`);
    wholeCache.set(pattern, re);
  }
  return re;
}

/** Module specifiers a file imports or requires. */
function fileImports(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)) out.add(s.moduleSpecifier.text);
  }
  const text = sf.text;
  for (const m of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) if (m[1]) out.add(m[1]);
  return out;
}
