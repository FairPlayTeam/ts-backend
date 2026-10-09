import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { generateOpenApi } from '../src/docs/openapi.js';
import { httpRouteDocs } from '../src/routes/registry.js';

const outputFile = new URL('../openapi.json', import.meta.url);

const document = generateOpenApi({ routeDocs: httpRouteDocs });
const formattedDocument = await format(JSON.stringify(document), {
  parser: 'json',
  printWidth: 100,
});

await writeFile(outputFile, formattedDocument, 'utf8');

console.log(`OpenAPI snapshot written to ${fileURLToPath(outputFile)}`);
