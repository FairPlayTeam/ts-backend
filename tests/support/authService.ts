export type { AuthDeps } from './authService/context.js';
export { avatarObjectKeyPattern, bannerObjectKeyPattern, fixedNow } from './authService/context.js';
export { createDefaultAuthPrisma, createTestDeps } from './authService/deps.js';
export {
  createPasswordResetConfirmationTestDeps,
  createPasswordResetTestDeps,
} from './authService/passwordReset.js';
export type { PasswordResetTestUser } from './authService/passwordReset.js';
export { createUserMediaAssetDeletionTransaction } from './authService/userMedia.js';
