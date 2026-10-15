import { z } from "zod";
import { loadTemplate, render, TEMPLATES } from "../prompts.js";
import type { LlmRequest } from "../types.js";

export const ProbeAnswer = z.object({
  routes: z.array(z.object({ kind: z.enum(["http", "ddp-method", "ddp-sub", "broker-action"]), method: z.string().nullable(), name: z.string() })),
});
export type ProbeAnswer = z.infer<typeof ProbeAnswer>;

/**
 * Task (d): the model gets only the project and the path of a file, no
 * code, and lists the routes it believes the file declares. What it lists
 * correctly is remembered from training data, not read.
 */
export function probeRequest(project: string, path: string, effort: LlmRequest["effort"], repeat = 0): LlmRequest<ProbeAnswer> {
  const t = loadTemplate(TEMPLATES.probe);
  return {
    task: "memo-probe",
    template: TEMPLATES.probe,
    subject: path,
    system: t.system,
    user: render(t.user, { project, path }),
    schema: ProbeAnswer,
    maxTokens: 4000,
    effort,
    repeat,
  };
}
