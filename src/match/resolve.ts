import type { ComponentConfig, InteractionType } from "../config/schema.js";
import type { AbstractValue, CallSite, RouteDecl } from "../core/types.js";
import { type Container, type GatewayRule, hostOf, type InfraFacts } from "../infra/model.js";
import { type HttpAddress, httpForms, methodsOf, type SiteSegment } from "./address.js";
import { passGateway } from "./gateway.js";
import { evaluateGuard, type GuardSwitch } from "./guards.js";
import { compareScores, fitPath, type PathFit, type RoutePattern, routePattern } from "./routes.js";

/**
 * What the matching may use. The variants of the method switch whole sources
 * off; the classifier switches single kinds of evidence off to see which ones
 * a link needs.
 */
export interface Sources {
  /** Rule-based addresses of the call sites and route declarations found by rules. */
  rules: boolean;
  /** Route declarations extracted by the language model. */
  llmRoutes: boolean;
  /** The deployment's environment: container variables, the profile, service registration guards. */
  env: boolean;
  /** Gateway routing rules. */
  gateway: boolean;
}

export const ALL_SOURCES: Sources = { rules: true, llmRoutes: true, env: true, gateway: true };

/** Matching knowledge of the rule packs. */
export interface MatchingOptions {
  guards: GuardSwitch[];
  /** Fixed paths a transport uses, e.g. DDP over `/websocket`. */
  transports: Array<{ type: InteractionType; path: string }>;
}

export type Status = "linked" | "none" | "ambiguous" | "unresolved";

export interface Resolution {
  status: Status;
  /** Target key, when linked. */
  target: string | null;
  /** Declaration the target key comes from, when there is one. */
  route: string | null;
  component: string | null;
  /** `none`: external, intra, not-deployed; `unresolved` and `ambiguous`: why. */
  reason: string | null;
  /** Gateways the request passes. */
  via: string[];
  /** Target keys still possible, when ambiguous. */
  alternatives: string[];
  /** Whether a route declared by the rules fits the address in some component (evidence for case 5). */
  ruleRoute: boolean;
}

export interface ResolverInput {
  sites: CallSite[];
  routes: RouteDecl[];
  infra: InfraFacts;
  components: Array<Pick<ComponentConfig, "id" | "kind" | "aliases">>;
  /** Environment of the deployment profile (`infra.env`), under the containers' own. */
  profileEnv: Record<string, string>;
  options: MatchingOptions;
}

interface Candidate {
  component: string;
  route: RouteDecl | null;
  key: string;
}

interface Outcome {
  status: Status;
  candidates: Candidate[];
  reason: string | null;
  via: string[];
  ruleRoute: boolean;
}

interface Fit {
  route: RouteDecl;
  fit: PathFit;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);
const ANY_METHOD = new Set(["ALL", "USE", "*"]);

/**
 * Resolves call sites to target keys: HTTP paths against route templates
 * (exact, path-to-regexp, segment by segment), through gateways and base
 * addresses read from the environment; DDP methods, broker actions, events,
 * collections and timers by name. Each decision honours `Sources`.
 */
export class Resolver {
  private readonly kinds = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();
  private readonly patterns = new Map<string, RoutePattern>();
  private readonly byKind = new Map<string, RouteDecl[]>();
  private readonly containersOf = new Map<string, Container[]>();
  private readonly byHost = new Map<string, Container>();
  private readonly gatewayRules: GatewayRule[];
  private readonly eventNames: string[];
  /** Registrations of the broker service declared in a file, by `<repo>:<path>`. */
  private readonly registrationsByFile = new Map<string, Registration[]>();

