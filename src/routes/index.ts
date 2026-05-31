import { Router } from 'express';
import type { RouteDoc } from '../docs/registry.js';
import { z } from '../docs/zod.js';
import { APP_API_NAME, APP_VERSION } from '../config/constants.js';

const router = Router();

const apiMetadataResponseSchema = z
  .object({
    name: z.string().openapi({ example: APP_API_NAME }),
    version: z.string().openapi({ example: APP_VERSION }),
    docs: z.string().openapi({ example: '/docs' }),
  })
  .openapi('ApiMetadataResponse');

router.get('/', (_req, res) => {
  res.json({
    name: APP_API_NAME,
    version: APP_VERSION,
    docs: '/docs',
  });
});

export const routeDocs = [
  {
    method: 'get',
    path: '/',
    summary: 'API metadata',
    tags: ['System'],
    responses: {
      200: {
        description: 'API is running',
        content: {
          'application/json': {
            schema: apiMetadataResponseSchema,
          },
        },
      },
    },
  },
] satisfies RouteDoc[];

export default router;
