import type { MapElement, MapGraph, MapRelation } from "./graph.js";

/** A LikeC4 string literal. */
export function q(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ")}'`;
}

const SPECIFICATION = `specification {
  element client {
    style {
      shape browser
      color sky
    }
  }
  element service {
    style {
      color primary
    }
  }
  element gateway {
    style {
      color secondary
    }
  }
  element bus {
    style {
      shape queue
      color green
    }
  }
  element database {
    style {
      shape storage
      color slate
    }
  }
  element collection {
    style {
      shape cylinder
      color gray
    }
  }
  element scheduler {
    style {
      color red
    }
  }
  element external {
    style {
      color muted
    }
  }
  element endpointGroup {
    style {
      color indigo
    }
  }

  relationship http {
    color blue
    line solid
  }
  relationship ddp {
    color indigo
    line solid
  }
  relationship rpc {
    color green
    line dashed
  }
  relationship event {
    color amber
    line dotted
  }
  relationship db {
    color gray
    line solid
  }
  relationship trigger {
    color red
    line dotted
  }

  tag rules
  tag infra
  tag llm
  tag ambiguous
  tag shared
  tag viaGateway
}
`;

function metadata(m: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(m).filter(([, v]) => v !== "");
  if (entries.length === 0) return [];
  return [`${indent}metadata {`, ...entries.map(([k, v]) => `${indent}  ${k} ${q(v)}`), `${indent}}`];
}

function element(e: MapElement, children: MapElement[], all: MapElement[], indent: string): string[] {
  const own = all.filter((x) => x.parent === e.id);
  const body = [
    ...(e.tags.length > 0 ? [`${indent}  ${e.tags.map((t) => `#${t}`).join(" ")}`] : []),
    ...metadata(e.metadata, `${indent}  `),
    ...own.flatMap((c) => element(c, children, all, `${indent}  `)),
  ];
  const head = `${indent}${e.name} = ${e.kind} ${q(e.title)}`;
  return body.length === 0 ? [head] : [`${head} {`, ...body, `${indent}}`];
}

function relation(r: MapRelation): string[] {
  const body = [...(r.tags.length > 0 ? [`    ${r.tags.map((t) => `#${t}`).join(" ")}`] : []), ...metadata(r.metadata, "    ")];
  const head = `  ${r.source} -[${r.kind}]-> ${r.target} ${q(r.title)}`;
  return body.length === 0 ? [head] : [`${head} {`, ...body, "  }"];
}

/** The model and the standard views: the whole system, and one view of each part with elements inside it. */
export function renderModel(graph: MapGraph, title: string): string {
  const top = graph.elements.filter((e) => e.parent === null);
  const lines = [SPECIFICATION, "model {", ...top.flatMap((e) => element(e, [], graph.elements, "  ")), "", ...graph.relations.flatMap(relation), "}", ""];
  const scoped = top.filter((e) => graph.elements.some((c) => c.parent === e.id));
  lines.push("views {", "  view index {", `    title ${q(title)}`, "    include *", "  }");
  for (const e of scoped) lines.push(`  view of_${e.name} of ${e.id} {`, `    title ${q(e.title)}`, "    include *", "  }");
  lines.push("}", "");
  return lines.join("\n");
}