  constructor(private readonly input: ResolverInput) {
    for (const c of input.components) {
      this.kinds.set(c.id, c.kind);
      this.byAlias.set(c.id, c.id);
      for (const a of c.aliases) this.byAlias.set(a, c.id);
    }
    for (const r of input.routes) {
      const list = this.byKind.get(r.kind) ?? [];
      list.push(r);
      this.byKind.set(r.kind, list);
      if (r.kind === "broker-action" && registrationsOf(r).length > 0) this.registrationsByFile.set(`${r.repo}:${r.path}`, registrationsOf(r));
      if (r.kind === "http" && !this.patterns.has(r.template)) this.patterns.set(r.template, routePattern(r.template));
    }
    for (const c of input.infra.containers) {
      if (c.component) this.containersOf.set(c.component, [...(this.containersOf.get(c.component) ?? []), c]);
      for (const h of [c.name, ...c.hostnames]) if (!this.byHost.has(h.toLowerCase())) this.byHost.set(h.toLowerCase(), c);
    }
    this.gatewayRules = input.infra.rules;
    const names = new Set<string>();
    for (const s of input.sites) if (s.type === "broker" && s.role !== "request") for (const n of namesOf(s.address) ?? []) names.add(n);
    for (const r of this.byKind.get("event") ?? []) names.add(r.template);
    this.eventNames = [...names].sort();
  }

  kindOf(component: string): string | undefined {
    return this.kinds.get(component);
  }

  /** Routes of a kind the sources allow. */
  routesOf(kind: RouteDecl["kind"], sources: Sources): RouteDecl[] {
    return (this.byKind.get(kind) ?? []).filter((r) => allowed(r, sources));
  }

  /** Event names known from the code: literal names published or subscribed, declared events. */
  knownEvents(): string[] {
    return this.eventNames;
  }

  /** Literal names that sites of a type use, e.g. every collection or job name in the code. */
  knownNames(type: CallSite["type"]): string[] {
    const names = new Set<string>();
    for (const s of this.input.sites) if (s.type === type) for (const n of namesOf(s.address) ?? []) names.add(n);
    return [...names].sort();
  }

  databases(): string[] {
    return this.input.components.filter((c) => c.kind === "database").map((c) => c.id);
  }

  /** Whether some gateway rule leads to a container of the component (true when no gateway rules are known). */
  gatewayReaches(component: string): boolean {
    return this.gatewayRules.length === 0 || this.gatewayRules.some((r) => this.componentOfContainer(r.target) === component);
  }

  /**
   * Whether the deployment runs a service: true for parts that are no
   * services (clients run outside it) and when no containers are known.
   */
  deployed(component: string): boolean {
    if (this.input.infra.containers.length === 0 || this.kinds.get(component) !== "service") return true;
    return this.containersOf.has(component);
  }

  patternOf(template: string): RoutePattern {
    let p = this.patterns.get(template);
    if (!p) {
      p = routePattern(template);
      this.patterns.set(template, p);
    }
    return p;
  }

  resolve(original: CallSite, sources: Sources): Resolution {
    if (!sources.rules) return finish({ status: "unresolved", candidates: [], reason: "rules-off", via: [], ruleRoute: false });
    const site = { ...original, components: this.componentsOf(original, sources) };
    let outcome: Outcome;
    switch (site.type) {
      case "http":
        outcome = this.http(site, sources);
        break;
      case "ddp":
        outcome = this.ddp(site, sources);
        break;
      case "broker":
        outcome = site.role === "request" ? this.action(site, sources) : this.event(site);
        break;
      case "db":
        outcome = this.collection(site, sources);
        break;
      case "trigger":
        outcome = this.timer(site);
        break;
    }
    return finish(outcome);
  }

  /**
   * Parts that run a site. Code of a broker service class runs where the
   * service is registered, so a registration the deployment switches off
   * (`if (!isRunningMs())`) removes that part; the import graph alone keeps it.
   */
  componentsOf(site: CallSite, sources: Sources): string[] {
    const regs = this.registrationsByFile.get(`${site.repo}:${site.path}`);
    if (!regs) return site.components;
    const running = new Set<string>();
    for (const reg of regs) {
      for (const c of reg.components) {
        if (sources.env && !this.deployed(c)) continue;
        if (evaluateGuard(reg.guard, sources.env ? this.envOf(c) : null, this.input.options.guards) !== false) running.add(c);
      }
    }
    const kept = site.components.filter((c) => running.has(c));
    return kept.length > 0 ? kept : site.components;
  }

