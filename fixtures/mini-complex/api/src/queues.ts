import { Queue } from "bullmq";

const connection = { host: process.env.REDIS_HOST ?? "redis", port: 6379 };

export const EMAIL_QUEUE = "emails";
export const emailQueue = new Queue(EMAIL_QUEUE, { connection });
