import express from "express";

const app = express();
app.get("/orders", (_req, res) => {
  res.json({ archived: [] });
});
app.listen(3000);
