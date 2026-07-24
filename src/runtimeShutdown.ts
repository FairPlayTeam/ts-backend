type RuntimeShutdownStep = {
  name: 'maintenance' | 'transcodes' | 'httpServer' | 'prisma' | 'redis';
  run(): Promise<void>;
};

export const runRuntimeShutdownSteps = async (
  steps: readonly RuntimeShutdownStep[],
  logger: {
    error(data: object, message: string): void;
  },
): Promise<RuntimeShutdownStep['name'][]> => {
  const failedSteps: RuntimeShutdownStep['name'][] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failedSteps.push(step.name);
      logger.error({ err: error, shutdownStep: step.name }, 'Graceful shutdown step failed');
    }
  }

  return failedSteps;
};
