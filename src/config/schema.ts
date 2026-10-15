import { z } from "zod";

const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "lowercase id: letters, digits, '.', '_' or '-'");

/** `repo:glob`, e.g. `main:apps/meteor/**`. */
export const RepoGlob = z.string().regex(/^[a-z0-9][a-z0-9._-]*:.+$/, "expected 'repo:glob'");

export const InteractionType = z.enum(["http", "ddp", "broker", "db", "trigger"]);
export type InteractionType = z.infer<typeof InteractionType>;

export const RepoRole = z.enum(["main", "desktop", "heldout", "infra", "other"]);
export type RepoRole = z.infer<typeof RepoRole>;

export const RepoConfig = z
  .strictObject({
    id: Id,
    /** Git remote. Bare `host/owner/name` is read as an https URL. */
    url: z.string().min(1).optional(),
    /** Local directory used as is instead of a fetched checkout (fixtures), relative to the config file. */
    path: z.string().min(1).optional(),
    /** Pinned commit; may also come from the lock file written by `archmap pin`. */
    sha: z.string().regex(/^[0-9a-f]{40}$/, "40-character commit SHA").optional(),
    /** Branch or tag to pin; the remote's default branch when absent. */
    branch: z.string().optional(),
    role: RepoRole,
    /** Licence of files not covered by a licence zone. */
    licence: z.string().default("unknown"),
    /** Whether such files may be quoted or published. */
    publishable: z.boolean().default(false),
  })
  .refine((r) => (r.url === undefined) !== (r.path === undefined), "a repo needs exactly one of 'url' or 'path'");
export type RepoConfig = z.infer<typeof RepoConfig>;

export const LicenceZone = z.strictObject({
  repo: Id,
  globs: z.array(z.string()).min(1),
  licence: z.string(),
  publishable: z.boolean(),
});

export const ComponentKind = z.enum(["client", "service", "gateway", "bus", "database", "external", "scheduler"]);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const ComponentConfig = z.strictObject({
  id: Id,
  kind: ComponentKind,
  /** Code mapped to the component; empty for parts known only from infrastructure (database, bus, gateway). */
  include: z.array(RepoGlob).default([]),
  exclude: z.array(RepoGlob).default([]),
});
export type ComponentConfig = z.infer<typeof ComponentConfig>;

export const TargetConfig = z.strictObject({
  name: Id,
  repos: z.array(RepoConfig).min(1),
  licenceZones: z.array(LicenceZone).default([]),
  codeUnits: z
    .strictObject({
      /** Extra unit roots besides package.json directories, as `repo:glob` over directories. */
      splitDirs: z.array(RepoGlob).default([]),
    })
    .prefault({}),
  components: z.array(ComponentConfig).default([]),
  /** Globs excluded from the inventory in every repository. */
  exclude: z.array(z.string()).default([]),
  rules: z
    .strictObject({
      packs: z.array(z.string()).default([]),
      bindings: z.array(z.string()).default([]),
      liftDepth: z.number().int().min(0).max(8).default(3),
    })
    .prefault({}),
  infra: z
    .strictObject({
      profile: z.string().optional(),
      compose: z.array(RepoGlob).default([]),
      helm: z.array(z.strictObject({ chart: RepoGlob, values: z.array(RepoGlob).default([]) })).default([]),
      k8s: z.array(RepoGlob).default([]),
      terraform: z.array(RepoGlob).default([]),
      nginx: z.array(RepoGlob).default([]),
    })
    .prefault({}),
  interactionTypes: z.array(InteractionType).default(["http", "ddp", "broker", "db", "trigger"]),
  /** LLM settings are defined by the LLM layer (milestone M7). */
  llm: z.record(z.string(), z.unknown()).optional(),
  experiment: z.strictObject({
    seeds: z.strictObject({ split: z.number().int(), sample: z.number().int(), bootstrap: z.number().int() }),
    devShare: z.number().gt(0).lt(1),
    sample: z.strictObject({
      main: z.number().int().positive(),
      minPerType: z.number().int().nonnegative(),
      heldout: z.number().int().nonnegative(),
    }),
    secondAnnotator: z.number().min(0).max(1),
  }),
});
export type TargetConfig = z.infer<typeof TargetConfig>;

/** Lock file written by `archmap pin`: repo id -> pinned commit. */
export const LockFile = z.strictObject({
  pinnedAt: z.string(),
  repos: z.record(z.string(), z.string().regex(/^[0-9a-f]{40}$/)),
});
export type LockFile = z.infer<typeof LockFile>;

export function splitRepoGlob(value: string): { repo: string; glob: string } {
  const at = value.indexOf(":");
  return { repo: value.slice(0, at), glob: value.slice(at + 1) };
}
