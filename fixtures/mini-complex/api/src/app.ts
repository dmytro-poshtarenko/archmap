import express from "express";
import { apiRouter } from "./routes/index.js";

const app = express();
app.use(express.json());
app.use("/api", apiRouter);
app.listen(Number(process.env.PORT ?? 3000));
