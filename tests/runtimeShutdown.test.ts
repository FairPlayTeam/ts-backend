import { describe, expect, test } from 'bun:test';
import { runRuntimeShutdownSteps } from '../src/runtimeShutdown.js';

describe('runtime shutdown', () => {
  test('keeps the required order and continues after individual step failures', async () => {
    const calls: string[] = [];
    const logs: unknown[] = [];
    const maintenanceError = new Error('maintenance stop failed');
    const serverError = new Error('server close failed');
    const failedSteps = await runRuntimeShutdownSteps(
      [
        {
          name: 'maintenance',
          run: async () => {
            calls.push('maintenance');
            throw maintenanceError;
          },
        },
        {
          name: 'transcodes',
          run: async () => {
            calls.push('transcodes');
          },
        },
        {
          name: 'httpServer',
          run: async () => {
            calls.push('httpServer');
            throw serverError;
          },
        },
        {
          name: 'prisma',
          run: async () => {
            calls.push('prisma');
          },
        },
        {
          name: 'redis',
          run: async () => {
            calls.push('redis');
          },
        },
      ],
      {
        error: (data, message) => {
          logs.push({ data, message });
        },
      },
    );

    expect(calls).toEqual(['maintenance', 'transcodes', 'httpServer', 'prisma', 'redis']);
    expect(failedSteps).toEqual(['maintenance', 'httpServer']);
    expect(logs).toEqual([
      {
        data: {
          err: maintenanceError,
          shutdownStep: 'maintenance',
        },
        message: 'Graceful shutdown step failed',
      },
      {
        data: {
          err: serverError,
          shutdownStep: 'httpServer',
        },
        message: 'Graceful shutdown step failed',
      },
    ]);
  });
});
