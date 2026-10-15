import { ts } from "ts-morph";
import type { AbstractValue, Hop } from "../core/types.js";
import type { Program } from "./program.js";
import { bindingOf, elementProperty, isReassigned, resolveExport, resolveSymbol, type Resolved } from "./scope.js";
import { alts, concat, dyn, env, isUnknown, joinUrl, lit, literalOf, setting, unknown, withHop } from "./value.js";

/** A caller's argument bound to a parameter while a wrapper is evaluated or a site lifted. */
export interface ParamArg {
  expr: ts.Expression | undefined;
  env: ParamEnv;
}
export type ParamEnv = ReadonlyMap<ts.ParameterDeclaration, ParamArg>;
export const NO_PARAMS: ParamEnv = new Map();

/** A call that yields a setting or an environment value, e.g. `settings.get('Site_Url')`. */
export interface ValueSource {
  /** Text of the callee, e.g. `settings.get`. */
  callee: string;
  kind: "setting" | "env";
  /** Argument holding the key. */
  arg: number;
}

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/**
 * Abstract evaluation of addresses and names without the type checker:
 * literals, templates, concatenation, constants, object properties, enums,
 * imports and re-exports, environment variables and settings, `new URL`,
 * and calls of small functions, which are inlined with their arguments.
 * Every declaration followed is recorded as a hop.
 */
export class Evaluator {
  private readonly stack = new Set<string>();

  constructor(
    private readonly program: Program,
    private readonly opts: { maxDepth: number; valueSources: ValueSource[] },
  ) {}

  evaluate(expr: ts.Expression, params: ParamEnv = NO_PARAMS, depth = 0): AbstractValue {
    if (depth > this.opts.maxDepth) return unknown("too deep");
    const id = this.program.nodeId(expr);
    if (this.stack.has(id)) return unknown("cycle");
    this.stack.add(id);
    try {
      return this.evaluateNode(expr, params, depth);
    } finally {
      this.stack.delete(id);
    }
  }

