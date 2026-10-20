import { describe, expect, it } from "vitest";
import { caseOf, classifySite } from "../../src/classify/features.js";
import type { AbstractValue, CallSite, RouteDecl } from "../../src/core/types.js";
import { alts, concat, dyn, env, lit, unknown } from "../../src/extract/value.js";
import type { Container, GatewayRule, InfraFacts } from "../../src/infra/model.js";
import { httpForms } from "../../src/match/address.js";
import { jaccard, levenshtein, rankCandidates, tokens } from "../../src/match/candidates.js";
import { passGateway } from "../../src/match/gateway.js";
import { evaluateGuard } from "../../src/match/guards.js";
import { ALL_SOURCES, Resolver, type ResolverInput } from "../../src/match/resolve.js";
import { fitPath, routePattern } from "../../src/match/routes.js";

const param = (name: string): AbstractValue => ({ parts: [{ k: "param", fn: "f", index: 0, name, path: [] }], hops: [] });

describe("http address forms", () => {
  it("splits host and path and drops the query", () => {
    const [f] = httpForms(lit("https://Orders:3000/api/orders?x=1")).forms;
    expect(f?.host).toEqual({ k: "literal", host: "orders" });
    expect(f?.text).toBe("/api/orders");
    const [rel] = httpForms(concat(lit("/api/orders/"), param("id"), lit("/items?q="), param("q"))).forms;
    expect(rel?.host).toEqual({ k: "none" });
    expect(rel?.text).toBe("/api/orders/:p/items");
  });

  it("reads base addresses from variables, settings and run-time values", () => {
    expect(httpForms(concat(env("API_URL"), lit("/orders"))).forms[0]?.host).toEqual({ k: "env", key: "API_URL" });
    expect(httpForms(concat(lit("http://"), env("HOST"), lit(":3000/x"))).forms[0]).toMatchObject({ host: { k: "env", key: "HOST" }, text: "/x" });
    expect(httpForms(concat(dyn("x"), lit("/healthz"))).forms[0]).toMatchObject({ host: { k: "unknown" }, text: "/healthz" });
    expect(httpForms(unknown("x")).forms[0]).toMatchObject({ host: { k: "unknown" }, segments: [] });
  });

  it("expands alternatives, collapses empty segments and reads written templates as parameters", () => {
    const forms = httpForms(concat(lit("/api/"), alts([lit("/v1/a"), lit("/v1/b")]))).forms.map((f) => f.text);
    expect(forms).toEqual(["/api/v1/a", "/api/v1/b"]);
    expect(httpForms(lit("/api/v1/visitor/:token")).forms[0]?.segments.at(-1)).toEqual({ k: "any", from: "param" });
    expect(httpForms(concat(lit("/rooms."), param("kind"))).forms[0]?.segments[0]).toMatchObject({ k: "glob", text: "rooms.*" });
  });
});

describe("fitting paths to route templates", () => {
  const fit = (site: AbstractValue, template: string) => {
    const f = httpForms(site).forms[0];
    return f ? fitPath(f.segments, f.text, routePattern(template)) : null;
  };

  it("matches exactly, by path-to-regexp and segment by segment", () => {
    expect(fit(lit("/api/orders"), "/api/orders")?.exact).toBe(true);
    expect(fit(lit("/api/orders/12"), "/api/orders/:id")).toMatchObject({ exact: false, weak: false });
    expect(fit(concat(lit("/api/orders/"), param("id")), "/api/orders/:orderId")?.exact).toBe(true);
    expect(fit(lit("/api/orders"), "/api/users")).toBeNull();
  });

  it("prefers literal routes for literal paths and parameters for run-time segments", () => {
    const literal = (t: string) => fit(lit("/orders/search"), t)?.score;
    expect((literal("/orders/search")?.[0] ?? 0) > (literal("/orders/:id")?.[0] ?? 0)).toBe(true);
    const byId = fit(concat(lit("/orders/"), param("id")), "/orders/:id");
    const bySearch = fit(concat(lit("/orders/"), param("id")), "/orders/search");
    expect(byId?.weak).toBe(false);
    expect(bySearch?.weak).toBe(true);
  });

  it("converts Express templates", () => {
    expect(fit(lit("/files/a/b"), "/files/*")).not.toBeNull();
    expect(fit(lit("/users"), "/users/:id?")).not.toBeNull();
    expect(fit(lit("/users/7"), "/users/:id(\\d+)")).not.toBeNull();
    expect(routePattern("/a/:x/b").canonical).toBe("/a/:p/b");
  });
});

