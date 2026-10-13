import type { Prisma, PrismaClient } from '@prisma/client';

// Gate actual service transactions, without replacing their SQL or their row locks.
export const holdAuthTransaction = (
  prisma: PrismaClient,
  checkpoint: 'before-insert' | 'before-commit' | 'before-user-read',
  { skipTransactions = 0 }: { skipTransactions?: number } = {},
) => {
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let transactionCount = 0;
  const pause = async () => {
    if (transactionCount <= skipTransactions) return;
    paused.resolve();
    await release.promise;
  };
  const heldPrisma = new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: {
            isolationLevel?: Prisma.TransactionIsolationLevel;
            maxWait?: number;
            timeout?: number;
          },
        ) =>
          target.$transaction(
            async (tx) => {
              transactionCount++;
              const heldTx = new Proxy(tx, {
                get(transaction, key) {
                  if (key === 'user' && checkpoint === 'before-user-read') {
                    return new Proxy(transaction.user, {
                      get(user, method) {
                        if (method === 'findUnique') {
                          return async (args: Prisma.UserFindUniqueArgs) => {
                            await pause();
                            return user.findUnique(args);
                          };
                        }
                        const value: unknown = Reflect.get(user, method, user);
                        return typeof value === 'function' ? value.bind(user) : value;
                      },
                    });
                  }
                  if (key === 'session' && checkpoint === 'before-insert') {
                    return new Proxy(transaction.session, {
                      get(session, method) {
                        if (method === 'create') {
                          return async (args: Prisma.SessionCreateArgs) => {
                            // Login has checked its locked reread, but has not inserted yet.
                            await pause();
                            return session.create(args);
                          };
                        }
                        const value: unknown = Reflect.get(session, method, session);
                        return typeof value === 'function' ? value.bind(session) : value;
                      },
                    });
                  }
                  const value: unknown = Reflect.get(transaction, key, transaction);
                  return typeof value === 'function' ? value.bind(transaction) : value;
                },
              });
              const result = await run(heldTx);
              if (checkpoint === 'before-commit') {
                // All service SQL effects have run; the transaction has not committed yet.
                await pause();
              }
              return result;
            },
            { ...options, timeout: 15_000 },
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    prisma: heldPrisma,
    paused: paused.promise,
    release: release.resolve,
    transactionCount: () => transactionCount,
  };
};
