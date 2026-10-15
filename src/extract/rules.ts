import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import { InteractionType, RepoGlob } from "../config/schema.js";
import { hashOf } from "../core/hash.js";
import { toolRoot } from "../core/paths.js";
import { DETECTORS } from "./detectors/index.js";

/**
 * Where a binding reads a value: an argument (or one of its properties), a
 * member name, a value captured by the instance's factory, a constant, the
 * concatenation of several of these, or a lookup in a table that a detector
 * builds from the code (e.g. model interface → collection).
 */
export type ValueSpec =
  | { arg: number; key?: string }
  | { member: number }
  | { factory: string }
  | { value: string }
  | { default: string }
  | { join: ValueSpec[] }
  | { lookup: string; key: ValueSpec };
const ValueSpec: z.ZodType<ValueSpec> = z.lazy(() =>
  z.union([
    z.strictObject({ arg: z.number().int().min(0), key: z.string().optional() }),
    z.strictObject({ member: z.number().int() }),
    z.strictObject({ factory: z.string() }),
    z.strictObject({ value: z.string() }),
    z.strictObject({ default: z.string() }),
    z.strictObject({ join: z.array(ValueSpec).min(1) }),
    z.strictObject({ lookup: z.string(), key: ValueSpec }),
  ]),
);
/** One spec, or alternatives tried in order until one yields a value. */
const ValueSpecs = z.union([ValueSpec, z.array(ValueSpec).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));

/**
 * The callee a binding recognises, as a root followed by members
 * (`axios.get` is root `axios` with member `get`):
 * - `global`: the root is a name bound nowhere in scope (`fetch`);
 * - `module` + `export`: the root is imported from that module (`axios`, default);
 * - `name`: the root is named so, wherever it comes from;
 * - `instance`: the root was created by a factory (`axios.create(...)`); `a|b` accepts several;
 * - `receiver: any`: any root, only the members count (guard it with `fileImports`).
 */
const Callee = z
  .strictObject({
    global: z.string().optional(),
    module: z.string().optional(),
    export: z.string().optional(),
    name: z.string().optional(),
    instance: z.string().optional(),
    receiver: z.literal("any").optional(),
    /** One regular expression per member after the root, matched in full. */
    members: z.array(z.string()).default([]),
    new: z.boolean().default(false),
    /** The file must import this module. */
    fileImports: z.string().optional(),
    /** The call must be in a file matching this `repo:glob`. */
    file: RepoGlob.optional(),
  })
  .refine((c) => [c.global, c.module, c.name, c.instance, c.receiver].filter((x) => x !== undefined).length === 1, {
    message: "a callee needs exactly one of global, module, name, instance or receiver",
  });
export type Callee = z.infer<typeof Callee>;

const Role = z.enum(["request", "publish", "subscribe", "access", "schedule"]);

const Binding = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  type: InteractionType,
  role: Role,
  callee: Callee,
  /** Path for HTTP; method, stream, action, queue, collection or job name for the other types. */
  address: ValueSpecs,
  /** HTTP method. */
  method: ValueSpecs.optional(),
  /** Base address joined before the path (HTTP only). */
  base: ValueSpecs.optional(),
  note: z.string().optional(),
});
export type Binding = z.infer<typeof Binding> & { qualified: string };

const Factory = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  callee: Callee,
  values: z.record(z.string(), ValueSpecs),
});
export type Factory = z.infer<typeof Factory>;

const ValueSourceSpec = z.strictObject({ callee: z.string(), kind: z.enum(["setting", "env"]), arg: z.number().int().min(0).default(0) });

const PackFile = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  description: z.string(),
  /** Code detectors of this pack (route rules and patterns that bindings cannot express). */
  detectors: z.array(z.string()).default([]),
  bindings: z.array(Binding).default([]),
  factories: z.array(Factory).default([]),
  /** Calls that yield a setting or environment value, e.g. `settings.get`. */
  valueSources: z.array(ValueSourceSpec).default([]),
  /**
   * Client library code (`repo:glob`). A call inside it is never a site of its
   * own: it is lifted to the application code calling the library, or dropped.
   */
  libraries: z.array(RepoGlob).default([]),
  /** Library classes whose methods wrap requests: calls of those methods on an instance are lifted through. */
  facades: z.array(z.strictObject({ class: z.string(), file: RepoGlob })).default([]),
});

export interface RuleSet {
  refs: string[];
  bindings: Binding[];
  factories: Map<string, Factory>;
  /** Route detectors and table providers, by id. */
  detectors: string[];
  valueSources: Array<z.infer<typeof ValueSourceSpec>>;
  libraries: string[];
  facades: Array<{ class: string; file: string }>;
  /** Hash of the packs and detector versions; part of the freeze manifest. */
  hash: string;
}

export class RulesError extends Error {}

/** Version of the extraction engine itself; bumped whenever its behaviour changes. */
export const ENGINE_VERSION = 1;

export function loadRules(refs: string[], root = toolRoot): RuleSet {
  const bindings: Binding[] = [];
  const factories = new Map<string, Factory>();
  const detectors: string[] = [];
  const valueSources: RuleSet["valueSources"] = [];
  const libraries: string[] = [];
  const facades: RuleSet["facades"] = [];
  const material: unknown[] = [ENGINE_VERSION];
  for (const ref of refs) {
    const file = join(root, "rules", `${ref}.yaml`);
    if (!existsSync(file)) throw new RulesError(`rule pack ${ref} not found at ${file}`);
    const text = readFileSync(file, "utf8");
    const parsed = PackFile.safeParse(parseYaml(text));
    if (!parsed.success) throw new RulesError(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
    const pack = parsed.data;
    if (`${pack.id}@${pack.version}` !== ref) throw new RulesError(`${file} declares ${pack.id}@${pack.version}, expected ${ref}`);
    for (const f of pack.factories) factories.set(f.id, f);
    for (const b of pack.bindings) {
      for (const f of b.callee.instance?.split("|") ?? []) {
        if (!factories.has(f)) throw new RulesError(`${ref}: binding ${b.id} uses unknown factory ${f}`);
      }
      bindings.push({ ...b, qualified: `${pack.id}.${b.id}` });
    }
    for (const d of pack.detectors) {
      const detector = DETECTORS[d];
      if (!detector) throw new RulesError(`${ref}: unknown detector ${d}`);
      detectors.push(d);
      material.push({ detector: d, version: detector.version });
    }
    valueSources.push(...pack.valueSources);
    libraries.push(...pack.libraries);
    facades.push(...pack.facades);
    material.push(text);
  }
  return { refs, bindings, factories, detectors, valueSources, libraries, facades, hash: hashOf(material) };
}
