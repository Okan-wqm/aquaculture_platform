import { existsSync, readFileSync } from 'fs';

import type { CodegenConfig } from '@graphql-codegen/cli';

type CodegenSchemaManifest = {
  supergraphPath: string;
  documents: string[];
};

const manifest = JSON.parse(
  readFileSync('infrastructure/apollo-router/codegen-schema.generated.json', 'utf8'),
) as CodegenSchemaManifest;

const composedSupergraph = manifest.supergraphPath;
const allowLocalFallback = process.env.GRAPHQL_CODEGEN_ALLOW_SCHEMA_FALLBACK === 'true';
const legacyFallback = 'apps/farm-service/schema.graphql';

if (!existsSync(composedSupergraph) && !allowLocalFallback) {
  throw new Error(
    `${composedSupergraph} is required for GraphQL codegen. Run schema:emit + apollo-router:compose first.`,
  );
}

const schema = existsSync(composedSupergraph) ? [composedSupergraph] : [legacyFallback];
const documents = existsSync(composedSupergraph) ? manifest.documents : [];

const config: CodegenConfig = {
  overwrite: true,
  schema,
  documents,
  generates: {
    'web/shared-ui/src/generated/graphql-types.ts': {
      plugins: ['typescript'],
      config: {
        skipTypename: true,
        enumsAsTypes: true,
        scalars: {
          DateTime: 'string',
          JSON: 'Record<string, unknown>',
        },
      },
    },
    ...(existsSync(composedSupergraph)
      ? {
          'web/shared-ui/src/generated/graphql-operations.ts': {
            plugins: ['typescript', 'typescript-operations', 'typed-document-node'],
            config: {
              skipTypename: true,
              enumsAsTypes: true,
              scalars: {
                DateTime: 'string',
                JSON: 'Record<string, unknown>',
              },
            },
          },
        }
      : {}),
  },
};

export default config;