describe("gateways", () => {
  const rule = (path: string, target: string, priority: number, extra: Partial<GatewayRule> = {}): GatewayRule => ({
    gateway: "gw",
    match: "prefix",
    path,
    host: null,
    strip: null,
    replace: null,
    target,
    priority,
    source: "t",
    ...extra,
  });
  const segs = (path: string) => httpForms(lit(path)).forms[0]?.segments ?? [];

  it("takes the matching rule with the highest priority and rewrites the path", () => {
    const rules = [rule("/", "web", 1), rule("/api", "api", 5), rule("/shop/", "orders", 10, { strip: "/shop/", replace: "/" })];
    expect(passGateway(rules, segs("/api/orders"), null)?.rule.target).toBe("api");
    const shop = passGateway(rules, segs("/shop/orders"), null);
    expect(shop?.rule.target).toBe("orders");
    expect(shop?.segments).toEqual([{ k: "lit", text: "orders" }]);
    expect(passGateway(rules, segs("/static/x"), null)?.rule.target).toBe("web");
  });

  it("keeps run-time segments and honours hosts and regular expressions", () => {
    const rules = [rule("/api", "api", 5, { strip: "/api" }), rule("^/v[0-9]+/", "v", 9, { match: "regex" }), rule("/", "admin", 50, { host: "admin.example.com" })];
    const pass = passGateway(rules, httpForms(concat(lit("/api/orders/"), param("id"))).forms[0]?.segments ?? [], "shop.example.com");
    expect(pass?.segments).toEqual([{ k: "lit", text: "orders" }, { k: "any", from: "param" }]);
    expect(passGateway(rules, segs("/v2/x"), "shop.example.com")?.rule.target).toBe("v");
    expect(passGateway(rules, segs("/v2/x"), "admin.example.com")?.rule.target).toBe("admin");
  });
});

describe("registration guards", () => {
  const switches = [{ call: "isRunningMs()", env: "TRANSPORTER", pattern: "^(?:nats|TCP)" }];
  it("evaluates switches, environment reads and logic against an environment", () => {
    const ms = { TRANSPORTER: "nats://nats:4222" };
    expect(evaluateGuard("!isRunningMs()", ms, switches)).toBe(false);
    expect(evaluateGuard("!isRunningMs()", {}, switches)).toBe(true);
    expect(evaluateGuard("!process.env.USE_EXTERNAL_ABAC_SERVICE", ms, switches)).toBe(true);
    expect(evaluateGuard("isRunningMs() && process.env.X === 'on'", { ...ms, X: "on" }, switches)).toBe(true);
    expect(evaluateGuard("!(isRunningMs() || process.env.X)", ms, switches)).toBe(false);
    expect(evaluateGuard("", null, switches)).toBe(true);
  });

  it("is undecided without an environment or for conditions it cannot read", () => {
    expect(evaluateGuard("!isRunningMs()", null, switches)).toBeNull();
    expect(evaluateGuard("License.hasModule('x')", { TRANSPORTER: "" }, switches)).toBeNull();
    expect(evaluateGuard("License.hasModule('x') && isRunningMs()", {}, switches)).toBe(false);
    expect(evaluateGuard("License.hasModule('x') || !isRunningMs()", {}, switches)).toBe(true);
  });
});

function site(id: string, type: CallSite["type"], role: CallSite["role"], address: AbstractValue, components: string[], method: string | null = null): CallSite {
  const [repo = "", path = ""] = id.split(":");
  return { id, repo, path, line: 1, endLine: 1, col: 1, type, role, detector: "t", method: method ? lit(method) : null, address, components, liftedFrom: null };
}

function route(id: string, kind: RouteDecl["kind"], template: string, components: string[], extra: Record<string, unknown> | null = null, method: string | null = null): RouteDecl {
  const [repo = "", path = ""] = id.split(":");
  return { id, kind, repo, path, line: 1, col: 1, method, template, detector: "t", source: "rules", components, extra };
}

const container = (name: string, component: string, envVars: Record<string, string> = {}): Container => ({
  name,
  format: "compose",
  source: "c",
  component,
  image: null,
  hostnames: [name],
  ports: [],
  env: envVars,
});

