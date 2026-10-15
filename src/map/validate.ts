import { LikeC4 } from "likec4";

export interface Diagnostic {
  message: string;
  line?: number;
  source?: string;
}

/** Diagnostics LikeC4 reports for a workspace directory: none means the map is valid. */
export async function validateWorkspace(dir: string): Promise<Diagnostic[]> {
  const likec4 = await LikeC4.fromWorkspace(dir, { printErrors: false, logger: false });
  try {
    return likec4.getErrors().map((e) => ({ message: e.message, line: e.line, source: e.sourceFsPath }));
  } finally {
    await likec4.dispose();
  }
}
