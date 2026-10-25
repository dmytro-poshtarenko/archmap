import { describe, expect, it } from "vitest";
import { extractAll } from "../../src/extract/run.js";
import { loadRules } from "../../src/extract/rules.js";
import { usageOfFiles } from "../../src/extract/usage.js";
import { display, hopKinds } from "../../src/extract/value.js";
import { programFrom } from "./helpers.js";

/**
 * A synthetic project in the shapes Rocket.Chat uses (proxies, model registry,
 * services, REST router, hooks, SDK, cron); no code is copied from it.
 */
const FILES: Record<string, string> = {
  "main:packages/core-services/package.json": JSON.stringify({ name: "@rocket.chat/core-services", main: "./dist/index.js" }),
  "main:packages/core-services/src/index.ts": [
    "import { proxify } from './lib/proxify';",
    "export { api } from './api';",
    "export { ServiceClass } from './ServiceClass';",
    "export const Presence = proxify<IPresence>('presence');",
    "export const Team = proxify<ITeamService>('team');",
  ].join("\n"),
  "main:packages/core-services/src/lib/proxify.ts": [
    "import { api } from '../api';",
    "export function proxify<T>(namespace: string): T {",
    "  return new Proxy({}, { get: (_t: unknown, prop: string) => (...params: unknown[]) => api.call(`${namespace}.${prop}`, params) }) as T;",
    "}",
  ].join("\n"),
  "main:packages/core-services/src/api.ts": "export const api = { call(name: string, params: unknown) { return name; }, broadcast(e: string, ...a: unknown[]) {}, broadcastLocal(e: string) {}, registerService(s: unknown) {} };",
  "main:packages/core-services/src/ServiceClass.ts": "export class ServiceClass { protected name = ''; onEvent(e: string, fn: unknown) {} }",
  "main:packages/models/package.json": JSON.stringify({ name: "@rocket.chat/models", main: "./dist/index.js" }),
  "main:packages/models/src/index.ts": [
    "import { proxify } from './proxify';",
    "export { registerModel } from './proxify';",
    "export const Users = proxify<IUsersModel>('IUsersModel');",
    "export const Rooms = proxify<IRoomsModel>('IRoomsModel');",
  ].join("\n"),
  "main:packages/models/src/proxify.ts": "export function proxify<T>(name: string): T { return {} as T; }\nexport function registerModel(name: string, model: unknown) {}",
  "main:packages/models/src/models/Base.ts": "export class BaseRaw { constructor(db: unknown, name: string, trash?: unknown, options?: unknown) {} }",
  "main:packages/models/src/models/Users.ts": [
    "import { BaseRaw } from './Base';",
    "export class UsersRaw extends BaseRaw {",
    "  constructor(db: unknown) {",
    "    super(db, 'users', undefined, { collectionNameResolver(name: string) { return name; } });",
    "  }",
    "}",
  ].join("\n"),
  "main:packages/models/src/models/Rooms.ts": [
    "import { BaseRaw } from './Base';",
    "export class RoomsRaw extends BaseRaw {",
    "  constructor(db: unknown) {",
    "    super(db, 'room');",
    "  }",
    "}",
    "export class RoomsEE extends RoomsRaw {}",
  ].join("\n"),
  "main:apps/meteor/server/models.ts": [
    "import { registerModel } from '@rocket.chat/models';",
    "import { UsersRaw } from '../../../packages/models/src/models/Users';",
    "import { RoomsEE } from '../../../packages/models/src/models/Rooms';",
    "declare const db: unknown;",
    "registerModel('IUsersModel', new UsersRaw(db));",
    "registerModel('IRoomsModel', () => new RoomsEE(db));",
  ].join("\n"),
  "main:apps/meteor/server/services/team.ts": [
    "import { ServiceClass, Presence } from '@rocket.chat/core-services';",
    "import { Users } from '@rocket.chat/models';",
    "export class TeamService extends ServiceClass {",
    "  protected name = 'team';",
    "  constructor() { super(); this.onEvent('user.nameChanged', () => {}); }",
    "  async create(uid: string) {",
    "    await Users.findOneById(uid);",
    "    await Presence.setStatus(uid, 'online');",
    "  }",
    "  private secret() {}",
    "  private async purge(uid: string) { await Users.trashFindOneById(uid); }",
    "}",
  ].join("\n"),
  "main:apps/meteor/server/services/startup.ts": [
    "import { api } from '@rocket.chat/core-services';",
    "import { TeamService } from './team';",
    "declare function isRunningMs(): boolean;",
    "export async function registerServices() {",
    "  api.registerService(new TeamService());",
    "  if (!isRunningMs()) {",
    "    const { Presence } = await import('@rocket.chat/presence');",
    "    api.registerService(new Presence());",
    "  }",
    "}",
  ].join("\n"),
  "main:ee/packages/presence/package.json": JSON.stringify({ name: "@rocket.chat/presence", main: "./dist/index.js" }),
  "main:ee/packages/presence/src/index.ts": [
    "import { ServiceClass, Team } from '@rocket.chat/core-services';",
    "import { Rooms } from '@rocket.chat/models';",
    "export class Presence extends ServiceClass {",
    "  protected name = 'presence';",
    "  async setStatus(uid: string, status: string) { await Rooms.updateOne({ uid }, { status }); await Team.create(uid); }",
    "}",
    "export { away } from './helpers';",
  ].join("\n"),
  "main:ee/packages/presence/src/helpers.ts": [
    "import { Presence } from '@rocket.chat/core-services';",
    "export const away = (uid: string) => Presence.setStatus(uid, 'away');",
  ].join("\n"),
  "main:ee/apps/presence-service/src/service.ts": [
    "import { api } from '@rocket.chat/core-services';",
    "void (async () => {",
    "  const { Presence } = await import('@rocket.chat/presence');",
    "  api.registerService(new Presence());",
    "})();",
  ].join("\n"),
  "main:apps/meteor/server/api/v1/rooms.ts": [
    "declare const API: any;",
    "API.v1.addRoute('rooms.info', { authRequired: true }, { async get() {}, async post() {} });",
    "const endpoints = API.v1",
    "  .get('rooms.list', {}, async () => {})",
    "  .post('rooms.create', {}, async () => {});",
  ].join("\n"),
  "main:apps/meteor/server/api/hooks.ts": [
    "declare class APIClass { constructor(o: unknown); addRoute(...a: unknown[]): void }",
    "class HookAPI extends APIClass {}",
    "const Api = new HookAPI({ apiPath: 'hooks/' });",
    "Api.addRoute(':integrationId/:token', {}, { post() {} });",
  ].join("\n"),
  "main:apps/meteor/server/events.ts": [
    "import { api } from '@rocket.chat/core-services';",
    "declare const user: unknown;",
    "void api.broadcast('user.nameChanged', user);",
    "void api.broadcastLocal('local.only');",
  ].join("\n"),
  "main:apps/meteor/server/cron/nps.ts": "import { cronJobs } from '@rocket.chat/cron';\nconst NAME = 'NPS';\nawait cronJobs.add(NAME, '0 3 * * *', async () => {});",
  "main:apps/meteor/client/lib/SDKClient.ts": [
    "declare const Meteor: any;",
    "function callMethod(method: string, ...args: unknown[]) { return Meteor.callAsync(method, ...args); }",
    "export const sdk = { rest: {} as any, call: (method: string, ...args: unknown[]) => callMethod(method, ...args), stream: (name: string) => name };",
  ].join("\n"),
  "main:apps/meteor/client/views/Room.tsx": [
    "import { useEndpoint, useMethod, useStream } from '@rocket.chat/ui-contexts';",
    "import { sdk } from '../lib/SDKClient';",
    "export function Room() {",
    "  const getInfo = useEndpoint('GET', '/v1/rooms.info');",
    "  const save = useMethod('saveSettings');",
    "  useStream('notify-room');",
    "  void sdk.rest.post('/v1/rooms.create', {});",
    "  void sdk.call('loadHistory');",
    "  return [getInfo, save];",
    "}",
  ].join("\n"),
  "main:packages/ddp-client/package.json": JSON.stringify({ name: "@rocket.chat/ddp-client", main: "./dist/index.js" }),
  "main:packages/ddp-client/src/index.ts": "export { LivechatClientImpl } from './livechat/LivechatClientImpl';",
  "main:packages/ddp-client/src/livechat/LivechatClientImpl.ts": [
    "export class LivechatClientImpl {",
    "  rest: any;",
    "  token = '';",
    "  static create(url: string) { return new LivechatClientImpl(); }",
    "  deleteVisitor() { return this.rest.delete(`/v1/livechat/visitor/${this.token}`); }",
    "}",
  ].join("\n"),
  "main:packages/livechat/src/api.ts": "import { LivechatClientImpl } from '@rocket.chat/ddp-client';\nexport const Livechat = LivechatClientImpl.create('ws://host');",
  "main:packages/livechat/src/actions.ts": "import { Livechat } from './api';\nexport const leave = () => Livechat.deleteVisitor();",
};

