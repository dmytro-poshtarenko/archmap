import { Router } from "express";

export const ordersRouter = Router();

ordersRouter.get("/orders/search", (_req, res) => {
  res.json([]);
});

ordersRouter.get("/orders/:id/items", (req, res) => {
  res.json({ order: req.params.id, items: [] });
});