  // HTTP ----------------------------------------------------------------------------------------

  private http(site: CallSite, sources: Sources): Outcome {
    const { forms } = httpForms(site.address);
    const methods = methodsOf(site.method);
    return combine(forms.map((f) => this.httpForm(site, f, methods, sources)));
  }

  private httpForm(site: CallSite, form: HttpAddress, methods: string[] | null, sources: Sources): Outcome {
    if (form.host.k === "unknown" && form.segments.length === 0) return unresolved("unknown-address");
    let segments = form.segments;
    let hosts: string[] | null = null;
    if (form.host.k === "literal") hosts = [form.host.host];
    else if (form.host.k === "env" || form.host.k === "setting") {
      const values = sources.env ? this.valuesOf(site, form.host.k, form.host.key) : [];
      if (values.length > 0) {
        const parsed = values.map(baseOf);
        hosts = [...new Set(parsed.map((p) => p.host))];
        const prefixes = [...new Set(parsed.map((p) => p.path))];
        if (prefixes.length === 1 && prefixes[0] !== "") segments = [...pathSegments(prefixes[0] as string), ...segments];
      }
    }
    const direct = this.fitHttp(segments, methods, sources);
    const ruleRoute = direct.some((f) => f.route.source === "rules");
    if (hosts === null && (form.host.k === "env" || form.host.k === "setting") && best(direct).length === 0) {
      // a base address from configuration that no part of the system serves: an outside service
      return { status: "none", candidates: [], reason: "external", via: [], ruleRoute };
    }

    if (hosts !== null) {
      const outcomes = hosts.map((h) => this.httpToHost(site, h, segments, methods, sources, direct, ruleRoute));
      return combine(outcomes);
    }
    if (form.host.k === "none" && sources.gateway && this.throughGateway(site)) {
      const passed = this.httpThroughGateway(site, segments, null, methods, sources, ruleRoute);
      if (passed) return passed;
    }
    return this.decide(site, best(direct), ruleRoute, [], direct.length > 0 ? "ambiguous-route" : "no-route");
  }

  private httpToHost(
    site: CallSite,
    host: string,
    segments: SiteSegment[],
    methods: string[] | null,
    sources: Sources,
    direct: Fit[],
    ruleRoute: boolean,
  ): Outcome {
    const target = this.hostTarget(host, sources);
    if (target.k === "external") return { status: "none", candidates: [], reason: "external", via: [], ruleRoute };
    if (target.k === "self") {
      const own = best(direct.filter((f) => f.route.components.some((c) => site.components.includes(c))));
      return own.length > 0 ? { status: "none", candidates: [], reason: "intra", via: [], ruleRoute } : unresolved("no-route", ruleRoute);
    }
    if (target.k === "gateway") {
      if (sources.gateway) {
        const passed = this.httpThroughGateway(site, segments, host, methods, sources, ruleRoute);
        if (passed) return passed;
      }
      return this.decide(site, best(direct), ruleRoute, [], "no-route");
    }
    const inHost = best(direct.filter((f) => f.route.components.includes(target.component)));
    if (inHost.length === 0) return unresolved(direct.length > 0 ? "no-route-in-host" : "no-route", ruleRoute);
    return this.decide(site, inHost, ruleRoute, [], "ambiguous-route", target.component);
  }

  /**
   * A request through the gateway: the rule decides the container and
   * rewrites the path. When the container has no such route the gateway
   * answer is not taken (null), and the direct match decides.
   */
  private httpThroughGateway(
    site: CallSite,
    segments: SiteSegment[],
    host: string | null,
    methods: string[] | null,
    sources: Sources,
    ruleRoute: boolean,
  ): Outcome | null {
    const pass = passGateway(this.gatewayRules, segments, host);
    if (!pass) return null;
    const component = this.componentOfContainer(pass.rule.target);
    if (!component) return null;
    const fits = best(this.fitHttp(pass.segments, methods, sources).filter((f) => f.route.components.includes(component)));
    if (fits.length === 0) return null;
    return { ...this.decide(site, fits, ruleRoute, [pass.rule.gateway], "ambiguous-route", component), ruleRoute: ruleRoute || fits.some((f) => f.route.source === "rules") };
  }

