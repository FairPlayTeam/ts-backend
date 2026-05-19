import { Router } from "express";
import { authenticateSession } from "../lib/sessionAuth.js";
import {
  getUserTheme,
  updateUserTheme,
  clearUserTheme,
} from "../controllers/themeController.js";
import { validate, updateUserThemeSchema } from "../middleware/validation.js";

const router = Router();

router.get("/", authenticateSession, getUserTheme);
router.patch(
  "/",
  authenticateSession,
  validate(updateUserThemeSchema),
  updateUserTheme,
);
router.delete("/", authenticateSession, clearUserTheme);

export default router;
