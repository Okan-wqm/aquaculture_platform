/**
 * Runner for the admin OpenAPI artifact (CONTRACT-CRITICAL-003, ADR-0015).
 *
 * WHY a runner and not `ts-node generate-openapi.ts`: a Nest DTO class carries
 * its shape in TypeScript types and class-validator decorators, not in
 * `@ApiProperty` calls. `@nestjs/swagger/plugin` is the TypeScript transformer
 * that turns the former into schema metadata; without it every schema in the
 * document is `{}` — the same vacuous contract an interface DTO produced. The
 * transformer has to be registered BEFORE the application module is loaded, so
 * registration and generation cannot live in the same file.
 *
 * Full type-check mode is deliberate: ts-node only hands a transformer the
 * TypeScript `Program` outside `--transpile-only`, and the plugin reads the
 * checker to resolve a property's declared type into a schema.
 */
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '../../apps/admin-api-service/tsconfig.app.json');

const swaggerPlugin = require('@nestjs/swagger/plugin');

require('ts-node').register({
  project: PROJECT,
  transformers: (program) => ({
    before: [
      swaggerPlugin.before(
        {
          // DTO classes live in `*.dto.ts` and, historically, inside the
          // controller that declares them; both are visited.
          dtoFileNameSuffix: ['.dto.ts', '.controller.ts'],
          controllerFileNameSuffix: ['.controller.ts'],
          // Types and class-validator decorators are the source of truth;
          // JSDoc is not scanned so a comment edit cannot move the contract.
          introspectComments: false,
          classValidatorShim: true,
          dtoKeyOfComment: 'description',
        },
        program,
      ),
    ],
  }),
});

require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../..'),
  paths: require(path.resolve(__dirname, '../../tsconfig.base.json')).compilerOptions.paths,
});

const { writeAdminOpenApiArtifact } = require(
  path.resolve(__dirname, '../../apps/admin-api-service/src/openapi/generate-openapi.ts'),
);

writeAdminOpenApiArtifact().catch((error) => {
  process.stderr.write(
    `openapi: generation failed: ${error && error.stack ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
