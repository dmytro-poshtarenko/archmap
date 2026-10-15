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

/** An infrastructure file, alone (`repo:glob`) or with the gateway component its rules belong to. */
export const InfraFile = z.union([RepoGlob, z.strictObject({ file: RepoGlob, gateway: z.string() })]);

export const ComponentKind = z.enum(["client", "service", "gateway", "bus", "database", "external", "scheduler"]);
export type ComponentKind = z.infer<typeof ComponentKind>;

export const ComponentConfig = z.strictObject({
  id: Id,
  kind: ComponentKind,
  /** Code mapped to the component; empty for parts known only from infrastructure (database, bus, gateway). */
  include: z.array(RepoGlob).default([]),
  exclude: z.array(RepoGlob).default([]),
  /** Other names of the component in the infrastructure: compose services, workloads, host names. */
  aliases: z.array(z.string()).default([]),
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
      /** Extraction rule packs, read from `rules/<id>@<version>.yaml`, in order. */
      packs: z.array(z.string().regex(/^[a-z0-9-]+@\d+$/, "expected 'id@version'")).default([]),
      /** How many wrapper calls a call site may be lifted through to reach a fixed address. */
      liftDepth: z.number().int().min(0).max(8).default(3),
    })
    .prefault({}),
  infra: z
    .strictObject({
      profile: z.string().optional(),
      /** Environment of the deployment profile; it wins over `.env` files and compose defaults. */
      env: z.record(z.string(), z.string()).default({}),
      compose: z.array(RepoGlob).default([]),
      helm: z
        .array(
          z.strictObject({
            chart: RepoGlob,
            values: z.array(RepoGlob).default([]),
            release: z.string().default("release"),
            gateway: z.string().default("ingress"),
          }),
        )
        .default([]),
      /** Kubernetes manifests; the gateway names the component of their Ingress (default `ingress`). */
      k8s: z.array(InfraFile).default([]),
      terraform: z.array(InfraFile).default([]),
      /** nginx configurations; the gateway names the component running them (default `nginx`). */
      nginx: z.array(InfraFile).default([]),
    })
    .prefault({}),
  interactionTypes: z.array(InteractionType).default(["http", "ddp", "broker", "db", "trigger"]),
  labelling: z
    .strictObject({
      /** Candidate pattern packs, read from `labelling/patterns/<id>@<version>.yaml`. */
      packs: z.array(z.string().regex(/^[a-z0-9-]+@\d+$/, "expected 'id@version'")).default([]),
      /** Files read in full to estimate how many call sites the text search misses. */
      gapFiles: z.number().int().nonnegative().default(20),
    })
    .prefault({}),
  /** LLM settings are defined by the LLM layer (milestone M7). */
  llm: z.record(z.string(), z.unknown()).optional(),
  /** Measurement protocol; the defaults serve fixtures, a real target sets every value. */
  experiment: z
    .strictObject({
      seeds: z
        .strictObject({ split: z.number().int(), sample: z.number().int(), bootstrap: z.number().int() })
        .prefault({ split: 1, sample: 1, bootstrap: 1 }),
      devShare: z.number().gt(0).lt(1).default(0.3),
      sample: z
        .strictObject({
          main: z.number().int().positive(),
          minPerType: z.number().int().nonnegative(),
          heldout: z.number().int().nonnegative(),
        })
        .prefault({ main: 400, minPerType: 30, heldout: 100 }),
      secondAnnotator: z.number().min(0).max(1).default(0.2),
    })
    .prefault({}),
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
