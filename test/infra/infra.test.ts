import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.js";
import { toolRoot } from "../../src/core/paths.js";
import { parseCompose, parseDotEnv } from "../../src/infra/compose.js";
import { extractInfra } from "../../src/infra/index.js";
import { fromManifests, loadManifests } from "../../src/infra/kubernetes.js";
import { hostOf, substitute } from "../../src/infra/model.js";
import { nginxRules } from "../../src/infra/nginx.js";
import { fromTerraform } from "../../src/infra/terraform.js";
import { parseTraefikRule } from "../../src/infra/traefik.js";

const fixture = (path: string) => readFileSync(join(toolRoot, "fixtures", "infra", path), "utf8");

describe("compose", () => {
  it("substitutes variables like docker compose", () => {
    expect(substitute("${A:-x}/${B-y}/${C}/$D/$$", { A: "", B: "", D: "d" })).toBe("x///d/$");
    expect(hostOf("mongodb://user:pw@mongo:27017/db?replicaSet=rs0")).toBe("mongo");
    expect(hostOf("nats://nats:4222")).toBe("nats");
    expect(hostOf("/relative")).toBeUndefined();
  });

  it("reads containers, their environment, host names and Traefik rules", () => {
    const vars = { ...parseDotEnv(fixture("compose/.env")), MODE: "cluster" };
    const { containers, rules } = parseCompose(fixture("compose/docker-compose.yml"), "infra:compose/docker-compose.yml", vars);
    const api = containers.find((c) => c.name === "api");
    expect(api).toMatchObject({ image: "example/api:latest", env: { PORT: "3001", MODE: "cluster", QUEUE_URL: "amqp://rabbit:5672" }, ports: [3000] });
    expect(containers.find((c) => c.name === "worker")?.env.API_URL).toBe("http://api:3001");
    expect(containers.find((c) => c.name === "rabbitmq")?.hostnames).toEqual(["rabbitmq", "rabbit-1", "rabbit"]);
    expect(rules.map((r) => [r.path, r.host, r.target, r.strip, r.priority > 0])).toEqual([
      ["/", null, "web", null, true],
      ["/api", "shop.example", "api", "/api", true],
    ]);
    expect(rules[1]?.priority).toBeGreaterThan(rules[0]?.priority ?? 0);
  });

  it("parses Traefik rule expressions", () => {
    expect(parseTraefikRule("PathPrefix(`/websocket`) || PathPrefix(`/sockjs`)")).toEqual([
      { match: "prefix", path: "/websocket", host: null },
      { match: "prefix", path: "/sockjs", host: null },
    ]);
    expect(parseTraefikRule("Host(`a.example`) && (Path(`/x`) || PathRegexp(`^/y`))")).toEqual([
      { match: "exact", path: "/x", host: "a.example" },
      { match: "regex", path: "^/y", host: "a.example" },
    ]);
    expect(parseTraefikRule("Host(`b.example`)")).toEqual([{ match: "prefix", path: "/", host: "b.example" }]);
  });
});

describe("nginx", () => {
  it("orders locations by nginx precedence and rewrites proxied prefixes", () => {
    const rules = nginxRules(fixture("nginx/nginx.conf"), "infra:nginx/nginx.conf", "nginx").sort((a, b) => b.priority - a.priority);
    expect(rules.map((r) => [r.match, r.path, r.target, r.strip, r.replace, r.host])).toEqual([
      ["exact", "/health", "api", null, null, "shop.example"],
      ["prefix", "/static/", "cdn", null, null, "shop.example"],
      ["regex", "\\.php$", "legacy", null, null, "shop.example"],
      ["prefix", "/api/", "api", "/api/", "/", "shop.example"],
      ["prefix", "/", "web", null, null, "shop.example"],
    ]);
  });
});

describe("kubernetes", () => {
  it("joins workloads, services, config maps and ingresses", () => {
    const { containers, rules } = fromManifests(loadManifests(fixture("k8s/app.yaml"), "infra:k8s/app.yaml"), "kubernetes", "ingress");
    expect(containers).toEqual([
      expect.objectContaining({
        name: "api",
        image: "example/api:1.0",
        env: { DB_URL: "postgres://db:5432/shop", CACHE_URL: "redis://cache:6379" },
        hostnames: ["api", "api-svc", "api-svc.shop", "api-svc.shop.svc.cluster.local"],
        ports: [80, 3000],
        source: "infra:k8s/app.yaml:8",
      }),
    ]);
    expect(rules).toEqual([expect.objectContaining({ gateway: "ingress", match: "prefix", path: "/api", host: "shop.example", target: "api" })]);
  });
});

