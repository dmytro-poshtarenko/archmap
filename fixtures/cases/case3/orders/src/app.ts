import express from "express";
import { ordersRouter } from "./orders.js";

const app = express();
app.use(express.json());
app.use("/api", ordersRouter);
app.listen(3000);