  private evaluateNode(expr: ts.Expression, params: ParamEnv, depth: number): AbstractValue {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return lit(expr.text);
    if (ts.isNumericLiteral(expr)) return lit(expr.text);
    if (ts.isTemplateExpression(expr)) {
      return concat(
        lit(expr.head.text),
        ...expr.templateSpans.flatMap((s) => [this.evaluate(s.expression, params, depth + 1), lit(s.literal.text)]),
      );
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) ||
      ts.isNonNullExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isAwaitExpression(expr)
    ) {
      return this.evaluate(expr.expression, params, depth);
    }
    if (ts.isBinaryExpression(expr)) {
      const op = expr.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        return concat(this.evaluate(expr.left, params, depth + 1), this.evaluate(expr.right, params, depth + 1));
      }
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        return alts([this.evaluate(expr.left, params, depth + 1), this.evaluate(expr.right, params, depth + 1)]);
      }
      return dyn(ts.SyntaxKind[op]);
    }
    if (ts.isConditionalExpression(expr)) {
      return alts([this.evaluate(expr.whenTrue, params, depth + 1), this.evaluate(expr.whenFalse, params, depth + 1)]);
    }
    if (ts.isIdentifier(expr)) return this.identifier(expr, params, depth);
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return this.member(expr, params, depth);
    if (ts.isCallExpression(expr)) return this.call(expr, params, depth);
    if (ts.isNewExpression(expr)) return this.construct(expr, params, depth);
    return unknown(ts.SyntaxKind[expr.kind]);
  }

  private identifier(id: ts.Identifier, params: ParamEnv, depth: number): AbstractValue {
    if (id.text === "undefined") return unknown("undefined");
    const binding = bindingOf(id);
    if (binding.kind === "param") return this.param(binding, [], params, depth);
    return this.fromResolved(resolveSymbol(this.program, id), params, depth);
  }

  private param(
    binding: Extract<ReturnType<typeof bindingOf>, { kind: "param" }>,
    path: string[],
    params: ParamEnv,
    depth: number,
  ): AbstractValue {
    // A destructured parameter (`function f({ url })`) reads a property of the argument.
    const full = [...(binding.element ? [elementProperty(binding.element) ?? "?"] : []), ...path];
    const bound = params.get(binding.decl);
    if (bound) {
      if (!bound.expr) {
        if (binding.decl.initializer && full.length === 0) return this.evaluate(binding.decl.initializer, params, depth + 1);
        return unknown("missing argument");
      }
      if (full.length === 0) return this.evaluate(bound.expr, bound.env, depth + 1);
      return this.property(bound.expr, full, bound.env, depth + 1) ?? unknown("missing property");
    }
    const name = ts.isIdentifier(binding.decl.name) ? binding.decl.name.text : `arg${binding.index}`;
    return { parts: [{ k: "param", fn: this.program.nodeId(binding.fn), index: binding.index, name, path: full }], hops: [] };
  }

  private fromResolved(r: Resolved, params: ParamEnv, depth: number): AbstractValue {
    const t = r.target;
    let value: AbstractValue;
    if (t.kind === "binding") value = this.declared(t.binding, params, depth);
    else if (t.kind === "expr") value = this.evaluate(t.expr, NO_PARAMS, depth + 1);
    else if (t.kind === "external") value = unknown(`external ${t.module}`);
    else if (t.kind === "global") value = unknown(`global ${t.name}`);
    else value = unknown(t.kind);
    if (isUnknown(value)) return value;
    return r.hops.reduceRight((v, hop) => withHop(v, hop), value);
  }

  private declared(binding: Extract<Resolved["target"], { kind: "binding" }>["binding"], params: ParamEnv, depth: number): AbstractValue {
    if (binding.kind === "var") {
      const { decl, element } = binding;
      if (!decl.initializer) return unknown("no initializer");
      if (!binding.constant && isReassigned(decl)) return dyn("reassigned");
      const hop: Hop = { kind: "const", at: this.program.where(decl), name: decl.name.getText() };
      if (element) {
        const prop = elementProperty(element);
        const value = prop ? this.property(decl.initializer, [prop], NO_PARAMS, depth + 1) : undefined;
        return value ? withHop(value, hop) : unknown("destructuring");
      }
      return withHop(this.evaluate(decl.initializer, NO_PARAMS, depth + 1), hop);
    }
    if (binding.kind === "param") return this.param(binding, [], params, depth);
    return unknown(binding.kind);
  }

  private member(expr: ts.PropertyAccessExpression | ts.ElementAccessExpression, params: ParamEnv, depth: number): AbstractValue {
    const chain = memberChain(expr);
    if (chain) {
      const text = chain.join(".");
      const envKey = /^(?:process\.env|import\.meta\.env)\.(.+)$/.exec(text)?.[1];
      if (envKey) return env(envKey);
      const settingKey = /^Meteor\.settings\.(.+)$/.exec(text)?.[1];
      if (settingKey) return setting(settingKey);
    }
    const name = memberName(expr);
    if (name === undefined) return dyn("computed member");
    if (name === "href" || name === "toString") return this.evaluate(expr.expression, params, depth + 1);
    return this.property(expr.expression, [name], params, depth + 1) ?? unknown(`no property ${name}`);
  }

  /**
   * The value of `expr.path…`, or undefined when the property does not exist
   * (so that a value spec can fall back to its next alternative).
   */
  property(expr: ts.Expression, path: string[], params: ParamEnv = NO_PARAMS, depth = 0): AbstractValue | undefined {
    if (path.length === 0) return this.evaluate(expr, params, depth);
    if (depth > this.opts.maxDepth) return unknown("too deep");
    const [head, ...rest] = path as [string, ...string[]];
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
      return this.property(expr.expression, path, params, depth);
    }
    if (ts.isObjectLiteralExpression(expr)) {
      for (const p of [...expr.properties].reverse()) {
        if (ts.isPropertyAssignment(p) && propertyNameText(p.name) === head) return this.property(p.initializer, rest, params, depth + 1);
        if (ts.isShorthandPropertyAssignment(p) && p.name.text === head) return this.property(p.name, rest, params, depth + 1);
        if (ts.isSpreadAssignment(p)) {
          const inner = this.property(p.expression, path, params, depth + 1);
          if (inner !== undefined) return inner;
        }
      }
      return undefined;
    }
    if (ts.isIdentifier(expr)) {
      const binding = bindingOf(expr);
      if (binding.kind === "param") {
        const bound = params.get(binding.decl);
        if (bound && !bound.expr) return undefined;
        return this.param(binding, path, params, depth);
      }
      const r = resolveSymbol(this.program, expr);
      const t = r.target;
      if (t.kind === "binding" && t.binding.kind === "var" && t.binding.decl.initializer && !t.binding.element) {
        const hop: Hop = { kind: "const", at: this.program.where(t.binding.decl), name: expr.text };
        const inner = this.property(t.binding.decl.initializer, path, NO_PARAMS, depth + 1);
        return inner && r.hops.concat(hop).reduceRight((v, h) => withHop(v, h), inner);
      }
      if (t.kind === "binding" && t.binding.kind === "enum") {
        const member = t.binding.decl.members.find((m) => propertyNameText(m.name) === head);
        if (!member?.initializer) return undefined;
        const hop: Hop = { kind: "const", at: this.program.where(t.binding.decl), name: `${expr.text}.${head}` };
        return withHop(this.evaluate(member.initializer, NO_PARAMS, depth + 1), hop);
      }
      if (t.kind === "namespace") {
        const exported = resolveExport(this.program, t.fileId, head, new Set());
        const value = rest.length === 0 ? this.fromResolved(exported, NO_PARAMS, depth + 1) : undefined;
        if (value) return r.hops.reduceRight((v, h) => withHop(v, h), value);
        if (exported.target.kind === "binding" && exported.target.binding.kind === "var" && exported.target.binding.decl.initializer) {
          return this.property(exported.target.binding.decl.initializer, rest, NO_PARAMS, depth + 1);
        }
        return undefined;
      }
      if (t.kind === "expr") return this.property(t.expr, path, NO_PARAMS, depth + 1);
      return unknown(`property of ${t.kind}`);
    }
    if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
      const name = memberName(expr);
      if (name === undefined) return dyn("computed member");
      return this.property(expr.expression, [name, ...path], params, depth + 1);
    }
    return unknown("property of an expression");
  }

  private call(expr: ts.CallExpression, params: ParamEnv, depth: number): AbstractValue {
    const callee = expr.expression;
    const calleeText = memberChain(callee)?.join(".");
    const arg = (i: number) => expr.arguments[i];
    const ev = (e: ts.Expression | undefined) => (e ? this.evaluate(e, params, depth + 1) : unknown("missing argument"));

    for (const source of this.opts.valueSources) {
      if (calleeText === source.callee || calleeText?.endsWith(`.${source.callee}`)) {
        const key = literalOf(ev(arg(source.arg)));
        if (key !== undefined) return source.kind === "env" ? env(key) : setting(key);
        return dyn(`${source.kind} with a computed key`);
      }
    }
    if (calleeText === "encodeURIComponent" || calleeText === "encodeURI" || calleeText === "String") {
      const value = ev(arg(0));
      const text = literalOf(value);
      if (text !== undefined && calleeText !== "String") return lit(calleeText === "encodeURI" ? encodeURI(text) : encodeURIComponent(text));
      return value;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (method === "toString" || method === "trim" || method === "valueOf") return this.evaluate(callee.expression, params, depth + 1);
      if (method === "concat") return concat(this.evaluate(callee.expression, params, depth + 1), ...expr.arguments.map(ev));
      if (method === "join" && ts.isArrayLiteralExpression(callee.expression)) {
        const sep = expr.arguments[0] ? ev(expr.arguments[0]) : lit(",");
        const items = callee.expression.elements.map((e) => this.evaluate(e, params, depth + 1));
        return concat(...items.flatMap((v, i) => (i === 0 ? [v] : [sep, v])));
      }
      if (method === "join" && /^(?:path|posix|path\.posix)$/.test(memberChain(callee.expression)?.join(".") ?? "")) {
        const items = expr.arguments.map(ev);
        return items.slice(1).reduce((acc, v) => joinUrl(acc, v), items[0] ?? lit(""));
      }
    }
    const fn = this.functionOf(callee);
    if (fn) {
      const { node, hops } = fn;
      const bound = new Map<ts.ParameterDeclaration, ParamArg>();
      node.parameters.forEach((p, i) => bound.set(p, { expr: expr.arguments[i], env: params }));
      const result = this.returnValue(node, bound, depth + 1);
      if (isUnknown(result)) return result;
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : calleeText;
      return [...hops, { kind: "wrapper" as const, at: this.program.where(node), name }].reduceRight((v, h) => withHop(v, h), result);
    }
    return unknown(`call ${calleeText ?? "expression"}`);
  }

  private construct(expr: ts.NewExpression, params: ParamEnv, depth: number): AbstractValue {
    const name = memberChain(expr.expression)?.join(".");
    if (name === "URL" && expr.arguments?.[0]) {
      const path = this.evaluate(expr.arguments[0], params, depth + 1);
      const base = expr.arguments[1];
      if (!base) return path;
      return joinUrl(origin(this.evaluate(base, params, depth + 1), path), path);
    }
    return unknown(`new ${name ?? "expression"}`);
  }

  /** The function a callee names, if it is small enough to evaluate: its returns are the value. */
  functionOf(callee: ts.Expression): { node: Fn; hops: Hop[] } | undefined {
    if (ts.isIdentifier(callee)) {
      const r = resolveSymbol(this.program, callee);
      const t = r.target;
      if (t.kind === "binding" && t.binding.kind === "function") return { node: t.binding.decl, hops: r.hops };
      if (t.kind === "binding" && t.binding.kind === "var" && t.binding.decl.initializer && !t.binding.element) {
        const init = unwrap(t.binding.decl.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { node: init, hops: r.hops };
      }
      if (t.kind === "expr") {
        const init = unwrap(t.expr);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { node: init, hops: r.hops };
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const r = resolveSymbol(this.program, callee.expression);
      const t = r.target;
      const obj = t.kind === "binding" && t.binding.kind === "var" && !t.binding.element ? t.binding.decl.initializer : undefined;
      const literal = obj ? unwrap(obj) : undefined;
      if (literal && ts.isObjectLiteralExpression(literal)) {
        for (const p of literal.properties) {
          if (ts.isMethodDeclaration(p) && propertyNameText(p.name) === callee.name.text) return { node: p, hops: r.hops };
          if (ts.isPropertyAssignment(p) && propertyNameText(p.name) === callee.name.text) {
            const init = unwrap(p.initializer);
            if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { node: init, hops: r.hops };
          }
        }
      }
      if (t.kind === "namespace") {
        const exported = resolveExport(this.program, t.fileId, callee.name.text, new Set());
        const et = exported.target;
        if (et.kind === "binding" && et.binding.kind === "function") return { node: et.binding.decl, hops: [...r.hops, ...exported.hops] };
        if (et.kind === "binding" && et.binding.kind === "var" && et.binding.decl.initializer) {
          const init = unwrap(et.binding.decl.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { node: init, hops: [...r.hops, ...exported.hops] };
        }
      }
    }
    return undefined;
  }

  private returnValue(fn: Fn, params: ParamEnv, depth: number): AbstractValue {
    if (!fn.body) return unknown("no body");
    if (!ts.isBlock(fn.body)) return this.evaluate(fn.body, params, depth);
    const returns: ts.Expression[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isFunctionLike(n) && n !== fn) return;
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    if (returns.length === 0) return unknown("no return value");
    return alts(returns.map((r) => this.evaluate(r, params, depth)));
  }
}

/** The origin a URL is resolved against: `new URL('/x', base)` keeps only the base's origin. */
function origin(base: AbstractValue, path: AbstractValue): AbstractValue {
  const first = path.parts[0];
  if (!(first?.k === "lit" && first.v.startsWith("/"))) return base;
  const head = base.parts[0];
  if (head?.k === "lit") {
    const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(head.v);
    return m ? { parts: [{ k: "lit", v: m[0] }], hops: base.hops } : { parts: [], hops: base.hops };
  }
  return { parts: head ? [head] : [], hops: base.hops };
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** `a.b.c` or `a['b'].c` as names; undefined when some member is computed. */
export function memberChain(expr: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isMetaProperty(expr)) return [expr.getText()];
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const name = memberName(expr);
    const left = memberChain(expr.expression);
    return name !== undefined && left ? [...left, name] : undefined;
  }
  if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr) || ts.isAsExpression(expr)) return memberChain(expr.expression);
  return undefined;
}

export function memberName(expr: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  const arg = expr.argumentExpression;
  return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isNumericLiteral(arg) ? arg.text : undefined;
}

export function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
}