  /** Routes whose template fits the path, with a compatible method. */
  private fitHttp(segments: SiteSegment[], methods: string[] | null, sources: Sources): Fit[] {
    const text = `/${segments.map((s) => (s.k === "lit" ? s.text : s.k === "any" ? ":p" : s.k === "glob" ? s.text : "*")).join("/")}`;
    const out: Fit[] = [];
    for (const route of this.routesOf("http", sources)) {
      if (!methodFits(methods, route.method)) continue;
      const fit = fitPath(segments, text, this.patternOf(route.template));
      if (fit) out.push({ route, fit });
    }
    return preferRules(out, (f) => f.route, (f) => !f.fit.weak);
  }

  private throughGateway(site: CallSite): boolean {
    return this.gatewayRules.length > 0 && site.components.some((c) => this.kinds.get(c) === "client");
  }

  /** Values of an environment variable or a setting in the containers running the site, or the profile's. */
  private valuesOf(site: CallSite, kind: "env" | "setting", key: string): string[] {
    const name = kind === "env" ? key : `OVERWRITE_SETTING_${key}`;
    const values = new Set<string>();
    for (const c of site.components) for (const container of this.containersOf.get(c) ?? []) if (container.env[name]) values.add(container.env[name] as string);
    if (values.size === 0 && this.input.profileEnv[name]) values.add(this.input.profileEnv[name] as string);
    return [...values].sort();
  }

  private hostTarget(host: string, sources: Sources): { k: "external" } | { k: "self" } | { k: "gateway"; component: string } | { k: "component"; component: string } {
    const h = host.toLowerCase();
    if (LOCAL_HOSTS.has(h)) return { k: "self" };
    const container = sources.env || sources.gateway ? this.byHost.get(h) : undefined;
    const component = container ? container.component : this.byAlias.get(h);
    if (!component) return { k: "external" };
    if (this.kinds.get(component) === "gateway") return { k: "gateway", component };
    return { k: "component", component };
  }

  private componentOfContainer(name: string): string | null {
    const c = this.byHost.get(name.toLowerCase());
    return c?.component ?? this.byAlias.get(name) ?? null;
  }

  // DDP ------------------------------------------------------------------------------------------

  private ddp(site: CallSite, sources: Sources): Outcome {
    const names = namesOf(site.address);
    if (names === null) return unresolved("unknown-name");
    const verb = site.role === "subscribe" ? "sub" : "call";
    return combine(
      names.map((name) => {
        const routes = preferRules(
          this.routesOf("ddp-method", sources).filter((r) => r.template === name && (r.method === null || r.method === verb)),
          (r) => r,
        );
        const ruleRoute = routes.some((r) => r.source === "rules");
        let candidates = routes.flatMap((r) => r.components.map((c) => ({ component: c, route: r, key: `ddp:${verb}:${name}@${c}` })));
        if (candidates.length === 0) return unresolved("no-route", ruleRoute);
        const via: string[] = [];
        const transport = this.input.options.transports.find((t) => t.type === "ddp");
        if (transport && sources.gateway && this.throughGateway(site)) {
          const pass = passGateway(this.gatewayRules, pathSegments(transport.path), null);
          const component = pass ? this.componentOfContainer(pass.rule.target) : null;
          if (pass && component) {
            via.push(pass.rule.gateway);
            // the receiving part handles what it declares and forwards the rest
            if (candidates.some((c) => c.component === component)) candidates = candidates.filter((c) => c.component === component);
          }
        }
        return { ...settle(site, candidates, "ambiguous-route"), via, ruleRoute };
      }),
    );
  }

  // Broker -------------------------------------------------------------------------------------

