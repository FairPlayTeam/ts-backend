import { PASSWORD_MAX_BYTES } from '../../../config/constants.js';
import { PasswordContainsNulError, PasswordTooLongError } from '../errors.js';

export const isPasswordWithinByteLimit = (password: string): boolean =>
  Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES;

export const isPasswordNulFree = (password: string): boolean => !password.includes('\u0000');

export const assertPasswordInputAllowed = (password: string): void => {
  if (!isPasswordWithinByteLimit(password)) {
    throw new PasswordTooLongError();
  }
  if (!isPasswordNulFree(password)) {
    throw new PasswordContainsNulError();
  }
};
