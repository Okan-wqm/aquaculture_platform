/**
 * Platform-wide invariant — INFRA-CRITICAL-020 propagation:
 *
 * Every service that runs `MigrationRunnerService` AND owns a source
 * schema MUST also pass `migrationsRunFromEnv: cs => DATABASE_MIGRATIONS_RUN==='true'`
 * to its `createServiceTypeOrmConfig` call so that E2E test harnesses
 * (which set DATABASE_MIGRATIONS_RUN=true) get TypeORM's built-in
 * runner to apply migrations at DataSource init — BEFORE the
 * `SourceSchemaBootstrapService` onApplicationBootstrap hook fires.
 *
 * # Why
 *
 * `SourceSchemaBootstrapService` (libs/backend-common) hard-fails (per
 * INFRA-CRITICAL-009) when the source schema is empty after bootstrap.
 * In production, `aqua-db-migrate` runs migrations BEFORE service
 * containers start, so the schema is populated by the time the service
 * boots. In E2E tests there is no such pre-stage — TypeORM must apply
 * migrations at DataSource init or the bootstrap hook crashes.
 *
 * The pattern landed in messaging-service first (commit 074c7807,
 * INFRA-CRITICAL-020) and was propagated to every other service in a
 * subsequent sweep. This invariant guards against regression — a future
 * service that ships without the migrationsRunFromEnv contract will
 * fail E2E on the first cold-start of the harness.
 *
 * The invariant scans for the literal `migrationsRunFromEnv` token and
 * fails closed when any app module drops that declaration.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function repoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function runtimeServicesWithTypeOrmDataSource(): readonly string[] {
  return readdirSync(resolve(REPO_ROOT, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((service) => existsSync(resolve(REPO_ROOT, 'apps', service, 'src/app.module.ts')))
    .filter((service) =>
      existsSync(resolve(REPO_ROOT, 'apps', service, 'src/database/data-source.ts')),
    )
    .sort();
}

const DATABASE_MIGRATIONS_RUN_TRUE_RE =
  /migrationsRunFromEnv\s*:\s*\([^)]*\)\s*=>\s*[^=]*\.get(?:<string>)?\(\s*['"]DATABASE_MIGRATIONS_RUN['"]\s*,\s*['"]false['"]\s*\)\s*===\s*['"]true['"]/s;

describe('INVARIANT (INFRA-CRITICAL-020 propagation): every service declares migration timing', () => {
  const services = runtimeServicesWithTypeOrmDataSource();

  it('derives the service roster from the generated deployment catalog', () => {
    expect(services).toEqual([
      'admin-api-service',
      'ai-service',
      'alert-engine',
      'auth-service',
      'billing-service',
      'config-service',
      'event-store-service',
      'farm-service',
      'hr-service',
      'hydroponics-service',
      'messaging-service',
      'notification-service',
      'observability-service',
      'sensor-service',
    ]);
  });

  for (const service of services) {
    it(`${service} satisfies the migrationsRunFromEnv contract`, () => {
      const appModule = repoFile(`apps/${service}/src/app.module.ts`);
      const dataSource = repoFile(`apps/${service}/src/database/data-source.ts`);

      if (!DATABASE_MIGRATIONS_RUN_TRUE_RE.test(appModule)) {
        throw new Error(
          `${service}/src/app.module.ts: missing canonical migrationsRunFromEnv declaration. ` +
            `Use the SSoT shape \`migrationsRunFromEnv: (cfg) => cfg.get('DATABASE_MIGRATIONS_RUN', 'false') === 'true'\`.`,
        );
      }

      expect(dataSource).toMatch(/migrationsRun\s*:\s*false/);
      expect(dataSource).toMatch(/synchronize\s*:\s*false/);
    });
  }
});
