import { Router } from "express";
import { authenticateSession } from "../lib/sessionAuth.js";
import { registerRoute } from "../lib/docs.js";
import { getThemes, createTheme } from "../controllers/themeController.js";
import { validate, createThemeSchema } from "../middleware/validation.js";

const router = Router();

router.get("/", getThemes);
router.post("/", authenticateSession, validate(createThemeSchema), createTheme);

registerRoute({
  method: "GET",
  path: "/themes",
  summary: "Get public themes",
  responses: {
    "200":
      '{"themes":[{"id":"string","name":"string","author":{"username":"string"},"colors":{}}],"pagination":{"page":1,"limit":24,"totalItems":1,"totalPages":1,"itemsReturned":1}}',
  },
});

registerRoute({
  method: "POST",
  path: "/themes",
  summary: "Create a theme",
  auth: true,
  responses: { "200": '{"id":"string"}' },
});

export default router;
