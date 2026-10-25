import { Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { SessionAuthRequest } from "../lib/sessionAuth.js";

export async function getThemes(req: Request, res: Response): Promise<void> {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(
      1,
      Math.min(50, parseInt(req.query.limit as string) || 24),
    );
    const skip = (page - 1) * limit;

    const where = { isPublic: true };

    const [totalItems, themes] = await Promise.all([
      prisma.theme.count({ where }),
      prisma.theme.findMany({
        where,
        include: {
          author: {
            select: { username: true },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const totalPages = Math.ceil(totalItems / limit);

    res.json({
      themes,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
        itemsReturned: themes.length,
      },
    });
  } catch (error) {
    console.error("Get themes error:", error);
    res.status(500).json({ error: "Failed to get themes" });
  }
}

export async function createTheme(
  req: SessionAuthRequest,
  res: Response,
): Promise<void> {
  try {
    const { name, description, isPublic, colors } = req.body;

    const theme = await prisma.theme.create({
      data: {
        name,
        description: description || null,
        isPublic,
        authorId: req.user!.id,
        colors,
      },
    });

    if (!theme.isPublic) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { activeThemeId: theme.id },
      });
      res.setHeader(
        "Set-Cookie",
        `theme=${encodeURIComponent(JSON.stringify(theme.colors))}; path=/; max-age=31536000`,
      );
    }

    res.status(201).json(theme);
  } catch (error) {
    console.error("Create theme error:", error);
    res.status(500).json({ error: "Failed to create theme" });
  }
}

export async function getUserTheme(
  req: SessionAuthRequest,
  res: Response,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { activeTheme: true },
    });

    if (!user?.activeTheme) {
      res.json({ theme: null });
      return;
    }

    res.json({ theme: user.activeTheme.colors });
  } catch (error) {
    console.error("Get user theme error:", error);
    res.status(500).json({ error: "Failed to get user theme" });
  }
}

export async function updateUserTheme(
  req: SessionAuthRequest,
  res: Response,
): Promise<void> {
  try {
    const { themeId } = req.body;

    const theme = await prisma.theme.findUnique({
      where: { id: themeId },
    });

    if (!theme) {
      res.status(404).json({ error: "Theme not found" });
      return;
    }

    if (!theme.isPublic && theme.authorId !== req.user!.id) {
      res
        .status(403)
        .json({ error: "Cannot apply a private theme you do not own" });
      return;
    }

    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { activeThemeId: true },
    });

    if (currentUser?.activeThemeId !== theme.id) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { activeThemeId: theme.id },
      });
    }

    res.json({ success: true, colors: theme.colors });
  } catch (error) {
    console.error("Update user theme error:", error);
    res.status(500).json({ error: "Failed to update user theme" });
  }
}

export async function clearUserTheme(
  req: SessionAuthRequest,
  res: Response,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { activeThemeId: true },
    });

    await prisma.user.update({
      where: { id: req.user!.id },
      data: { activeThemeId: null },
    });
    res.setHeader("Set-Cookie", `theme=; path=/; max-age=0`);
    res.json({ success: true });
  } catch (error) {
    console.error("Clear user theme error:", error);
    res.status(500).json({ error: "Failed to clear user theme" });
  }
}
