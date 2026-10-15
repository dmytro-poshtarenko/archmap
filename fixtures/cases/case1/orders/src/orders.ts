import { Router } from "express";

export const ordersRouter = Router();

ordersRouter.get("/orders", (_req, res) => {
  res.json([]);
});