  private action(site: CallSite, sources: Sources): Outcome {
    const names = namesOf(site.address);
    if (names === null) return unresolved("unknown-name");
    return combine(
      names.map((name) => {
        const routes = preferRules(
          this.routesOf("broker-action", sources).filter((r) => r.template === name),
          (r) => r,
        );
        const ruleRoute = routes.some((r) => r.source === "rules");
        if (routes.length === 0) return unresolved("no-route", ruleRoute);
        const candidates: Candidate[] = [];
        let registered = false;
        for (const r of routes) {
          const regs = registrationsOf(r);
          if (regs.length === 0) {
            for (const c of r.components) candidates.push({ component: c, route: r, key: `action:-:${name}@${c}` });
            continue;
          }
          for (const reg of regs) {
            for (const c of reg.components) {
              registered = true;
              if (sources.env && !this.deployed(c)) continue;
              const env = sources.env ? this.envOf(c) : null;
              if (evaluateGuard(reg.guard, env, this.input.options.guards) !== false) candidates.push({ component: c, route: r, key: `action:-:${name}@${c}` });
            }
          }
        }
        if (candidates.length === 0) return registered ? { status: "none", candidates: [], reason: "not-deployed", via: [], ruleRoute } : unresolved("not-registered", ruleRoute);
        return { ...settle(site, candidates, "ambiguous-route"), via: [], ruleRoute };
      }),
    );
  }

  /**
   * Events go to every subscriber, so the name alone is the target. A name
   * with run-time pieces is matched against the names the code uses
   * elsewhere; more than one fitting name is an ambiguity.
   */
  private event(site: CallSite): Outcome {
    const toCandidate = (n: string): Candidate => ({ component: "*", route: null, key: `event:-:${n}@*` });
    const names = namesOf(site.address);
    if (names) return { status: "linked", candidates: names.map(toCandidate), reason: null, via: [], ruleRoute: true };
    const matched = this.eventsMatching(site.address);
    if (matched.length === 0) return unresolved("unknown-name", true);
    return { status: matched.length === 1 ? "linked" : "ambiguous", candidates: matched.map(toCandidate), reason: matched.length === 1 ? null : "pattern", via: [], ruleRoute: true };
  }

  private eventsMatching(value: AbstractValue): string[] {
    const re = nameRegex(value);
    return re ? this.eventNames.filter((n) => re.test(n)) : [];
  }

  /** Environment of a component's containers over the profile's. */
  private envOf(component: string): Record<string, string> {
    const env = { ...this.input.profileEnv };
    for (const c of this.containersOf.get(component) ?? []) Object.assign(env, c.env);
    return env;
  }

  // MongoDB and timers ---------------------------------------------------------------------------

  private collection(site: CallSite, sources: Sources): Outcome {
    const names = namesOf(site.address);
    if (names === null) return unresolved("unknown-name");
    const databases = this.input.components.filter((c) => c.kind === "database").map((c) => c.id);
    let chosen = databases;
    if (sources.env) {
      const reached = new Set<string>();
      for (const c of site.components) {
        for (const container of this.containersOf.get(c) ?? []) {
          for (const v of Object.values(container.env)) {
            const host = hostOf(v);
            const target = host ? this.byHost.get(host.toLowerCase())?.component : undefined;
            if (target && databases.includes(target)) reached.add(target);
          }
        }
      }
      if (reached.size > 0) chosen = [...reached].sort();
    }
    if (chosen.length === 0) return unresolved("no-database", true);
    const candidates = names.flatMap((n) => chosen.map((db) => ({ component: db, route: null, key: `coll:-:${n}@${db}` })));
    return chosen.length === 1
      ? { status: "linked", candidates, reason: null, via: [], ruleRoute: true }
      : { status: "ambiguous", candidates, reason: "ambiguous-database", via: [], ruleRoute: true };
  }

  private timer(site: CallSite): Outcome {
    const names = namesOf(site.address);
    if (names === null) return unresolved("unknown-name");
    if (site.components.length === 0) return unresolved("no-component", true);
    const candidates = names.flatMap((n) => site.components.map((c) => ({ component: c, route: null, key: `timer:-:${n}@${c}` })));
    return site.components.length === 1
      ? { status: "linked", candidates, reason: null, via: [], ruleRoute: true }
      : { status: "ambiguous", candidates, reason: "several-components", via: [], ruleRoute: true };
  }