function resolver(sites: CallSite[], routes: RouteDecl[], infra: Partial<InfraFacts> = {}): Resolver {
  const input: ResolverInput = {
    sites,
    routes,
    infra: { containers: [], rules: [], warnings: [], ...infra },
    components: [
      { id: "web", kind: "client", aliases: [] },
      { id: "server", kind: "service", aliases: [] },
      { id: "presence-service", kind: "service", aliases: ["presence"] },
      { id: "mongo", kind: "database", aliases: [] },
      { id: "traefik", kind: "gateway", aliases: [] },
    ],
    profileEnv: {},
    options: { guards: [{ call: "isRunningMs()", env: "TRANSPORTER", pattern: "^(?:nats|TCP)" }], transports: [{ type: "ddp", path: "/websocket" }] },
  };
  return new Resolver(input);
}

describe("resolving sites", () => {
  const presence = route("s:presence/Presence.ts", "broker-action", "presence.setStatus", ["presence-service", "server"], {
    service: "presence",
    registrations: [
      { at: "s:startup.ts:1", components: ["server"], guard: "!isRunningMs()" },
      { at: "s:presence/service.ts:1", components: ["presence-service"], guard: "" },
    ],
  });
  const ms = { containers: [container("server", "server", { TRANSPORTER: "nats://nats:4222", MONGO_URL: "mongodb://mongo:27017/db" }), container("presence-service", "presence-service"), container("mongo", "mongo")] };

  it("places broker actions where the deployment registers the service", () => {
    const call = site("s:a.ts", "broker", "request", lit("presence.setStatus"), ["server"]);
    const r = resolver([call], [presence], ms);
    expect(r.resolve(call, ALL_SOURCES)).toMatchObject({ status: "linked", target: "action:-:presence.setStatus@presence-service" });
    expect(r.resolve(call, { ...ALL_SOURCES, env: false })).toMatchObject({ status: "ambiguous" });
    const c = classifySite(r, call);
    expect(c.features.c4).toBe(true);
    expect(c.caseNo).toBe(4);
    const monolith = resolver([call], [presence], { containers: [container("server", "server")] });
    expect(monolith.resolve(call, ALL_SOURCES)).toMatchObject({ status: "none", reason: "intra" });
  });

  it("runs service code where the service runs, and finds no target for services switched off", () => {
    const cron = site("s:presence/Presence.ts", "trigger", "schedule", lit("presence-expiry"), ["presence-service", "server"]);
    const r = resolver([cron], [presence], ms);
    expect(r.resolve(cron, ALL_SOURCES).target).toBe("timer:-:presence-expiry@presence-service");
    const instance = route("s:instance.ts", "broker-action", "instance.ping", ["server"], { registrations: [{ at: "x", components: ["server"], guard: "!isRunningMs()" }] });
    const call = site("s:b.ts", "broker", "request", lit("instance.ping"), ["presence-service"]);
    expect(resolver([call], [instance], ms).resolve(call, ALL_SOURCES)).toMatchObject({ status: "none", reason: "not-deployed" });
  });

  it("links events by name, collections through the database address, and alternatives to each target", () => {
    const pub = site("s:a.ts", "broker", "publish", alts([lit("user.a"), lit("user.b")]), ["server"]);
    const sub = site("s:b.ts", "broker", "subscribe", concat(lit("user."), param("x")), ["server"]);
    const db = site("s:c.ts", "db", "access", lit("users"), ["server"]);
    const r = resolver([pub, sub, db], [], ms);
    expect(r.resolve(pub, ALL_SOURCES)).toMatchObject({ status: "linked", reason: "alternatives", alternatives: ["event:-:user.a@*", "event:-:user.b@*"] });
    expect(r.resolve(sub, ALL_SOURCES)).toMatchObject({ status: "ambiguous", reason: "pattern" });
    expect(r.resolve(db, ALL_SOURCES).target).toBe("coll:-:users@mongo");
  });

  it("sends client DDP calls through the gateway, which handles what it declares and forwards the rest", () => {
    const rules: GatewayRule[] = [
      { gateway: "traefik", match: "prefix", path: "/", host: null, strip: null, replace: null, target: "server", priority: 1, source: "t" },
      { gateway: "traefik", match: "prefix", path: "/websocket", host: null, strip: null, replace: null, target: "streamer", priority: 9, source: "t" },
    ];
    const infra = { containers: [...ms.containers, container("streamer", "presence-service")], rules };
    const both = route("s:m.ts", "ddp-method", "UserPresence:away", ["server", "presence-service"], null, "call");
    const one = route("s:n.ts", "ddp-method", "saveSettings", ["server"], null, "call");
    const away = site("w:a.ts", "ddp", "request", lit("UserPresence:away"), ["web"]);
    const save = site("w:b.ts", "ddp", "request", lit("saveSettings"), ["web"]);
    const r = resolver([away, save], [both, one], infra);
    expect(r.resolve(away, ALL_SOURCES)).toMatchObject({ target: "ddp:call:UserPresence:away@presence-service", via: ["traefik"] });
    expect(classifySite(r, away).caseNo).toBe(7);
    expect(r.resolve(save, ALL_SOURCES).target).toBe("ddp:call:saveSettings@server");
  });

  it("tells outside services and calls to itself from links", () => {
    const api = route("s:api.ts", "http", "/api/orders", ["server"], null, "GET");
    const out = site("s:a.ts", "http", "request", lit("https://slack.com/api/orders"), ["server"], "GET");
    const self = site("s:b.ts", "http", "request", lit("http://localhost:3000/api/orders"), ["server"], "GET");
    const cfg = site("s:c.ts", "http", "request", concat({ parts: [{ k: "setting", key: "Cloud_Url" }], hops: [] }, lit("/v2/poll")), ["server"], "GET");
    const r = resolver([out, self, cfg], [api]);
    expect(r.resolve(out, ALL_SOURCES)).toMatchObject({ status: "none", reason: "external" });
    expect(r.resolve(self, ALL_SOURCES)).toMatchObject({ status: "none", reason: "intra" });
    // a configured base address the deployment does not give, and no route that fits: not linked, not called outside
    expect(r.resolve(cfg, ALL_SOURCES)).toMatchObject({ status: "unresolved", reason: "config-host" });
    expect(classifySite(r, out).caseNo).toBeNull();
  });
});

