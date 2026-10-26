import { type MapElement, type MapGraph, type MapRelation, OVERVIEW, SYSTEM } from "./graph.js";

/** A LikeC4 string literal. */
export function q(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ")}'`;
}

const SPECIFICATION = `specification {
  element system {
    style {
      color indigo
    }
  }
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
  relationship route {
    color secondary
    line dashed
  }

  tag rules
  tag infra
  tag llm
  tag ambiguous
  tag shared
  tag viaGateway
  tag overview
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
    ...(e.description ? [`${indent}  description ${q(e.description)}`] : []),
    ...metadata(e.metadata, `${indent}  `),
    ...own.flatMap((c) => element(c, children, all, `${indent}  `)),
  ];
  const head = `${indent}${e.name} = ${e.kind} ${q(e.title)}`;
  return body.length === 0 ? [head] : [`${head} {`, ...body, `${indent}}`];
}

function relation(r: MapRelation): string[] {
  const body = [
    ...(r.tags.length > 0 ? [`    ${r.tags.map((t) => `#${t}`).join(" ")}`] : []),
    ...(r.technology ? [`    technology ${q(r.technology)}`] : []),
    ...(r.description ? [`    description ${q(r.description)}`] : []),
    ...metadata(r.metadata, "    "),
    ...(r.bothWays ? ["    style {", "      tail normal", "    }"] : []),
  ];
  const head = `  ${r.source} -[${r.kind}]-> ${r.target} ${q(r.title)}`;
  return body.length === 0 ? [head] : [`${head} {`, ...body, "  }"];
}

/** How to read the arrows and tags, repeated on the views a developer opens first. */
export const LEGEND =
  "Each arrow names its protocol: HTTP, WebSocket (DDP), the broker's transport for RPC and events, the database's protocol. " +
  "On this view one arrow stands for every call between two containers; an arrow with two heads, calls both ways. " +
  "Arrows: http solid blue, ddp solid indigo, rpc (broker actions) dashed green, event dotted amber, db solid grey, trigger dotted red, route (a gateway's rules) dashed teal. " +
  "Tags: #rules, #infra or #llm say what decided a link; #viaGateway, the request passes the gateway; #ambiguous, several targets remain possible; #shared, a collection two or more parts use.";

/** The rows of the C2 view, top to bottom: who calls first, what is called last. */
const TIERS: Array<[string, Array<MapElement["kind"]>]> = [
  ["Clients", ["client"]],
  ["Gateway", ["gateway"]],
  ["Services", ["service", "scheduler"]],
  ["Message bus", ["bus"]],
  ["Database", ["database"]],
];

/** Beyond this many elements inside a part, its view lays them out top to bottom instead of in one long row. */
const WIDE = 12;

/** Title of a view of one part, at C4 level 3: what the part holds and who uses it. */
function partTitle(e: MapElement, filtered: boolean): string {
  if (e.kind === "database") return `C3: ${e.title} (${filtered ? "collections shared by several containers" : "collections and the containers using them"})`;
  return `C3: ${e.title} (API groups and their callers)`;
}

/**
 * The model and its views at the levels of the C4 model: C1, the system and
 * the external systems it calls; C2, the containers and the links between
 * them; C3, one view of each container with elements inside it.
 */
export function renderModel(graph: MapGraph, product: string, description: string): string {
  const top = graph.elements.filter((e) => e.parent === null);
  const lines = [SPECIFICATION, "model {", ...top.flatMap((e) => element(e, [], graph.elements, "  ")), "", ...graph.relations.flatMap(relation), "}", ""];
  const scoped = top.filter((e) => graph.elements.some((c) => c.parent === e.id));
  const externals = top.filter((e) => e.kind === "external");
  lines.push("views {");
  if (top.some((e) => e.id === SYSTEM && e.kind === "system")) {
    lines.push(
      "  view context {",
      `    title ${q(externals.length > 0 ? `C1: ${product} and the external systems it calls` : `C1: ${product} system context`)}`,
      `    description ${q(`${product} as one system and the systems outside it that its code calls, one per domain. ${externals.length > 0 ? "" : "The method found no calls outside the system."}`.trim())}`,
      `    include ${[SYSTEM, ...externals.map((e) => e.id)].join(", ")}`,
      "  }",
    );
  }
  lines.push(
    "  view index {",
    `    title ${q(`C2: ${product} containers and the links between them`)}`,
    `    description ${q(`${description} ${LEGEND}`)}`,
    ...TIERS.flatMap(([name, kinds]) => {
      const members = top.filter((e) => kinds.includes(e.kind));
      return members.length > 0 ? [`    group ${q(name)} {`, `      include ${members.map((e) => e.id).join(", ")}`, "    }"] : [];
    }),
    // the C2 view draws one arrow per pair of containers; the calls behind it are on the C3 views
    `    exclude * -> * where tag is not #${OVERVIEW}`,
    "    autoLayout TopBottom 140 70",
    "  }",
  );
  // the external systems on a C2 view of their own: their long arrows would cross the whole container view
  const callers = top.filter((e) => graph.relations.some((r) => r.tags.includes(OVERVIEW) && r.source === e.id && externals.some((x) => x.id === r.target)));
  if (externals.length > 0 && callers.length > 0) {
    lines.push(
      "  view external_systems {",
      `    title ${q(`C2: ${product} containers and the external systems they call`)}`,
      `    description ${q(`The containers whose code calls systems outside ${product}, and those systems, one per domain. Each arrow names its protocol and how many endpoints it reaches.`)}`,
      "    group 'Containers' {",
      `      include ${callers.map((e) => e.id).join(", ")}`,
      "    }",
      "    group 'External systems' {",
      `      include ${externals.map((e) => e.id).join(", ")}`,
      "    }",
      `    exclude * -> * where tag is not #${OVERVIEW}`,
      "    autoLayout LeftRight 160 40",
      "  }",
    );
  }
  for (const e of scoped) {
    const inside = graph.elements.filter((c) => c.parent === e.id);
    // a database with many collections shows the ones two or more parts share: the interaction through a shared database
    const hidden = e.kind === "database" && inside.length > WIDE ? inside.filter((c) => c.kind === "collection" && !c.tags.includes("shared")) : [];
    const shown = inside.length - hidden.length;
    const note = hidden.length > 0 ? ` This view shows the ${shown} collections two or more parts share; ${hidden.length} collections used by one part are left out.` : "";
    lines.push(
      `  view of_${e.name} of ${e.id} {`,
      `    title ${q(partTitle(e, hidden.length > 0))}`,
      `    description ${q(`${e.description ?? ""}${note}`.trim())}`,
      "    include *",
      `    exclude * -> * where tag is #${OVERVIEW}`,
      ...(hidden.length > 0 ? [`    exclude ${hidden.map((c) => c.id).join(", ")}`] : []),
      ...(shown > WIDE ? ["    autoLayout LeftRight"] : []),
      "  }",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}
