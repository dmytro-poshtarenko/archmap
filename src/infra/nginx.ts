import type { GatewayRule } from "./model.js";

interface Directive {
  name: string;
  args: string[];
  block: Directive[] | null;
  line: number;
}

/** nginx configuration as a tree of directives. */
export function parseNginxConfig(text: string): Directive[] {
  const tokens: Array<{ t: string; line: number }> = [];
  let line = 1;
  for (let i = 0; i < text.length; ) {
    const c = text[i] as string;
    if (c === "\n") line++;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "{" || c === "}" || c === ";") {
      tokens.push({ t: c, line });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j++;
      tokens.push({ t: text.slice(i + 1, j), line });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s{};]/.test(text[j] as string)) j++;
    tokens.push({ t: text.slice(i, j), line });
    i = j;
  }
  let pos = 0;
  const block = (): Directive[] => {
    const out: Directive[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos] as { t: string; line: number };
      if (tok.t === "}") {
        pos++;
        return out;
      }
      const words: string[] = [];
      const start = tok.line;
      while (pos < tokens.length && !["{", ";", "}"].includes((tokens[pos] as { t: string }).t)) words.push((tokens[pos++] as { t: string }).t);
      const end = tokens[pos]?.t;
      pos++;
      const [name = "", ...args] = words;
      if (end === "{") out.push({ name, args, block: block(), line: start });
      else out.push({ name, args, block: null, line: start });
    }
    return out;
  };
  return block();
}

/**
 * Gateway rules of nginx `location` blocks with `proxy_pass`, in nginx's own
 * order of precedence: exact (`=`), then the longest prefix marked `^~`, then
 * regular expressions in order, then the longest plain prefix. A `proxy_pass`
 * with a path replaces the matched prefix by that path.
 */
export function nginxRules(text: string, file: string, gateway: string): GatewayRule[] {
  const tree = parseNginxConfig(text);
  const upstreams = new Map<string, string>();
  const walk = (ds: Directive[], fn: (d: Directive) => void) => {
    for (const d of ds) {
      fn(d);
      if (d.block) walk(d.block, fn);
    }
  };
  walk(tree, (d) => {
    if (d.name === "upstream" && d.args[0] && d.block) {
      const server = d.block.find((x) => x.name === "server")?.args[0];
      if (server) upstreams.set(d.args[0], server.replace(/:\d+$/, ""));
    }
  });
  const out: GatewayRule[] = [];
  let regexIndex = 0;
  const visit = (ds: Directive[], host: string | null) => {
    for (const d of ds) {
      if (d.name === "server" && d.block) {
        const name = d.block.find((x) => x.name === "server_name")?.args[0] ?? null;
        visit(d.block, name && name !== "_" ? name : null);
        continue;
      }
      if (d.name === "location" && d.block) {
        const [first = "", second] = d.args;
        const modifier = second !== undefined ? first : "";
        const path = second !== undefined ? second : first;
        const pass = d.block.find((x) => x.name === "proxy_pass")?.args[0];
        const m = pass ? /^https?:\/\/([^/:]+)(?::\d+)?(\/[^\s]*)?$/.exec(pass) : null;
        if (m) {
          const target = upstreams.get(m[1] as string) ?? (m[1] as string);
          const uri = m[2] ?? null;
          const match = modifier === "=" ? "exact" : modifier.startsWith("~") ? "regex" : "prefix";
          const priority =
            modifier === "=" ? 4000 + path.length : modifier === "^~" ? 3000 + path.length : match === "regex" ? 2000 - regexIndex++ : 1000 + path.length;
          out.push({
            gateway,
            match,
            path,
            host,
            strip: uri !== null && match === "prefix" ? path : null,
            replace: uri !== null && match === "prefix" ? uri : null,
            target,
            priority,
            source: `${file}:${d.line}`,
          });
        }
        visit(d.block, host);
        continue;
      }
      if (d.block && d.name !== "upstream") visit(d.block, host);
    }
  };
  visit(tree, null);
  return out;
}
