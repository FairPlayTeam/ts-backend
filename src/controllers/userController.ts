import { Request, Response } from 'express';
import { AuthRequest } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

export const getUsers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        followerCount: true,
        videoCount: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
};

export const getUserById = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const userId = req.params.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        bannerUrl: true,
        bio: true,
        followerCount: true,
        followingCount: true,
        videoCount: true,
        totalViews: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
};

export const updateProfile = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const userId = req.user!.id;
  const { displayName, bio } = req.body;

  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        displayName,
        bio,
      },
    });

    res.json({ message: 'Profile updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

export const updateUserRole = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  const adminId = req.user!.id;
  const { id: targetUserId } = req.params;
  const { role: newRole } = req.body;

  try {
    const [adminUser, targetUser] = await Promise.all([
      prisma.user.findUnique({ where: { id: adminId } }),
      prisma.user.findUnique({ where: { id: targetUserId } }),
    ]);

    if (!targetUser) {
      res.status(404).json({ error: 'Target user not found' });
      return;
    }

    // Rule: Admins cannot demote other admins.
    if (targetUser.role === 'admin' && adminId !== targetUserId) {
      res.status(403).json({ error: 'Admins cannot change the role of other admins.' });
      return;
    }

    // Rule: Moderators cannot be promoted to admin by another moderator (this is covered by requireAdmin middleware, but good to double check).
    if (newRole === 'admin' && adminUser?.role !== 'admin') {
        res.status(403).json({ error: 'Only admins can promote other users to admin.' });
        return;
    }

    const updatedUser = await prisma.user.update({
      where: { id: targetUserId },
      data: { role: newRole },
    });

    res.json({ message: 'User role updated successfully', user: updatedUser });
  } catch (error) {
    console.error('Update user role error:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
};
