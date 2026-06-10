import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('config-service and event-store SSOT closure contract', () => {
  it('keeps config tenant identity on GLOBAL_TENANT_UUID, not bare global strings', () => {
    const configSources = [
      'apps/config-service/src/configuration/services/configuration.service.ts',
      'apps/config-service/src/configuration/query-handlers/get-configuration.handler.ts',
      'apps/config-service/src/configuration/query-handlers/get-configurations.handler.ts',
    ].map(read).join('\n');

    expect(configSources).toContain('GLOBAL_TENANT_UUID');
    expect(configSources).not.toMatch(/tenantId\s*[!:]?={0,2}\s*['"]global['"]/);
    expect(configSources).not.toMatch(/tenantId:\s*['"]global['"]/);
  });

  it('keeps config RLS and audit-column hardening migration-owned', () => {
    const appModule = read('apps/config-service/src/app.module.ts');
    const migration = read(
      'apps/config-service/src/database/migrations/1800200000000-ConfigResolutionSecretRlsSsot.ts',
    );

    expect(appModule).not.toContain('autoApply: true');
    expect(appModule).not.toContain('AuditColumnsModule.forRoot');
    expect(migration).toContain('configurations_select_tenant_or_global');
    expect(migration).toContain('CHK_configurations_secret_classification_ssot');
    expect(migration).toContain('WITH CHECK');
    expect(migration).not.toContain('DISABLE ROW LEVEL SECURITY');
    expect(appModule).toContain('TenantExecutionContextInterceptor');
  });

  it('keeps config upsert history atomic and non-silent', () => {
    const upsert = read(
      'apps/config-service/src/configuration/handlers/upsert-configuration.handler.ts',
    );

    expect(upsert).toContain("startTransaction('READ COMMITTED')");
    expect(upsert).toContain('historyRepo.save');
    expect(upsert).toContain("'value_type'");
    expect(upsert).toContain("'is_secret'");
    expect(upsert).not.toContain('historyError');
    expect(upsert).not.toContain('must not block');
  });

  it('keeps config secret classification and cache invalidation environment-aware', () => {
    const update = read(
      'apps/config-service/src/configuration/handlers/update-configuration.handler.ts',
    );
    const service = read(
      'apps/config-service/src/configuration/services/configuration.service.ts',
    );

    expect(update).toContain('explicitlySecret');
    expect(update).toContain('explicitlyNonSecret');
    expect(update).toContain('previousEnvironment');
    expect(update).toContain('nextValueType');
    expect(service).toContain('ConfigurationResolutionService');
    expect(service).toContain('GLOBAL_TENANT_UUID');
    expect(service).toContain('invalidateCache');
    expect(service).toContain('environment');
  });

  it('keeps event-store append idempotency and commit-safe cursor active', () => {
    const service = read(
      'apps/event-store-service/src/event-store/services/event-store.service.ts',
    );
    const migration = read(
      'apps/event-store-service/src/migrations/1800300000000-EventLedgerIdempotencyAndImmutability.ts',
    );

    expect(service).toContain('"event_store"."append_idempotency"');
    expect(service).toContain('"event_store"."ledger_cursors"');
    expect(service).toContain('FOR UPDATE');
    expect(service).toContain('stableJson');
    expect(service).toContain('producerEventId is required');
    expect(service).toContain('producerEventId requires producer');
    expect(migration).toContain('append_idempotency');
    expect(migration).toContain('ledger_cursors');
    expect(migration).toContain('reject_stored_events_mutation');
    expect(migration).toContain('producerEventId');
    expect(migration).toContain('IDX_stored_events_tenant_producer_event');
    expect(migration).toContain('TRG_stored_events_append_only_truncate');
  });

  it('keeps event-store trust chain on signed service identity only', () => {
    const guard = read('apps/event-store-service/src/guards/internal-api-key.guard.ts');
    const main = read('apps/event-store-service/src/main.ts');
    const appModule = read('apps/event-store-service/src/app.module.ts');

    expect(guard).toContain('verifyServiceIdentityRequest');
    expect(guard).toContain('INTERNAL_SERVICE_SECRET');
    expect(guard).toContain("signatureVersion !== 'v2'");
    expect(guard).toContain('Service identity v2 is required');
    expect(guard).toContain('EVENT_STORE_ALLOWED_SERVICE_TENANT_SCOPES');
    expect(guard).toContain('hashVerifiedUserAssertionHeaders');
    expect(guard).toContain('expectedTenantId: tenantHeader');
    expect(guard).not.toContain('INTERNAL_API_KEY');
    expect(guard).not.toContain('x-internal-api-key');
    expect(main).not.toContain('X-Internal-Api-Key');
    expect(main).toContain('bodyParser: false');
    expect(main).toContain('json({ limit: EVENT_STORE_APPEND_BODY_LIMIT })');
    expect(main).not.toContain('globalGuards');
    expect(appModule).toContain('RequestContextMiddleware');
  });

  it('keeps event-store runtime RLS policy DDL out of service boot', () => {
    const appModule = read('apps/event-store-service/src/app.module.ts');
    const migration = read(
      'apps/event-store-service/src/migrations/1800300000000-EventLedgerIdempotencyAndImmutability.ts',
    );

    expect(appModule).not.toContain('autoApply: true');
    expect(migration).toContain('CREATE POLICY');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
  });

  it('keeps projection processing fenced by durable lease and generation', () => {
    const entity = read(
      'apps/event-store-service/src/projections/entities/projection-checkpoint.entity.ts',
    );
    const service = read('apps/event-store-service/src/projections/projections.service.ts');
    const migration = read(
      'apps/event-store-service/src/migrations/1800300000000-EventLedgerIdempotencyAndImmutability.ts',
    );

    for (const token of ['generation', 'leaseOwner', 'leaseToken', 'leaseExpiresAt', 'heartbeatAt']) {
      expect(entity).toContain(token);
      expect(migration).toContain(token);
      expect(service).toContain(token);
    }
    expect(service).toContain('acquireProjectionLease');
    expect(service).toContain('releaseProjectionLease');
    expect(service).toContain('AND "leaseToken" = $4');
    expect(service).toContain('AND "generation" = $7');
    expect(service).toContain('withTenantContext');
    expect(service).toContain('AND "position" = $9');
    expect(service).toContain('rollbackTransaction()');
  });

  it('keeps event-store readiness tied to ledger, RLS, append-only, and projection health', () => {
    const health = read('apps/event-store-service/src/health/health.controller.ts');

    expect(health).toContain('SERVICE_UNAVAILABLE');
    expect(health).toContain('TRG_stored_events_append_only_truncate');
    expect(health).toContain('forced_rls');
    expect(health).toContain('cursor_valid');
    expect(health).toContain('heartbeatAt');
    expect(health).toContain('leaseExpiresAt');
    expect(health).toContain('tenant_max_event');
    expect(health).toContain('projectionLag');
  });
});