  // Shared ---------------------------------------------------------------------------------------

  private decide(site: CallSite, fits: Fit[], ruleRoute: boolean, via: string[], ambiguous: string, only?: string): Outcome {
    if (fits.length === 0) return unresolved("no-route", ruleRoute);
    const candidates = fits.flatMap((f) =>
      f.route.components.filter((c) => only === undefined || c === only).map((c) => ({ component: c, route: f.route, key: httpKey(f.route, site, c) })),
    );
    return { ...settle(site, candidates, ambiguous), via, ruleRoute };
  }
}

/**
 * Declarations of the rules first: routes the language model extracted
 * count only where no rule declaration fits, so they fill gaps and never
 * override a rule.
 */
function preferRules<T>(items: T[], routeOf: (t: T) => RouteDecl, counts: (t: T) => boolean = () => true): T[] {
  const ruled = items.filter((t) => routeOf(t).source === "rules");
  return ruled.some(counts) ? ruled : items;
}

function allowed(r: RouteDecl, sources: Sources): boolean {
  return r.source === "rules" ? sources.rules : r.source === "llm" ? sources.llmRoutes : false;
}

/**
 * One target per component: the best route there. Two components left is an
 * ambiguity; a single component equal to every component running the site
 * is a call within one deployed part.
 */
