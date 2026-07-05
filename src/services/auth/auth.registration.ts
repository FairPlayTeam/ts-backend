import { UserAlreadyExistsError } from '../auth.errors.js';
import type { AuthDependencies } from './auth.dependencies.js';
import {
  getEmailVerificationExpiresAt,
  getUserScopedAuthCodeSecret,
  normalizeEmail,
} from './auth.helpers.js';
import { REGISTER_SUCCESS_MESSAGE } from './auth.messages.js';
import { handleExpectedMailerError } from '../mailer/mailer.helpers.js';
import type { AuthCredentialsPort, RegisterInput } from './types/credentials.types.js';

type RegistrationService = Pick<AuthCredentialsPort, 'register'>;

export const createRegistrationService = (deps: AuthDependencies): RegistrationService => ({
  async register({ email, username, password }: RegisterInput) {
    const usernameNorm = username.trim().toLowerCase();
    const emailNorm = normalizeEmail(email);

    const hashedPassword = await deps.hasher.hash(password, deps.config.bcryptRounds);

    const code = deps.token.generateSixDigitCode();
    const expiresAt = getEmailVerificationExpiresAt(
      deps.clock.now(),
      deps.config.emailVerificationTokenTtlMs,
    );

    const user = await deps.prisma
      .$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            email: emailNorm,
            username: usernameNorm,
            displayName: usernameNorm,
            passwordHash: hashedPassword,
          },
          select: { id: true, email: true, username: true, role: true },
        });

        await tx.emailVerificationToken.create({
          data: {
            userId: createdUser.id,
            token: deps.token.hashAuthCode(getUserScopedAuthCodeSecret(createdUser.id, code)),
            expiresAt,
          },
        });

        return createdUser;
      })
      .catch((err) => {
        if (deps.isUniqueError(err)) {
          throw new UserAlreadyExistsError(err);
        }

        throw err;
      });

    try {
      await deps.mailer.sendVerificationEmail(user.email, code);
    } catch (err) {
      await handleExpectedMailerError({
        err,
        logger: deps.logger,
        warningMessage: 'Verification email could not be sent after registration',
      });
    }

    return {
      message: REGISTER_SUCCESS_MESSAGE,
    };
  },
});
