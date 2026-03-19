import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma.js';
import { createSession } from './sessionController.js';
import { SessionAuthRequest } from '../lib/sessionAuth.js';
import { getProxiedAssetUrl } from '../lib/utils.js';

export const register = async (req: Request, res: Response): Promise<void> => {
	try {
		const { email, username, password } = req.body;

		if (!email || !username || !password) {
			res
				.status(400)
				.json({ error: 'Email, username, and password are required' });
			return;
		}

		if (String(username).trim().length < 3) {
			res.status(400).json({ error: 'Username must be at least 3 characters' });
			return;
		}

		const passwordErrors: string[] = [];

		if (password.length < 6) {
			passwordErrors.push('at least 6 characters');
		}
		if (!/[A-Z]/.test(password)) {
			passwordErrors.push('at least one uppercase letter');
		}
		if (!/[0-9]/.test(password)) {
			passwordErrors.push('at least one number');
		}
		if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
			passwordErrors.push('at least one special character (!@#$...)');
		}

		if (passwordErrors.length > 0) {
			res.status(400).json({
				error: `Password must contain ${passwordErrors.join(', ')}.`,
			});
			return;
		}

		const usernameNorm = String(username).trim().toLowerCase();
		const emailNorm = String(email).trim().toLowerCase();
		const saltRounds = Number(process.env.BCRYPT_ROUNDS ?? 12);
		const hashedPassword = await bcrypt.hash(password, saltRounds);

		try {
			const user = await prisma.user.create({
				data: {
					email: emailNorm,
					username: usernameNorm,
					passwordHash: hashedPassword,
				},
				select: { id: true, email: true, username: true, role: true },
			});

			const { sessionKey, session } = await createSession(user.id, req);

			res.status(201).json({
				message: 'User registered successfully',
				user,
				sessionKey,
				session: {
					id: session.id,
					expiresAt: session.expiresAt,
					deviceInfo: session.deviceInfo,
					ipAddress: session.ipAddress,
				},
			});
		} catch (err: any) {
			if (err?.code === 'P2002') {
				const target = err?.meta?.target as string[] | undefined;

				if (Array.isArray(target) && target.includes('email')) {
					res
						.status(409)
						.json({ error: 'User with this email already exists' });
					return;
				}
				if (Array.isArray(target) && target.includes('username')) {
					res.status(409).json({ error: 'Username already taken' });
					return;
				}
				res.status(409).json({ error: 'Email or username already exists' });
				return;
			}
			throw err;
		}
	} catch (error) {
		console.error('Registration error:', error);
		res
			.status(500)
			.json({ error: 'Internal server error during registration' });
	}
};

export const login = async (req: Request, res: Response): Promise<void> => {
	try {
		const { emailOrUsername, password } = req.body;

		if (!emailOrUsername || !password) {
			res
				.status(400)
				.json({ error: 'Email/username and password are required' });
			return;
		}

		const lookup = String(emailOrUsername).trim();
		const lookupEmail = lookup.toLowerCase();
		const user = await prisma.user.findFirst({
			where: {
				OR: [{ email: lookupEmail }, { username: lookup }],
			},
			select: {
				id: true,
				email: true,
				username: true,
				role: true,
				passwordHash: true,
				isActive: true,
				isBanned: true,
			},
		});

		if (!user) {
			res.status(401).json({ error: 'Invalid credentials' });
			return;
		}

		const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

		if (!isPasswordValid) {
			res.status(401).json({ error: 'Invalid credentials' });
			return;
		}

		if (!user.isActive) {
			res.status(401).json({ error: 'Account is deactivated' });
			return;
		}

		if (user.isBanned) {
			res.status(403).json({ error: 'This account has been banned' });
			return;
		}

		void prisma.user
			.update({ where: { id: user.id }, data: { lastLogin: new Date() } })
			.catch(() => {});

		const { sessionKey, session } = await createSession(user.id, req);

		res.json({
			message: 'Login successful',
			user: {
				id: user.id,
				email: user.email,
				username: user.username,
				role: user.role,
			},
			sessionKey,
			session: {
				id: session.id,
				expiresAt: session.expiresAt,
				deviceInfo: session.deviceInfo,
				ipAddress: session.ipAddress,
			},
		});
	} catch (error) {
		console.error('Login error:', error);
		res.status(500).json({ error: 'Internal server error during login' });
	}
};

export const getProfile = async (
	req: SessionAuthRequest,
	res: Response,
): Promise<void> => {
	try {
		const user = await prisma.user.findUnique({
			where: { id: req.user!.id },
			select: {
				id: true,
				email: true,
				username: true,
				displayName: true,
				avatarUrl: true,
				bannerUrl: true,
				bio: true,
				role: true,
				isVerified: true,
				followerCount: true,
				followingCount: true,
				totalViews: true,
				createdAt: true,
			},
		});

		if (!user) {
			res.status(404).json({ error: 'User not found' });
			return;
		}

		res.json({
			id: user.id,
			email: user.email,
			username: user.username,
			displayName: user.displayName,
			avatarUrl: getProxiedAssetUrl(user.id, user.avatarUrl),
			bannerUrl: getProxiedAssetUrl(user.id, user.bannerUrl),
			bio: user.bio,
			role: user.role,
			isVerified: user.isVerified,
			followerCount: user.followerCount,
			followingCount: user.followingCount,
			totalViews: user.totalViews.toString(),
			createdAt: user.createdAt,
		});
	} catch (error) {
		console.error('Get profile error:', error);
		res.status(500).json({ error: 'Failed to get user profile' });
	}
};