describe("terraform", () => {
  it("substitutes variables and locals and reads Kubernetes and Docker resources", async () => {
    const { containers, rules, warnings } = await fromTerraform([{ text: fixture("terraform/main.tf"), file: "infra:terraform/main.tf" }], "ingress");
    expect(warnings).toEqual([]);
    expect(containers.map((c) => [c.name, c.env, c.hostnames])).toEqual([
      ["gateway", { ORDERS_URL: "http://orders:3000/api" }, ["gateway", "gateway-svc", "gateway-svc.default", "gateway-svc.default.svc.cluster.local"]],
      ["orders", { PORT: "3000", DB: "mongodb://mongo:27017/orders" }, ["orders"]],
    ]);
    expect(rules).toEqual([expect.objectContaining({ path: "/orders", target: "gateway" })]);
  });
});

describe("infrastructure of a target", () => {
  const config = parseConfig({
    name: "infra",
    repos: [{ id: "infra", path: "infra", role: "infra" }],
    components: [
      { id: "api", kind: "service", aliases: ["api-svc"] },
      { id: "web", kind: "client" },
      { id: "traefik", kind: "gateway" },
      { id: "queue", kind: "bus", aliases: ["rabbitmq"] },
      { id: "gateway", kind: "service" },
    ],
    infra: {
      env: { MODE: "cluster" },
      compose: ["infra:compose/docker-compose.yml"],
      nginx: [{ file: "infra:nginx/nginx.conf", gateway: "web" }],
      k8s: ["infra:k8s/*.yaml"],
      terraform: ["infra:terraform/*.tf"],
      helm: [{ chart: "infra:chart", release: "demo" }],
    },
  });
  const files = ["compose/.env", "compose/docker-compose.yml", "nginx/nginx.conf", "k8s/app.yaml", "terraform/main.tf"].map((path) => ({ repo: "infra", path }));
  const helm = () => ({ manifests: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: from-helm\nspec:\n  template:\n    spec:\n      containers:\n        - name: x\n          image: example/x\n" });

  it("reads every format and maps containers to components by name, alias or host name", async () => {
    const facts = await extractInfra({ config, files, dirOf: () => join(toolRoot, "fixtures", "infra"), helm });
    expect(facts.warnings).toEqual([]);
    const byName = Object.fromEntries(facts.containers.map((c) => [`${c.format}:${c.name}`, c.component]));
    expect(byName).toMatchObject({ "compose:api": "api", "compose:web": "web", "compose:traefik": "traefik", "compose:rabbitmq": "queue", "kubernetes:api": "api", "terraform:gateway": "gateway", "helm:from-helm": null });
    expect(facts.containers.find((c) => c.format === "compose" && c.name === "api")?.env.MODE).toBe("cluster");
    expect(new Set(facts.rules.map((r) => r.gateway))).toEqual(new Set(["traefik", "web", "ingress"]));
  });

  it("reports a chart it cannot render instead of failing", async () => {
    const facts = await extractInfra({ config, files, dirOf: () => join(toolRoot, "fixtures", "infra"), helm: () => ({ error: "helm is not installed" }) });
    expect(facts.warnings).toEqual(["infra:chart: helm is not installed; the chart was skipped"]);
  });
});

describe("case fixtures", () => {
  it("case 4: the gateway's ORDERS_URL names the orders service", () => {
    const { containers } = parseCompose(readFileSync(join(toolRoot, "fixtures/cases/case4/infra/docker-compose.yml"), "utf8"), "infra:docker-compose.yml", {});
    expect(hostOf(containers.find((c) => c.name === "gateway")?.env.ORDERS_URL ?? "")).toBe("orders");
  });

  it("case 7: nginx sends /shop/ to the orders service without the prefix", () => {
    const rules = nginxRules(readFileSync(join(toolRoot, "fixtures/cases/case7/infra/nginx.conf"), "utf8"), "infra:nginx.conf", "nginx");
    expect(rules.find((r) => r.path === "/shop/")).toMatchObject({ target: "orders", strip: "/shop/", replace: "/" });
  });
});
