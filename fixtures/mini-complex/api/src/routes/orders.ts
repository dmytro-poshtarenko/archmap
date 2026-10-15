import { Router } from "express";
import { emailQueue } from "../queues.js";

export const ordersRouter = Router();

ordersRouter.get("/", (_req, res) => {
  res.json([]);
});

ordersRouter.post("/", async (req, res) => {
  await emailQueue.add("order-created", { items: req.body.items });
  res.status(201).json({ ok: true });
});

ordersRouter.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});
