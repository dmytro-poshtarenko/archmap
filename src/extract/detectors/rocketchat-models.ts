import { ts } from "ts-morph";
import type { AbstractValue } from "../../core/types.js";
import type { Program } from "../program.js";
import { resolveSymbol } from "../scope.js";
import type { DetectorContext, TableProvider } from "./types.js";

/**
 * Rocket.Chat models: `registerModel('IUsersModel', new UsersRaw(db))` binds
 * the interface a model proxy is created for to a class, and the class (or the
 * class it extends) names its collection with `super(db, 'users')`. Collections
 * get the `rocketchat_` prefix unless the class keeps the name as is.
 */
export const rocketchatModels: TableProvider = {
  kind: "table",
  version: 2,
  table: "rocketchat.collections",
  build(ctx: DetectorContext): Map<string, AbstractValue> {
    const { program } = ctx;
    const table = new Map<string, AbstractValue>();
    for (const f of ctx.files) {
      const id = `${f.repo}:${f.path}`;
      if (!program.text(id).includes("registerModel(")) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "registerModel") {
          const [name, model] = n.arguments;
          const created = model && newExpressionOf(model);
          if (name && ts.isStringLiteral(name) && created && ts.isIdentifier(created.expression) && !table.has(name.text)) {
            const collection = collectionOf(program, created.expression, 0);
            if (collection) table.set(name.text, collection);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(program.source(id));
    }
    return table;
  },
};

function newExpressionOf(e: ts.Expression): ts.NewExpression | undefined {
  if (ts.isNewExpression(e)) return e;
  if (ts.isArrowFunction(e) && !ts.isBlock(e.body)) return newExpressionOf(e.body);
  return undefined;
}

/** The collection a model class stores in, following `extends` until a `super(db, 'name')`. */
function collectionOf(program: Program, className: ts.Identifier, depth: number): AbstractValue | undefined {
  if (depth > 5) return undefined;
  const r = resolveSymbol(program, className);
  if (r.target.kind !== "binding" || r.target.binding.kind !== "class") return undefined;
  const cls = r.target.binding.decl;
  let found: { name: string; node: ts.Node; keepsName: boolean } | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) {
      const second = n.arguments[1];
      if (second && ts.isStringLiteral(second)) {
        const keepsName = /collectionNameResolver\s*\(\s*(\w+)[^)]*\)\s*\{\s*return\s+\1\s*;?\s*\}/.test(n.getText());
        found = { name: second.text, node: n, keepsName };
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const member of cls.members) if (ts.isConstructorDeclaration(member)) visit(member);
  if (found) {
    const collection = found.keepsName ? found.name : `rocketchat_${found.name}`;
    return { parts: [{ k: "lit", v: collection }], hops: [{ kind: "const", at: program.where(found.node), name: cls.name?.text }] };
  }
  const base = cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  return base && ts.isIdentifier(base) ? collectionOf(program, base, depth + 1) : undefined;
}
