import { GATEWAY, type MapElement, type MapGraph, type MapRelation, NO_LINKS, OVERVIEW, SHARED_CODE, SYSTEM } from "./graph.js";

/** A LikeC4 string literal. */
export function q(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, " ")}'`;
}

/** A LikeC4 Markdown text: lines start at the left edge, or Markdown would read them as code. */
export function md(text: string): string {
  return `'''\n${text.replace(/'''/g, "’’’")}\n'''`;
}

/**
 * The notation: one colour per element type, and arrows that say by their
 * line whether a call waits for its answer, does not, or reads and writes
 * data. Each kind carries a `notation` text, which the viewer's legend shows.
 */
const SPECIFICATION = `specification {
  color c4-system #1E3A8A
  color c4-client #155E75
  color c4-service #1D4ED8
  color c4-component #0284C7
  color c4-jobs #92400E
  color c4-gateway #0F766E
  color c4-bus #6D28D9
  color c4-database #15803D
  color c4-collection #16A34A
  color c4-external #6B7280
  color c4-sync #1E40AF
  color c4-async #D97706
  color c4-data #475569
  color c4-shared #9CA3AF
  color c4-nolinks #CBD5E1

  element system {
    notation 'Software system'
    style {
      color c4-system
    }
  }
  element client {
    notation 'Client application (container)'
    style {
      shape browser
      color c4-client
    }
  }
  element service {
    notation 'Server-side container'
    style {
      color c4-service
    }
  }
  element gateway {
    notation 'Gateway (container)'
    style {
      color c4-gateway
    }
  }
  element bus {
    notation 'Message bus (container)'
    style {
      shape queue
      color c4-bus
    }
  }
  element database {
    notation 'Database (container)'
    style {
      shape storage
      color c4-database
    }
  }
  element scheduler {
    notation 'Scheduler (container)'
    style {
      color c4-jobs
    }
  }
  element external {
    notation 'External system'
    style {
      color c4-external
    }
  }
  element endpointGroup {
    notation 'API group (component): REST routes, DDP methods or subscriptions, broker actions'
    style {
      shape component
      color c4-component
    }
  }
  element collection {
    notation 'Collection (component)'
    style {
      shape cylinder
      color c4-collection
    }
  }
  element jobs {
    notation 'Scheduled jobs, run inside their container (component)'
    style {
      shape component
      color c4-jobs
    }
  }

  relationship http {
    notation 'Request and response: REST over HTTP'
    color c4-sync
    line solid
  }
  relationship ddp {
    notation 'Request and response: DDP method over WebSocket'
    color c4-sync
    line solid
  }
  relationship rpc {
    notation 'Request and response: broker action'
    color c4-sync
    line solid
  }
  relationship stream {
    notation 'Asynchronous: DDP subscription'
    color c4-async
    line dashed
  }
  relationship event {
    notation 'Asynchronous: broker event'
    color c4-async
    line dashed
  }
  relationship db {
    notation 'Database access'
    color c4-data
    line solid
  }
  relationship route {
    notation 'Gateway routing rule'
    color c4-gateway
    line dashed
  }

  tag rules
  tag infra
  tag llm
  tag ambiguous
  tag shared
  tag viaGateway
  tag ${OVERVIEW}
  tag ${GATEWAY}
  tag ${SHARED_CODE}
  tag ${NO_LINKS}
}
`;

/** How to read the arrows, in every view's description. */
export const KEY = [
  "**How to read it**",
  "- Solid blue arrow: request and response (REST over HTTP, a DDP method over WebSocket, a broker action).",
  "- Dashed amber arrow: asynchronous (a broker event, a DDP subscription).",
  "- Grey arrow: database access. Dotted grey: only shared code links the two, so which container makes the call is not known.",
  "- Under each label, in brackets: the protocol, and the gateway or container the traffic passes.",
  "- Light grey box: no links found for that container, or none of its code was read; the box says which.",
  "- Open an element or an arrow for the names behind it.",
].join("\n");

function metadata(m: Record<string, string>, indent: string): string[] {
  const entries = Object.entries(m).filter(([, v]) => v !== "");
  if (entries.length === 0) return [];
  return [`${indent}metadata {`, ...entries.map(([k, v]) => `${indent}  ${k} ${q(v)}`), `${indent}}`];
}

/** A mobile app is drawn as a phone, whatever its kind. */
const MOBILE = /react native|flutter|android|ios|swiftui|kotlin multiplatform/i;

