import type { OperationLogger } from '../../src/lib/operationMetrics.js';

export type OperationLogEntry = {
  level: 'info' | 'warn';
  data: Record<string, unknown>;
  message: string;
};

export const createOperationLogCollector = (): {
  logs: OperationLogEntry[];
  logger: OperationLogger;
} => {
  const logs: OperationLogEntry[] = [];

  return {
    logs,
    logger: {
      info: (data: object, message: string) => {
        logs.push({ level: 'info', data: data as Record<string, unknown>, message });
      },
      warn: (data: object, message: string) => {
        logs.push({ level: 'warn', data: data as Record<string, unknown>, message });
      },
    },
  };
};
