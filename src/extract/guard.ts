import { ts } from "ts-morph";

/** The `if` conditions a call runs under, innermost last; `!(c)` for else branches. */
export function guardOf(node: ts.Node): string {
  const conditions: string[] = [];
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isIfStatement(p)) {
      const text = p.expression.getText().replace(/\s+/g, " ");
      if (n === p.thenStatement) conditions.unshift(text);
      else if (n === p.elseStatement) conditions.unshift(`!(${text})`);
    }
    if (ts.isSourceFile(p)) break;
  }
  return conditions.join(" && ");
}