function element(e: MapElement, all: MapElement[], indent: string): string[] {
  const own = all.filter((x) => x.parent === e.id);
  const style = [
    // opacity and border style apply only to a box drawn open, with elements inside; a colour shows on any box
    ...(e.tags.includes(NO_LINKS) ? ["color c4-nolinks"] : []),
    ...(e.technology && MOBILE.test(e.technology) ? ["shape mobile"] : []),
  ];
  const body = [
    ...(e.tags.length > 0 ? [`${indent}  ${e.tags.map((t) => `#${t}`).join(" ")}`] : []),
    ...(e.technology ? [`${indent}  technology ${q(e.technology)}`] : []),
    ...(e.summary ? [`${indent}  summary ${q(e.summary)}`] : []),
    ...(e.description ? [`${indent}  description ${q(e.description)}`] : []),
    ...metadata(e.metadata, `${indent}  `),
    ...(style.length > 0 ? [`${indent}  style {`, ...style.map((x) => `${indent}    ${x}`), `${indent}  }`] : []),
    ...own.flatMap((c) => element(c, all, `${indent}  `)),
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
    ...(r.tags.includes(SHARED_CODE) ? ["    style {", "      line dotted", "      color c4-shared", "    }"] : []),
  ];
  const head = `  ${r.source} -[${r.kind}]-> ${r.target} ${q(r.title)}`;
  return body.length === 0 ? [head] : [`${head} {`, ...body, "  }"];
}

/** Beyond this many elements inside a part, its view lays them out top to bottom instead of in one long row. */
const WIDE = 12;

/** Containers the C2 view draws: what runs code or holds data, not the gateway, the bus or systems outside. */
const C2_KINDS: Array<MapElement["kind"]> = ["client", "service", "database", "scheduler"];

/** Title of a view of one part, at C4 level 3: what the part holds and who uses it. */
function partTitle(e: MapElement, filtered: boolean): string {
  if (e.kind === "database") return `C3: ${e.title} (${filtered ? "collections shared by several containers" : "collections and the containers using them"})`;
  return `C3: ${e.title} (API groups and their callers)`;
}

/**
 * The model and its views at the levels of the C4 model:
 * - C1, the system and the external systems it calls;
 * - C2, the containers and how they call each other, the containers that call
 *   outside the system, each gateway's routing and each bus's events;
 * - C3, one view of each container with elements inside it.
 */
export function renderModel(graph: MapGraph, product: string, description: string): string {
  const top = graph.elements.filter((e) => e.parent === null);
  const lines = [SPECIFICATION, "model {", ...top.flatMap((e) => element(e, graph.elements, "  ")), "", ...graph.relations.flatMap(relation), "}", ""];
  const scoped = top.filter((e) => graph.elements.some((c) => c.parent === e.id));
  const externals = top.filter((e) => e.kind === "external");
  const ids = (es: MapElement[]) => es.map((e) => e.id).join(", ");
  const has = (tag: string, pred: (r: MapRelation) => boolean) => graph.relations.some((r) => r.tags.includes(tag) && pred(r));
  lines.push("views {");
  if (top.some((e) => e.id === SYSTEM && e.kind === "system")) {
    lines.push(
      "  view context {",
      `    title ${q(externals.length > 0 ? `C1: ${product} and the external systems it calls` : `C1: ${product} system context`)}`,
      `    description ${md(`${product} as one system and the systems outside it that its code calls, one per domain.${externals.length > 0 ? "" : " The method found no calls outside the system."} Each arrow counts the endpoints reached.\n\n${KEY}`)}`,
      `    include ${ids([...top.filter((e) => e.id === SYSTEM), ...externals])}`,
      "  }",
    );
  }
  const containers = top.filter((e) => C2_KINDS.includes(e.kind));
  const clients = containers.filter((e) => e.kind === "client");
  const databases = containers.filter((e) => e.kind === "database");
  const offView = top.filter((e) => e.kind === "gateway" || e.kind === "bus").map((e) => e.title);
  lines.push(
    "  view index {",
    `    title ${q(`C2: ${product} containers and the links between them`)}`,
    `    description ${md(
      `${description}\n\nOne arrow per direction stands for every call between two containers: what flows, and by which protocol.${offView.length > 0 ? ` ${offView.join(" and ")} ${offView.length === 1 ? "has its" : "have their"} own view${offView.length === 1 ? "" : "s"}; here the arrows name what they pass through.` : ""} External systems are on a C2 view of their own.\n\n${KEY}`,
    )}`,
    `    include ${ids(containers)}`,
    ...(clients.length > 0 ? ["    rank source {", `      ${ids(clients)}`, "    }"] : []),
    ...(databases.length > 0 ? ["    rank sink {", `      ${ids(databases)}`, "    }"] : []),
    // the C2 view draws one arrow per direction between containers; the calls behind it are on the C3 views
    `    exclude * -> * where tag is not #${OVERVIEW}`,
    "    autoLayout TopBottom 160 100",
    "  }",
  );
  // the external systems on a C2 view of their own: their long arrows would cross the whole container view
  const callers = top.filter((e) => has(OVERVIEW, (r) => r.source === e.id && externals.some((x) => x.id === r.target)));
  if (externals.length > 0 && callers.length > 0) {
    lines.push(
      "  view external_systems {",
      `    title ${q(`C2: ${product} containers and the external systems they call`)}`,
      `    description ${md(`The containers whose code calls systems outside ${product}, and those systems, one per domain. Each arrow names the endpoints reached and the protocol.\n\n${KEY}`)}`,
      "    group 'Containers' {",
      `      include ${ids(callers)}`,
      "    }",
      "    group 'External systems' {",
      `      include ${ids(externals)}`,
      "    }",
      `    exclude * -> * where tag is not #${OVERVIEW}`,
      "    autoLayout LeftRight 160 40",
      "  }",
    );
  }
  for (const g of top.filter((e) => e.kind === "gateway" && has(GATEWAY, (r) => r.source === e.id || r.target === e.id))) {
    const ends = top.filter((e) => e.id !== g.id && has(GATEWAY, (r) => (r.source === g.id && r.target === e.id) || (r.target === g.id && r.source === e.id)));
    lines.push(
      `  view gateway_${g.name} {`,
      `    title ${q(`C2: ${product} requests through ${g.title} (routing rules)`)}`,
      `    description ${md(`Who sends requests through ${g.title}, and where its rules send them by path. The other views draw these calls straight to the container that serves them, marked "via ${g.title}".\n\n${KEY}`)}`,
      `    include ${ids([g, ...ends])}`,
      `    exclude * -> * where tag is not #${GATEWAY}`,
      "    autoLayout LeftRight 160 60",
      "  }",
    );
  }
  for (const b of top.filter((e) => e.kind === "bus" && graph.relations.some((r) => r.kind === "event" && (r.source === e.id || r.target === e.id)))) {
    const ends = top.filter((e) => e.id !== b.id && graph.relations.some((r) => r.kind === "event" && !r.tags.includes(OVERVIEW) && ((r.source === b.id && r.target === e.id) || (r.target === b.id && r.source === e.id))));
    lines.push(
      `  view bus_${b.name} {`,
      `    title ${q(`C2: ${product} events through ${b.title} (publishers and subscribers)`)}`,
      `    description ${md(`Which containers publish events to ${b.title} and which receive them. The C2 container view draws the same events straight from publisher to subscriber.\n\n${KEY}`)}`,
      `    include ${ids([b, ...ends])}`,
      `    exclude * -> * where tag is #${OVERVIEW}`,
      `    exclude * -> * where kind is not event`,
      "    autoLayout TopBottom 120 60",
      "  }",
    );
  }
  for (const e of scoped) {
    const inside = graph.elements.filter((c) => c.parent === e.id);
    // a database with many collections shows the ones two or more parts share: the interaction through a shared database
    const hidden = e.kind === "database" && inside.length > WIDE ? inside.filter((c) => c.kind === "collection" && !c.tags.includes("shared")) : [];
    const shown = inside.length - hidden.length;
    const note = hidden.length > 0 ? `\n\nThis view shows the ${shown} collections two or more containers share; ${hidden.length} collections used by one container are left out.` : "";
    lines.push(
      `  view of_${e.name} of ${e.id} {`,
      `    title ${q(partTitle(e, hidden.length > 0))}`,
      `    description ${md(`${e.description ?? ""}${note}\n\n${KEY}`)}`,
      "    include *",
      `    exclude * -> * where tag is #${OVERVIEW}`,
      `    exclude * -> * where tag is #${GATEWAY}`,
      ...(hidden.length > 0 ? [`    exclude ${ids(hidden)}`] : []),
      ...(shown > WIDE ? ["    autoLayout LeftRight"] : []),
      "  }",
    );
  }
  lines.push("}", "");
  return lines.join("\n");
}