function settle(site: CallSite, candidates: Candidate[], ambiguous: string): Omit<Outcome, "via" | "ruleRoute"> {
  const byComponent = new Map<string, Candidate>();
  for (const c of candidates) if (!byComponent.has(c.component)) byComponent.set(c.component, c);
  const list = [...byComponent.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  if (list.length === 0) return { status: "unresolved", candidates: [], reason: "no-route" };
  if (list.length > 1) return { status: "ambiguous", candidates: list, reason: ambiguous };
  const only = list[0] as Candidate;
  if (site.components.length > 0 && site.components.every((c) => c === only.component)) return { status: "none", candidates: list, reason: "intra" };
  return { status: "linked", candidates: list, reason: null };
}

/** Best fits: non-weak ones with the top score, a route with the site's exact method before one taking any. */
function best(fits: Fit[]): Fit[] {
  const strong = fits.filter((f) => !f.fit.weak);
  if (strong.length === 0) return [];
  const sorted = [...strong].sort((a, b) => compareScores(a.fit, b.fit) || methodRank(a.route) - methodRank(b.route));
  const top = sorted[0] as Fit;
  return sorted.filter((f) => compareScores(f.fit, top.fit) === 0 && methodRank(f.route) === methodRank(top.route));
}

function methodRank(r: RouteDecl): number {
  return r.method === null || ANY_METHOD.has(r.method.toUpperCase()) ? 1 : 0;
}

function methodFits(methods: string[] | null, routeMethod: string | null): boolean {
  if (methods === null || routeMethod === null) return true;
  const m = routeMethod.toUpperCase();
  if (ANY_METHOD.has(m)) return true;
  return methods.includes(m) || (m === "GET" && methods.includes("HEAD"));
}

function httpKey(route: RouteDecl, site: CallSite | null, component: string): string {
  let method = route.method?.toUpperCase() ?? null;
  if (method === null || ANY_METHOD.has(method)) {
    const own = site ? methodsOf(site.method) : null;
    method = own?.length === 1 ? (own[0] as string) : "*";
  }
  return `http:${method}:${route.template}@${component}`;
}

/** Host and path prefix of a base address read from the environment (`http://api:3000/v2`, or a bare `api`). */
function baseOf(value: string): { host: string; path: string } {
  const host = hostOf(value);
  if (host) {
    const path = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(value.trim())?.[1] ?? "";
    return { host: host.toLowerCase(), path: path.replace(/\/+$/, "") };
  }
  const bare = /^([^:/?#]+)(?::\d+)?(\/[^?#]*)?/.exec(value.trim());
  return { host: (bare?.[1] ?? value).toLowerCase(), path: (bare?.[2] ?? "").replace(/\/+$/, "") };
}

function pathSegments(path: string): SiteSegment[] {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s !== "")
    .map((text) => ({ k: "lit", text }));
}

/** The literal names a value can take, or null when some part is not literal. */
export function namesOf(value: AbstractValue): string[] | null {
  if (value.parts.length === 1 && value.parts[0]?.k === "lit") return [value.parts[0].v];
  if (value.parts.length === 1 && value.parts[0]?.k === "alts") {
    const out: string[] = [];
    for (const o of value.parts[0].options) {
      const inner = namesOf(o);
      if (inner === null) return null;
      out.push(...inner);
    }
    return [...new Set(out)].sort();
  }
  return null;
}

/** A name with run-time pieces as a pattern (`watch.${x}` → /^watch\..+$/), if it has literal text. */
function nameRegex(value: AbstractValue): RegExp | null {
  if (value.parts.some((p) => p.k === "alts")) return null;
  const literal = value.parts.filter((p) => p.k === "lit").map((p) => (p.k === "lit" ? p.v : "")).join("");
  if (literal.length < 3) return null;
  const body = value.parts.map((p) => (p.k === "lit" ? p.v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : ".+")).join("");
  return new RegExp(`^${body}$`);
}

interface Registration {
  at: string;
  components: string[];
  guard: string;
}

function registrationsOf(r: RouteDecl): Registration[] {
  const regs = r.extra?.registrations;
  return Array.isArray(regs) ? (regs as Registration[]) : [];
}

function unresolved(reason: string, ruleRoute = false): Outcome {
  return { status: "unresolved", candidates: [], reason, via: [], ruleRoute };
}

/**
 * Outcomes of the alternatives of one address: one target when every
 * alternative that reaches the system leads to it, an ambiguity otherwise.
 */
function combine(outcomes: Outcome[]): Outcome {
  if (outcomes.length === 1) return outcomes[0] as Outcome;
  const ruleRoute = outcomes.some((o) => o.ruleRoute);
  const linked = outcomes.filter((o) => o.status === "linked");
  const keys = [...new Set(linked.flatMap((o) => o.candidates.map((c) => c.key)))];
  if (keys.length === 1) return { ...(linked[0] as Outcome), ruleRoute };
  if (keys.length > 1) {
    // the code chooses among known addresses at run time: each one is a target
    return { status: "linked", candidates: linked.flatMap((o) => o.candidates), reason: "alternatives", via: [...new Set(linked.flatMap((o) => o.via))], ruleRoute };
  }
  const ambiguous = outcomes.find((o) => o.status === "ambiguous");
  if (ambiguous) return { ...ambiguous, ruleRoute };
  const none = outcomes.filter((o) => o.status === "none");
  if (none.length === outcomes.length && new Set(none.map((o) => o.reason)).size === 1) return { ...(none[0] as Outcome), ruleRoute };
  return { ...(outcomes.find((o) => o.status === "unresolved") ?? (outcomes[0] as Outcome)), ruleRoute };
}

function finish(o: Outcome): Resolution {
  const keys = [...new Set(o.candidates.map((c) => c.key))].sort();
  if (o.status === "linked") {
    const c = [...o.candidates].sort((a, b) => (a.key < b.key ? -1 : 1))[0] as Candidate;
    const several = keys.length > 1;
    return {
      status: "linked",
      target: c.key,
      route: c.route?.id ?? null,
      component: c.component,
      reason: several ? "alternatives" : null,
      via: o.via,
      alternatives: several ? keys : [],
      ruleRoute: o.ruleRoute,
    };
  }
  return {
    status: o.status,
    target: null,
    route: null,
    component: null,
    reason: o.reason,
    via: o.via,
    alternatives: o.status === "ambiguous" ? keys : [],
    ruleRoute: o.ruleRoute,
  };
}
