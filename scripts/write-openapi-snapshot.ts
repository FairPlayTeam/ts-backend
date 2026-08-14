import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { routeDocs as adminRouteDocs } from '../src/docs/admin.routes.js';
import { routeDocs as authRouteDocs } from '../src/docs/auth.routes.js';
import { routeDocs as moderationRouteDocs } from '../src/docs/moderation.routes.js';
import { generateOpenApi } from '../src/docs/openapi.js';
import { routeDocs as profileRouteDocs } from '../src/docs/profiles.routes.js';
import type { RouteDoc } from '../src/docs/registry.js';
import { routeDocs as videoRouteDocs } from '../src/docs/videos.routes.js';
import { routeDocs as healthRouteDocs } from '../src/routes/health.js';
import { routeDocs as systemRouteDocs } from '../src/routes/index.js';

const outputFile = new URL('../openapi.json', import.meta.url);

const routeDocs = [
  ...systemRouteDocs,
  ...healthRouteDocs,
  ...authRouteDocs,
  ...profileRouteDocs,
  ...videoRouteDocs,
  ...moderationRouteDocs,
  ...adminRouteDocs,
] satisfies RouteDoc[];

const document = generateOpenApi({ routeDocs });
const formattedDocument = await format(JSON.stringify(document), {
  parser: 'json',
  printWidth: 100,
});

await writeFile(outputFile, formattedDocument, 'utf8');

console.log(`OpenAPI snapshot written to ${fileURLToPath(outputFile)}`);