describe("base addresses from the environment", () => {
  it("keeps the path prefix of each base address", () => {
    const v2 = route("a:app.ts", "http", "/v2/orders", ["server"], null, "GET");
    const call = site("w:a.ts", "broker", "request", lit("x"), ["web", "presence-service"]);
    const http = { ...call, type: "http" as const, role: "request" as const, address: concat(env("API_URL"), lit("/orders")), method: lit("GET") };
    const infra = { containers: [container("web", "web", { API_URL: "http://server:3000/v2" }), container("presence-service", "presence-service", { API_URL: "http://server:3000" }), container("server", "server")] };
    const r = resolver([http], [v2], infra);
    // one base gives /v2/orders, which the server declares; the other gives /orders, which nobody does
    expect(r.resolve(http, ALL_SOURCES)).toMatchObject({ status: "linked", target: "http:GET:/v2/orders@server" });
  });
});

describe("cases", () => {
  it("is the highest feature present", () => {
    const none = { c1: false, c2: false, c3: false, c4: false, c5: false, c6: false, c7: false, c8: false };
    expect(caseOf({ ...none, c1: true })).toBe(1);
    expect(caseOf({ ...none, c2: true, c3: true })).toBe(3);
    expect(caseOf({ ...none, c3: true, c7: true })).toBe(7);
    expect(caseOf(none)).toBe(1);
  });
});

describe("select-mode candidates", () => {
  it("scores names by tokens and edit distance", () => {
    expect([...tokens("/api/v1/rooms.membersOrderedByRole")]).toEqual(["api", "v1", "rooms", "members", "ordered", "by", "role"]);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("offers the targets the rules leave open first", () => {
    const a = route("a:app.ts", "http", "/orders/:id", ["server"], null, "GET");
    const b = route("b:app.ts", "http", "/orders/:orderId", ["presence-service"], null, "GET");
    const c = route("c:app.ts", "http", "/orders/:id/items", ["server"], null, "GET");
    const call = site("w:a.ts", "http", "request", concat(lit("/orders/"), param("id")), ["web"], "GET");
    const r = resolver([call], [a, b, c]);
    const res = r.resolve(call, ALL_SOURCES);
    expect(res.status).toBe("ambiguous");
    const ranked = rankCandidates(r, call, res, ALL_SOURCES).map((x) => x.target);
    expect(ranked.slice(0, 2).sort()).toEqual(["http:GET:/orders/:id@server", "http:GET:/orders/:orderId@presence-service"]);
    expect(ranked).toContain("http:GET:/orders/:id/items@server");
  });
});
