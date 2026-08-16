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

// S1-CODEGEN: each operations output owns a DISJOINT document set. graphql-codegen
// loads `documents` once per output and `typescript-operations` requires globally
// unique operation names WITHIN that set. AquaMobil and the shell/modules
// legitimately reuse operation names (ClockIn, CreateLeaveRequest, …) because they
// are independently-deployed clients of the same supergraph; partitioning the
// documents per output keeps each client's contract isolated instead of forcing an
// artificial cross-client rename. The aquamobil glob is the manifest entry that
// matches `web/apps/aquamobil`.
//
// SCOPE NOTE (S1): a `web/shared-ui/src/generated/graphql-operations.ts` output
// was previously declared here for the shell + module documents, but it has NEVER
// produced a committed file — the shell/module document set contains pre-existing
// hr-module schema drift (fragments referencing fields that no longer exist on
// `Payroll`/`PerformanceGoal`, e.g. `earnings`, `deductions`, `keyResults` without
// subfields). Those documents fail GraphQL validation, and graphql-codegen aborts
// the WHOLE run on any output error, which would block this gate on drift entirely
// unrelated to the AquaMobil client contract. The dead, never-emitted block is
// removed so the codegen SSoT actually runs; the hr-module drift is tracked
// separately (orphan finding S1-ORPHAN — fix the module fragments to the live
// schema) rather than silently swallowed. The shared-ui SCHEMA-type block below
// (no documents) is unaffected and keeps generating.
const aquamobilDocuments = ['web/apps/aquamobil/src/graphql/**/*.ts'];
const adminPanelDocuments = [
  'web/modules/admin-panel/src/graphql/platform-configuration-operations.ts',
  'web/modules/admin-panel/src/graphql/tenant-configuration-operations.ts',
];

const config: CodegenConfig = {
  overwrite: true,
  schema,
  // NOTE: no top-level `documents` — graphql-codegen MERGES a top-level document
  // set into every per-output `documents`, which would re-introduce the
  // cross-client operation-name collision the per-output partitioning prevents.
  // Each operations output below declares its own disjoint document set instead.
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
          // AquaMobil client-contract SSoT (S1-CODEGEN). Emits the schema types,
          // operation result/variable types, AND a TypedDocumentNode constant per
          // operation from the gql-tagged documents in
          // web/apps/aquamobil/src/graphql/*. The schema is the composed
          // supergraph (federation @join__ directives are stripped by the
          // typescript plugin, exactly as the shared-ui types block proves), so the
          // generated MessageContentType/ReceiptStatus enums are the UPPERCASE
          // GraphQL enum NAMES — the casing-drift class becomes a compile error.
          'web/apps/aquamobil/src/generated/graphql.ts': {
            documents: aquamobilDocuments,
            // S1-CODEGEN: `typescript` is intentionally OMITTED here.
            // `typescript-operations` already emits every base schema type its
            // operations reference (enums, input objects, the UPPERCASE
            // MessageContentType/ReceiptStatus enum unions) AND the operation
            // result/variable types — so the trio `typescript` + `typescript-
            // operations` in ONE file emits enums + inputs TWICE (a TS2300
            // duplicate-identifier error). Dropping the standalone `typescript`
            // plugin yields a single self-contained module with each type defined
            // exactly once, plus the TypedDocumentNode constants.
            plugins: ['typescript-operations', 'typed-document-node'],
            config: {
              skipTypename: true,
              enumsAsTypes: true,
              scalars: {
                DateTime: 'string',
                JSON: 'Record<string, unknown>',
              },
            },
          },
          'web/modules/admin-panel/src/generated/graphql.ts': {
            documents: adminPanelDocuments,
            plugins: ['typescript-operations', 'typed-document-node'],
            config: {
              skipTypename: true,
              enumsAsTypes: true,
              scalars: {
                DateTime: 'string',
                JSON: 'unknown',
              },
            },
          },
        }
      : {}),
  },
};

export default config;
