import type { TestProject } from 'vitest/node';

import { startIntegrationInfrastructure } from './support/infrastructure.js';

export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  const infrastructure = await startIntegrationInfrastructure();
  project.provide('integrationInfrastructure', infrastructure.context);

  return infrastructure.stop;
}
