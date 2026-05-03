import { prisma } from '../lib/prisma.js';
import bcrypt from 'bcryptjs';
import config from '../config/env.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { getExpiryDate } from '../lib/time.js';
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from '../config/constants.js';
import { sendVerificationEmail } from './mailer/mailer.service.js';

type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

export const authService = {
  async register({ email, username, password }: RegisterInput) {
    const usernameNorm = username.trim().toLowerCase();
    const emailNorm = email.trim().toLowerCase();

    const hashedPassword = await bcrypt.hash(password, config.bcryptRounds);
    const token = generateToken();
    const tokenHash = hashToken(token);

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: emailNorm,
          username: usernameNorm,
          passwordHash: hashedPassword,
        },
        select: { id: true, email: true, username: true, role: true },
      });

      await tx.emailVerificationToken.create({
        data: {
          userId: createdUser.id,
          token: tokenHash,
          expiresAt: getExpiryDate(EMAIL_VERIFICATION_TOKEN_TTL_MS),
        },
      });

      return createdUser;
    });

    try {
      await sendVerificationEmail(user.email, token);
    } catch (err) {
      await prisma.user.delete({ where: { id: user.id } }).catch((cleanupError) => {
        console.error('Failed to roll back user after verification email failure:', cleanupError);
      });
      throw err;
    }

    return {
      message: 'Account created. Please verify your email.',
    };
  },
};
