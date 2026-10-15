import express from "express";

const app = express();
app.get("/orders", (_req, res) => {
  res.json([]);
});
app.listen(3000);
