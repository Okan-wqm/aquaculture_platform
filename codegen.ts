import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  overwrite: true,
  schema: [
    'apps/farm-service/schema.graphql',
    'apps/sensor-service/schema.graphql',
    'apps/hr-service/schema.graphql',
    'apps/auth-service/schema.graphql',
    'apps/billing-service/schema.graphql',
    'apps/config-service/schema.graphql',
    'apps/hydroponics-service/schema.graphql',
    'apps/alert-engine/schema.graphql',
  ],
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
  },
};

export default config;
