import { Router } from "express";

export const ordersRouter = Router();

ordersRouter.get("/orders", (_req, res) => {
  res.json([]);
});

ordersRouter.post("/orders/archive", (req, res) => {
  res.json({ archived: req.body.id });
});
