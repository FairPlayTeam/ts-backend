import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { APP_API_NAME, APP_PRODUCT_NAME, APP_VERSION } from '../config/constants.js';
import { registry } from './registry.js';

type GenerateOpenApiOptions = {
  serverUrl?: string;
};

export function generateOpenApi(options: GenerateOpenApiOptions = {}) {
  const generator = new OpenApiGeneratorV3(registry.definitions, {
    sortComponents: 'alphabetically',
  });

  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: APP_API_NAME,
      version: APP_VERSION,
      description: `${APP_PRODUCT_NAME} REST API documentation`,
    },
    ...(options.serverUrl && { servers: [{ url: options.serverUrl }] }),
    tags: [
      { name: 'System', description: 'API metadata and operational endpoints' },
      { name: 'Auth', description: 'Authentication and account lifecycle' },
    ],
  });
}
