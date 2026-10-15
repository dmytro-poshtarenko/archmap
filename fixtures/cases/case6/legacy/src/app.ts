import express from "express";

// Old invoicing system, kept read-only until the migration ends.
const app = express();
app.get("/orders/:orderId", (req, res) => {
  res.json({ invoice: req.params.orderId });
});
app.listen(3000);
