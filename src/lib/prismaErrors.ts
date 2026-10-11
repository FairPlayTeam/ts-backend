import { Prisma } from '@prisma/client';

export const isPrismaUniqueError = (err: unknown): err is Prisma.PrismaClientKnownRequestError =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export const constraintContains = (
  value: unknown,
  matches: (candidate: string) => boolean,
  depth = 3,
): boolean => {
  if (typeof value === 'string') {
    return matches(value);
  }

  if (depth === 0 || typeof value !== 'object' || value === null) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => constraintContains(item, matches, depth - 1));
  }

  return Object.entries(value).some(
    ([key, nested]) =>
      constraintContains(key, matches, depth - 1) || constraintContains(nested, matches, depth - 1),
  );
};
