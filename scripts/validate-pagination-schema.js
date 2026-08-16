#!/usr/bin/env node
/**
 * Validates that all paginated GraphQL types follow the standard pagination shape.
 *
 * Offset shape: { items, total, page, limit, totalPages, hasNextPage, hasPreviousPage }
 * Cursor shape: { edges, pageInfo }
 *
 * Scans the generated service-catalog subgraph artifacts and validates types matching:
 * - *Connection
 * - *ListResponse
 * - *PaginatedResponse
 * - Paginated*
 */

import fs from 'node:fs';
import path from 'node:path';

const OFFSET_REQUIRED_FIELDS = [
  'items',
  'total',
  'page',
  'limit',
  'totalPages',
  'hasNextPage',
  'hasPreviousPage',
];
const CURSOR_CONNECTION_REQUIRED_FIELDS = ['edges', 'pageInfo'];
const PAGINATED_TYPE_PATTERNS = [
  /Connection$/,
  /ListResponse$/,
  /PaginatedResponse$/,
  /^Paginated/,
];

const MANIFEST_PATH = 'infrastructure/apollo-router/codegen-schema.generated.json';
if (!fs.existsSync(MANIFEST_PATH)) {
  throw new Error(`Generated GraphQL registry manifest is missing: ${MANIFEST_PATH}`);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
if (!Array.isArray(manifest.schemaArtifactPaths) || manifest.schemaArtifactPaths.length === 0) {
  throw new Error(`Generated GraphQL registry has no schemaArtifactPaths: ${MANIFEST_PATH}`);
}

let errors = 0;
let checked = 0;

for (const artifactPath of manifest.schemaArtifactPaths) {
  const schemaPath = path.normalize(artifactPath);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `Generated subgraph artifact is missing: ${schemaPath}. Run the catalog-owned supergraph build first.`,
    );
  }

  const schema = fs.readFileSync(schemaPath, 'utf8');

  // Simple regex parser for GraphQL type definitions
  const typeRegex = /type\s+(\w+)\s*(?:implements\s+[^{]*)?\{([^}]+)\}/g;
  let match;

  while ((match = typeRegex.exec(schema)) !== null) {
    const typeName = match[1];
    const typeBody = match[2];

    const isPaginated = PAGINATED_TYPE_PATTERNS.some((p) => p.test(typeName));
    if (!isPaginated) continue;

    checked++;
    const fields = typeBody.match(/\w+(?=\s*[:(])/g) || [];

    const requiredFields = /CursorConnection$/.test(typeName)
      ? CURSOR_CONNECTION_REQUIRED_FIELDS
      : OFFSET_REQUIRED_FIELDS;
    const missing = requiredFields.filter((f) => !fields.includes(f));
    if (missing.length > 0) {
      console.error(`✗ ${schemaPath}: ${typeName} missing fields: ${missing.join(', ')}`);
      errors++;
    } else {
      console.log(`✓ ${schemaPath}: ${typeName}`);
    }
  }
}

console.log(`\nChecked ${checked} paginated types, ${errors} error(s)`);
process.exit(errors > 0 ? 1 : 0);
