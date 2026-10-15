import { describe, expect, it } from "vitest";
import { extractRocketChatCatalog } from "../../src/labelling/catalogs/rocketchat.js";
import { fakeSnapshot } from "./fixtures.js";

// Synthetic declarations in the shapes Rocket.Chat uses; no code is copied from it.
const snapshot = fakeSnapshot({
  "main:packages/rest-typings/src/v1/rooms.ts": {
    text: [
      "export type RoomsEndpoints = {",
      "\t'/v1/rooms.info': {",
      "\t\tGET: (params: RoomsInfoProps) => { room: IRoom };",
      "\t};",
      "\t'/v1/rooms.delete': {",
      "\t\tPOST: (params: { roomId: string }) => void;",
      "\t};",
      "};",
    ].join("\n"),
  },
  "main:apps/meteor/server/api/v1/misc.ts": {
    text: [
      "API.v1.addRoute(",
      "\t'me.extra',",
      "\t{ authRequired: true },",
      "\t{",
      "\t\tasync get() {",
      "\t\t\treturn API.v1.success();",
      "\t\t},",
      "\t},",
      ");",
      "API.v1.get(",
      "\t'rooms.info',",
      "\t{ authRequired: true },",
      "\tasync function action() {},",
      ");",
    ].join("\n"),
    component: "rocketchat",
  },
  "main:apps/meteor/server/meteor-methods/settings.ts": {
    text: [
      "declare module '@rocket.chat/ddp-client' {",
      "\tinterface ServerMethods {",
      "\t\tsaveSettings(settings: unknown): boolean;",
      "\t\t'UserPresence:away'(): boolean;",
      "\t}",
      "}",
    ].join("\n"),
    component: "rocketchat",
  },
  "main:ee/apps/ddp-streamer/src/methods/presence.ts": {
    text: ["export function register(server: Server): void {", "\tserver.methods({", "\t\tasync 'UserPresence:away'() {", "\t\t\treturn true;", "\t\t},", "\t});", "}"].join("\n"),
    component: "ddp-streamer-service",
  },
  "main:packages/ddp-client/src/types/streams.ts": {
    text: ["export interface StreamerEvents {", "\t'notify-room': [{ key: string; args: [] }];", "\t'room-messages': [{ key: string; args: [] }];", "}"].join("\n"),
  },
  "main:packages/core-services/src/index.ts": {
    text: "export const Presence = proxify<IPresence>('presence');\nexport const Team = proxify<ITeamService>('team');\n",
  },
  "main:packages/core-services/src/types/IPresence.ts": {
    text: [
      "export interface IPresence extends IServiceClass {",
      "\tsetStatus(uid: string, status: string): Promise<boolean>;",
      "\tremoveConnection(uid: string): Promise<void>;",
      "}",
    ].join("\n"),
  },
  "main:packages/core-services/src/types/ITeamService.ts": {
    text: ["export interface ITeamService {", "\tcreate(uid: string): Promise<void>;", "}"].join("\n"),
  },
  "main:packages/core-services/src/events/Events.ts": {
    text: ["export type EventSignatures = {", "\t'user.nameChanged'(user: unknown): void;", "\t'watch.users'(data: unknown): void;", "};"].join("\n"),
  },
  "main:packages/models/src/index.ts": {
    text: "export const Users = proxify<IUsersModel>('IUsersModel');\nexport const Rooms = proxify<IRoomsModel>('IRoomsModel');\n",
  },
  "main:apps/meteor/server/models.ts": {
    text: "registerModel('IUsersModel', new UsersRaw(db));\nregisterModel('IRoomsModel', new RoomsRaw(db));\n",
    component: "rocketchat",
  },
  "main:packages/models/src/models/Users.ts": {
    text: [
      "export class UsersRaw extends BaseRaw<IUser> {",
      "\tconstructor(db: Db) {",
      "\t\tsuper(db, 'users', undefined, {",
      "\t\t\tcollectionNameResolver(name) {",
      "\t\t\t\treturn name;",
      "\t\t\t},",
      "\t\t});",
      "\t}",
      "}",
    ].join("\n"),
  },
  "main:packages/models/src/models/Rooms.ts": {
    text: ["export class RoomsRaw extends BaseRaw<IRoom> {", "\tconstructor(db: Db) {", "\t\tsuper(db, 'room');", "\t}", "}"].join("\n"),
  },
  "main:apps/meteor/server/cron/nps.ts": { text: "cronJobs.add('NPS', '0 3 * * *', async () => {});\n", component: "rocketchat" },
});

describe("Rocket.Chat catalog", () => {
  it("reads every kind of target from the typed declarations", () => {
    const entries = extractRocketChatCatalog(snapshot);
    expect(entries.map((e) => e.key)).toEqual([
      "action:-:presence.removeConnection@presence-service",
      "action:-:presence.setStatus@presence-service",
      "action:-:team.create@rocketchat",
      "coll:-:rocketchat_room@mongo",
      "coll:-:users@mongo",
      "ddp:call:UserPresence:away@ddp-streamer-service",
      "ddp:call:UserPresence:away@rocketchat",
      "ddp:call:saveSettings@rocketchat",
      "ddp:sub:notify-room@ddp-streamer-service",
      "ddp:sub:room-messages@ddp-streamer-service",
      "event:-:user.nameChanged@*",
      "event:-:watch.users@*",
      "http:GET:/api/v1/me.extra@rocketchat",
      "http:GET:/api/v1/rooms.info@rocketchat",
      "http:POST:/api/v1/rooms.delete@rocketchat",
      "timer:-:NPS@rocketchat",
    ]);
    const users = entries.find((e) => e.key === "coll:-:users@mongo");
    expect(users).toMatchObject({ note: "Users (UsersRaw)", source: "main:packages/models/src/models/Users.ts:3" });
    expect(entries.find((e) => e.key === "http:GET:/api/v1/rooms.info@rocketchat")?.note).toBe("rest-typings");
  });
});
