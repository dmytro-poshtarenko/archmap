import type { Db } from "../../store/db.js";
import { cacheKey, readAnswer } from "../cache.js";
import type { LlmAnswer, LlmProvider, LlmRequest, ProviderId } from "../types.js";

/**
 * Recorded answers only: every request must already be in the answer
 * cache of the provider and model it was recorded with. Offline tests and
 * reproductions of a run use it; a request never recorded is an error.
 */
export class ReplayProvider implements LlmProvider {
  readonly id = "replay" as const;

  constructor(
    private readonly db: Db,
    readonly recorded: { provider: ProviderId; model: string },
  ) {}

  get model(): string {
    return this.recorded.model;
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmAnswer<T>> {
    const a = readAnswer(this.db, cacheKey(this.recorded.provider, this.recorded.model, req));
    if (!a) throw new Error(`replay: no recorded answer for ${req.task} ${req.subject} (repeat ${req.repeat})`);
    return a as LlmAnswer<T>;
  }
}
