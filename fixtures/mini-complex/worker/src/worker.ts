import { Worker } from "bullmq";

const connection = { host: process.env.REDIS_HOST ?? "redis", port: 6379 };

new Worker(
  "emails",
  async (job) => {
    const response = await fetch(`${process.env.API_URL}/api/orders/${job.data.id}`);
    console.log(job.name, await response.json());
  },
  { connection },
);
