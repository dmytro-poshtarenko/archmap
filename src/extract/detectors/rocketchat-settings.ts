import { ts } from "ts-morph";
import type { AbstractValue } from "../../core/types.js";
import { lit } from "../value.js";
import type { DetectorContext, TableProvider } from "./types.js";

/**
 * Rocket.Chat settings and their defaults:
 * `settingsRegistry.add('Cloud_Url', 'https://cloud.rocket.chat', { type: 'string' })`,
 * also as `this.add(…)` inside `addGroup` and `section` callbacks. The options
 * object with a `type` tells a setting from any other `add`. Only literal keys
 * and defaults are kept.
 *
 * A deployment overrides a setting with `OVERWRITE_SETTING_<key>`; until it
 * does, the default is its value, so matching falls back to it.
 */
export const rocketchatSettings: TableProvider = {
  kind: "table",
  version: 1,
  table: "settings.defaults",
  build(ctx: DetectorContext): Map<string, AbstractValue> {
    const { program } = ctx;
    const table = new Map<string, AbstractValue>();
    for (const f of ctx.files) {
      const id = `${f.repo}:${f.path}`;
      if (!program.text(id).includes(".add(")) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "add") {
          const [key, value, options] = n.arguments;
          const k = key && textOf(key);
          const v = value && textOf(value);
          if (k !== undefined && v !== undefined && options && ts.isObjectLiteralExpression(options) && options.properties.some(isTypeProperty) && !table.has(k)) {
            table.set(k, lit(v));
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(program.source(id));
    }
    return table;
  },
};

function textOf(e: ts.Expression): string | undefined {
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : undefined;
}

function isTypeProperty(p: ts.ObjectLiteralElementLike): boolean {
  return ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type";
}
