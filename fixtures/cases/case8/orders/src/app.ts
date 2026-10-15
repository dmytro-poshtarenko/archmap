import express from "express";

const app = express();
app.get("/api/settings/:name", (req, res) => {
  res.json({ url: `/api/${req.params.name}` });
});
app.post("/api/orders-sync", (_req, res) => {
  res.json({ ok: true });
});
app.listen(3000);
