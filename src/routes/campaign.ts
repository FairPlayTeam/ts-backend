import { Router } from 'express';
import { getCampaign } from '../controllers/campaignController.js';
import { registerRoute } from '../lib/docs.js';

const router = Router();

router.get('/', getCampaign);

registerRoute({
  method: 'GET',
  path: '/campaign',
  summary: 'Get the active advertising campaign',
  description:
    'Returns the currently configured campaign. When no campaign is configured yet, the value is null.',
  responses: {
    '200': `{
  "campaign": {
    "id": "active",
    "title": "string (max 50)",
    "description": "string (max 200)",
    "link": "https://example.com",
    "thumbnailUrl": "https://example.com/banner.jpg",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601"
  }
}`,
  },
});

export default router;