const COMPONENTS: Record<string, string> = {};
for (const key of Object.keys(FILES)) {
  if (key.startsWith("main:apps/meteor/client/")) COMPONENTS[key] = "web-client";
  else if (key.startsWith("main:apps/meteor/")) COMPONENTS[key] = "rocketchat";
  else if (key.startsWith("main:ee/apps/presence-service/")) COMPONENTS[key] = "presence-service";
  else if (key.startsWith("main:packages/livechat/")) COMPONENTS[key] = "livechat";
}

const extracted = (() => {
  const program = programFrom(FILES, COMPONENTS);
  return extractAll(program, loadRules(["generic@1", "meteor@1", "rocketchat@1"]), 3);
})();

const usage = usageOfFiles(programFrom(FILES, COMPONENTS));

const site = (at: string) => {
  const s = extracted.sites.filter((x) => `${x.repo}:${x.path}:${x.line}` === at);
  return s.map((x) => ({ detector: x.detector, method: x.method ? display(x.method) : null, address: display(x.address), hops: hopKinds(x.address), components: x.components }));
};

describe("Rocket.Chat rule pack", () => {
  it("reads REST routes of the router, its chains, and other API class instances", () => {
    const http = extracted.routes.filter((r) => r.kind === "http").map((r) => `${r.method} ${r.template}`).sort();
    expect(http).toEqual(["GET /api/v1/rooms.info", "GET /api/v1/rooms.list", "POST /api/hooks/:integrationId/:token", "POST /api/v1/rooms.create", "POST /api/v1/rooms.info"]);
  });

  it("reads service actions and where each service is registered, with the condition", () => {
    const actions = extracted.routes.filter((r) => r.kind === "broker-action");
    expect(actions.map((r) => r.template).sort()).toEqual(["presence.setStatus", "team.create"]);
    const presence = actions.find((r) => r.template === "presence.setStatus");
    expect(presence?.components).toEqual(["presence-service", "rocketchat"]);
    expect((presence?.extra?.registrations as Array<{ guard: string; components: string[] }>).map((r) => [r.guard, r.components])).toEqual([
      ["!isRunningMs()", ["rocketchat"]],
      ["", ["presence-service"]],
    ]);
  });

  it("maps proxies to actions and models to their collections", () => {
    expect(site("main:apps/meteor/server/services/team.ts:7")).toEqual([
      { detector: "rocketchat.model-call", method: null, address: "users", hops: ["const", "import"], components: ["rocketchat"] },
    ]);
    expect(site("main:apps/meteor/server/services/team.ts:8")[0]).toMatchObject({ detector: "rocketchat.service-call", address: "presence.setStatus" });
    // deleted records of every model live in one collection
    expect(site("main:apps/meteor/server/services/team.ts:11")[0]).toMatchObject({ detector: "rocketchat.model-trash-call", address: "rocketchat__trash" });
    expect(site("main:ee/packages/presence/src/index.ts:5").map((s) => s.address).sort()).toEqual(["rocketchat_room", "team.create"]);
    expect(site("main:ee/packages/presence/src/index.ts:5")[0]?.components).toEqual(["presence-service", "rocketchat"]);
  });

  it("keeps the condition under which a part loads a package: the server loads presence only when not in microservices", () => {
    // the server reaches the package only through `if (!isRunningMs()) await import('@rocket.chat/presence')`
    expect(usage.get("main:ee/packages/presence/src/helpers.ts")).toEqual({ components: ["presence-service", "rocketchat"], guards: { rocketchat: ["!isRunningMs()"] } });
    // its own service loads it unconditionally, and the server's own code needs no condition
    expect(usage.get("main:apps/meteor/server/services/team.ts")).toEqual({ components: ["rocketchat"], guards: {} });
  });

  it("finds events published and subscribed, but not those that stay in the process", () => {
    expect(site("main:apps/meteor/server/events.ts:3")).toMatchObject([{ detector: "rocketchat.broadcast", address: "user.nameChanged" }]);
    expect(site("main:apps/meteor/server/events.ts:4")).toEqual([]);
    expect(site("main:apps/meteor/server/services/team.ts:5")).toMatchObject([{ detector: "rocketchat.on-event", address: "user.nameChanged" }]);
  });

  it("reads client calls with the REST base and drops the SDK's own internals", () => {
    expect(site("main:apps/meteor/client/views/Room.tsx:4")).toMatchObject([{ method: "GET", address: "/api/v1/rooms.info" }]);
    expect(site("main:apps/meteor/client/views/Room.tsx:5")).toMatchObject([{ detector: "rocketchat.use-method", address: "saveSettings" }]);
    expect(site("main:apps/meteor/client/views/Room.tsx:6")).toMatchObject([{ detector: "rocketchat.use-stream", address: "notify-room" }]);
    expect(site("main:apps/meteor/client/views/Room.tsx:7")).toMatchObject([{ method: "POST", address: "/api/v1/rooms.create" }]);
    expect(site("main:apps/meteor/client/views/Room.tsx:8")).toMatchObject([{ detector: "rocketchat.sdk-call", address: "loadHistory" }]);
    expect(extracted.sites.filter((s) => s.path.endsWith("SDKClient.ts"))).toEqual([]);
  });

  it("follows the livechat client's methods to the widget's calls", () => {
    expect(site("main:packages/livechat/src/actions.ts:2")).toEqual([
      { detector: "rocketchat.rest-client", method: "DELETE", address: "/api/v1/livechat/visitor/{dyn}", hops: ["const", "import", "reexport", "wrapper"], components: ["livechat"] },
    ]);
    expect(extracted.sites.filter((s) => s.path.includes("ddp-client"))).toEqual([]);
  });

  it("reads cron jobs, also through constants", () => {
    expect(site("main:apps/meteor/server/cron/nps.ts:3")).toMatchObject([{ detector: "rocketchat.cron-job", address: "NPS", hops: ["const"] }]);
  });
});
