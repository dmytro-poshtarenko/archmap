import { Router } from "express";
import { ordersRouter } from "./orders.js";
import usersRouter from "./users.js";

export const apiRouter = Router();
apiRouter.use("/orders", ordersRouter);
apiRouter.use("/users", usersRouter);
