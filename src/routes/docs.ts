import { Router } from 'express';
import { getDocs, registerRoute } from '../lib/docs.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    name: 'fpbackend API',
    version: '1.0.0',
    routes: getDocs(),
  });
});

registerRoute({
  method: 'GET',
  path: '/docs',
  summary: 'List API documentation',
  responses: { '200': '{ "name": "fpbackend API", "version": "1.0.0", "routes": [ ... ] }' }
});

export default router;
