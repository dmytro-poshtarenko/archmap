/**
 * A call the rule packs know to read the environment, e.g. Rocket.Chat's
 * `isRunningMs()`, which is true when `TRANSPORTER` names NATS or TCP.
 */
export interface GuardSwitch {
  call: string;
  env: string;
  pattern: string;
}

/**
 * Evaluates the condition a service registration runs under (`!isRunningMs()`,
 * `!process.env.USE_EXTERNAL_ABAC_SERVICE`, combined with `&&`, `||` and `!`)
 * against an environment. Three-valued: `null` when the condition depends on
 * something other than the environment, or when no environment is known.
 */
export function evaluateGuard(guard: string, env: Record<string, string> | null, switches: GuardSwitch[]): boolean | null {
  if (guard.trim() === "") return true;
  const tokens = tokenize(guard);
  let at = 0;
  const peek = () => tokens[at];
  const or = (): boolean | null => {
    let value = and();
    while (peek() === "||") {
      at++;
      const right = and();
      value = value === true || right === true ? true : value === null || right === null ? null : false;
    }
    return value;
  };
  const and = (): boolean | null => {
    let value = not();
    while (peek() === "&&") {
      at++;
      const right = not();
      value = value === false || right === false ? false : value === null || right === null ? null : true;
    }
    return value;
  };
  const not = (): boolean | null => {
    if (peek() === "!") {
      at++;
      const value = not();
      return value === null ? null : !value;
    }
    if (peek() === "(") {
      at++;
      const value = or();
      if (peek() === ")") at++;
      return value;
    }
    const atom = tokens[at++] ?? "";
    return atomValue(atom, env, switches);
  };
  const value = or();
  return at === tokens.length ? value : null;
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let atom = "";
  const flush = () => {
    if (atom.trim() !== "") out.push(atom.trim());
    atom = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const two = text.slice(i, i + 2);
    if (depth === 0 && (two === "&&" || two === "||")) {
      flush();
      out.push(two);
      i++;
    } else if (depth === 0 && c === "!" && atom.trim() === "" && text[i + 1] !== "=") {
      flush();
      out.push("!");
    } else if (depth === 0 && c === "(" && atom.trim() === "") {
      flush();
      out.push("(");
    } else if (depth === 0 && c === ")") {
      flush();
      out.push(")");
    } else {
      // parentheses of a call stay inside its atom: `isRunningMs()`
      if (c === "(") depth++;
      if (c === ")") depth--;
      atom += c;
    }
  }
  flush();
  return out;
}

function atomValue(atom: string, env: Record<string, string> | null, switches: GuardSwitch[]): boolean | null {
  const compact = atom.replace(/\s+/g, "");
  const sw = switches.find((s) => s.call.replace(/\s+/g, "") === compact);
  if (sw) return env === null ? null : new RegExp(sw.pattern).test(env[sw.env] ?? "");
  const read = /^process\.env(?:\.(\w+)|\[["'](\w+)["']\])$/.exec(compact);
  if (read) return env === null ? null : (env[(read[1] ?? read[2]) as string] ?? "") !== "";
  const compare = /^process\.env(?:\.(\w+)|\[["'](\w+)["']\])(===|!==|==|!=)["']([^"']*)["']$/.exec(compact);
  if (compare) {
    if (env === null) return null;
    const equal = (env[(compare[1] ?? compare[2]) as string] ?? undefined) === compare[4];
    return compare[3]?.startsWith("!") ? !equal : equal;
  }
  if (compact === "true") return true;
  if (compact === "false") return false;
  return null;
}
