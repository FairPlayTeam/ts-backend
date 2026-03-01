import { Request, Response } from 'express';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { prisma } from '../lib/prisma.js';
import { createUserSearchWhere, getProxiedAssetUrl } from '../lib/utils.js';

const MAX_PAGE_LIMIT = 50;
const DEFAULT_PAGE_LIMIT = 20;

const parsePagination = (query: Record<string, string>) => {
    const page = Math.max(1, parseInt(query.page ?? '1') || 1);
    const limit = Math.min(
        MAX_PAGE_LIMIT,
        Math.max(1, parseInt(query.limit ?? String(DEFAULT_PAGE_LIMIT)) || DEFAULT_PAGE_LIMIT)
    );
    return { page, limit, skip: (page - 1) * limit };
};

const publicUserSelect = {
    id: true,
    username: true,
    displayName: true,
    avatarUrl: true,
    bannerUrl: true,
    followerCount: true,
    followingCount: true,
    videoCount: true,
    createdAt: true,
};

export const getUsers = async (req: Request, res: Response): Promise<void> => {
    try {
        const { page, limit, skip } = parsePagination(req.query as Record<string, string>);

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                select: publicUserSelect,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.user.count(),
        ]);

        res.json({
            users: users.map((user) => ({
                ...user,
                avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl),
            })),
            pagination: {
                page,
                limit,
                totalItems: total,
                totalPages: Math.ceil(total / limit),
                itemsReturned: users.length,
            },
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
}

export const getUserById = async (req: Request, res: Response): Promise<void> => {
    try {
        const { id } = req.params;

        if (!id || id.length > 100) {
            res.status(400).json({ error: 'Invalid user identifier' });
            return;
        }

        const user = await prisma.user.findFirst({
            where: createUserSearchWhere(id),
            select: {
                ...publicUserSelect,
                bannerUrl: true,
                bio: true,
                isVerified: true,
            },
        });

        if (!user) {
            res.status(404).json({ error: 'User not found' });
            return;
        }

        res.json({
            ...user,
            avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl),
            bannerUrl: getProxiedAssetUrl(user.id, user.bannerUrl),
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
}

export const updateProfile = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const userId = req.user!.id;
        const { displayName, bio } = req.body;

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { displayName, bio },
            select: {
                id: true,
                username: true,
                displayName: true,
                bio: true,
                avatarUrl: true,
                bannerUrl: true,
            },
        });

        res.json({
            message: 'Profile updated successfully',
            user: {
                ...updatedUser,
                avatarUrl: getProxiedAssetUrl(updatedUser.id, updatedUser.avatarUrl),
                bannerUrl: getProxiedAssetUrl(updatedUser.id, updatedUser.bannerUrl),
            },
        });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
}

export const updateUserRole = async (
    req: SessionAuthRequest,
    res: Response,
): Promise<void> => {
    try {
        const adminId = req.user!.id;
        const adminRole = req.user!.role;
        const { id } = req.params;
        const { role: newRole } = req.body;

        if (!id || id.length > 100) {
            res.status(400).json({ error: 'Invalid user identifier' });
            return;
        }

        const targetUser = await prisma.user.findFirst({
            where: createUserSearchWhere(id),
            select: { id: true, role: true },
        });

        if (!targetUser) {
            res.status(404).json({ error: 'Target user not found' });
            return;
        }

        if (targetUser.role === 'admin' && adminId !== targetUser.id) {
            res.status(403).json({ error: 'Admins cannot change the role of other admins' });
            return;
        }

        if (newRole === 'admin' && adminRole !== 'admin') {
            res.status(403).json({ error: 'Only admins can promote users to admin' });
            return;
        }

        const updatedUser = await prisma.user.update({
            where: { id: targetUser.id },
            data: { role: newRole },
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
            },
        });

        res.json({ message: 'User role updated successfully', user: updatedUser });
    } catch (error) {
        console.error('Update user role error:', error);
        res.status(500).json({ error: 'Failed to update user role' });
    }
}

export const getTopCreators = async (_req: Request, res: Response): Promise<void> => {
    try {
        const users = await prisma.user.findMany({
            where: {
                isBanned: false,
                videos: {
                    some: {
                        processingStatus: 'done',
                        moderationStatus: 'approved',
                        visibility: 'public',
                    },
                },
            },
            select: publicUserSelect,
            orderBy: { followerCount: 'desc' },
            take: 3,
        });

        res.json({
            users: users.map((user) => ({
                ...user,
                avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl),
            })),
        });
    } catch (error) {
        console.error('Error fetching top creators:', error);
        res.status(500).json({ error: 'Failed to fetch top creators' });
    }
}