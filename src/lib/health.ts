export type ServiceStatus = 'ok' | 'degraded' | 'down';

export interface ServiceCheck {
  status: ServiceStatus;
  latencyMs: number;
  error?: string;
}

const publicServiceErrorMessages = {
  database: 'Database unavailable',
  storage: 'Storage unavailable',
} as const;

export type ServiceName = keyof typeof publicServiceErrorMessages;

export const createHealthyServiceCheck = (latencyMs: number): ServiceCheck => ({
  status: 'ok',
  latencyMs,
});

export const createUnavailableServiceCheck = (
  serviceName: ServiceName,
  startedAtMs: number,
  error: unknown,
): ServiceCheck => {
  console.error(`${serviceName} health check failed:`, error);

  return {
    status: 'down',
    latencyMs: Date.now() - startedAtMs,
    error: publicServiceErrorMessages[serviceName],
  };
};

export const aggregateStatus = (checks: ServiceCheck[]): ServiceStatus => {
  if (checks.every((c) => c.status === 'ok')) return 'ok';
  if (checks.some((c) => c.status === 'down')) return 'down';
  return 'degraded';
};
