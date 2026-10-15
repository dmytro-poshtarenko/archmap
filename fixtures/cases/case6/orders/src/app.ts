import express from "express";

const app = express();
app.get("/orders/:id", (req, res) => {
  res.json({ id: req.params.id });
});
app.listen(3000);
