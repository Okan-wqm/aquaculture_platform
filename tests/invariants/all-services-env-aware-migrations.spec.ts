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
 * # Allowlist
 *
 * Services that legitimately deviate:
 *
 *   - admin-api-service / event-store-service: use migrationsRunFromEnv
 *     with a default of 'true' (legacy: rely on TypeORM's built-in
 *     runner in prod, no MigrationRunnerService factory provider).
 *   - auth-service: uses static `migrationsRun: true` for the same
 *     legacy reason.
 *   - observability-service: now owns its migration glob and must use
 *     the same env-aware timing contract as the rest of the fleet.
 *
 * The invariant scans for the literal `migrationsRunFromEnv` token and
 * accepts the allowlisted alternatives.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface ServiceContract {
  service: string;
  pattern: 'migrationsRunFromEnv' | 'migrationsRun-true';
}

const CONTRACTS: readonly ServiceContract[] = [
  { service: 'farm-service', pattern: 'migrationsRunFromEnv' },
  { service: 'sensor-service', pattern: 'migrationsRunFromEnv' },
  { service: 'hr-service', pattern: 'migrationsRunFromEnv' },
  { service: 'messaging-service', pattern: 'migrationsRunFromEnv' },
  { service: 'alert-engine', pattern: 'migrationsRunFromEnv' },
  { service: 'billing-service', pattern: 'migrationsRunFromEnv' },
  { service: 'notification-service', pattern: 'migrationsRunFromEnv' },
  { service: 'config-service', pattern: 'migrationsRunFromEnv' },
  { service: 'hydroponics-service', pattern: 'migrationsRunFromEnv' },
  { service: 'ai-service', pattern: 'migrationsRunFromEnv' },
  // admin-api + event-store: legacy migrationsRunFromEnv with default 'true'.
  // Same token, just a different default — still satisfies the contract.
  { service: 'admin-api-service', pattern: 'migrationsRunFromEnv' },
  { service: 'event-store-service', pattern: 'migrationsRunFromEnv' },
  // auth-service: legacy migrationsRun:true (different mechanism, same effect).
  { service: 'auth-service', pattern: 'migrationsRun-true' },
  { service: 'observability-service', pattern: 'migrationsRunFromEnv' },
];

describe('INVARIANT (INFRA-CRITICAL-020 propagation): every service declares migration timing', () => {
  for (const { service, pattern } of CONTRACTS) {
    it(`${service} satisfies the ${pattern} contract`, () => {
      const path = resolve(REPO_ROOT, 'apps', service, 'src/app.module.ts');
      const src = readFileSync(path, 'utf8');

      switch (pattern) {
        case 'migrationsRunFromEnv': {
          if (!/migrationsRunFromEnv\s*:/.test(src)) {
            throw new Error(
              `${service}/src/app.module.ts: missing migrationsRunFromEnv declaration. ` +
                `Add the env-aware migration timing block (see messaging-service for the canonical shape) ` +
                `so E2E tests can run TypeORM's built-in migration runner before SourceSchemaBootstrapService fires.`,
            );
          }
          break;
        }
        case 'migrationsRun-true': {
          if (!/migrationsRun\s*:\s*true/.test(src)) {
            throw new Error(
              `${service}/src/app.module.ts: legacy contract requires \`migrationsRun: true\` ` +
                `(static — service uses TypeORM's built-in runner in prod, no MigrationRunnerService factory).`,
            );
          }
          break;
        }
      }
    });
  }
});
