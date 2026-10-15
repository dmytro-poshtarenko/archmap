import { Router } from "express";

const router = Router();

router
  .route("/me")
  .get((_req, res) => {
    res.json({ name: "Ada" });
  })
  .put((req, res) => {
    res.json(req.body);
  });

export default router;
