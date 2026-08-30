/**
 * GDPR tenant-erasure SSoT invariant.
 *
 * COMPLIANCE-CRITICAL-001 cannot be closed by a service-local cascade.
 * The event contract separates orchestrator commands, target proofs, and
 * final proof so no target service can masquerade as the platform proof.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  TENANT_ERASURE_TARGET_SERVICE_COUNT,
  TENANT_ERASURE_TARGET_SERVICES,
} from '../../libs/event-contracts/src/tenant-erasure-targets';
import { TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE } from '../../platform/libs/outbox/src/outbox-migration';
import { TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE } from '../../libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry';
import { TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS } from '../../libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-subscription.options';
import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TARGET_PROOF_LEDGER_FORWARD_MIGRATIONS = [
  {
    service: 'admin-api-service',
    schema: 'admin',
    path: 'apps/admin-api-service/src/migrations/1801000000000-EnsureAdminTenantErasureProofLedger.ts',
  },
  {
    service: 'ai-service',
    schema: 'ai',
    path: 'apps/ai-service/src/database/migrations/1801000000000-EnsureAiTenantErasureProofLedger.ts',
  },
  {
    service: 'alert-engine',
    schema: 'alert',
    path: 'apps/alert-engine/src/database/migrations/1801000000000-EnsureAlertTenantErasureProofLedger.ts',
  },
  {
    service: 'billing-service',
    schema: 'billing',
    path: 'apps/billing-service/src/database/migrations/1801000000000-EnsureBillingTenantErasureProofLedger.ts',
  },
  {
    service: 'farm-service',
    schema: 'farm',
    path: 'apps/farm-service/src/database/migrations/1801500000000-EnsureFarmTenantErasureProofLedger.ts',
  },
  {
    service: 'hr-service',
    schema: 'hr',
    path: 'apps/hr-service/src/database/migrations/1801000000000-EnsureHrTenantErasureProofLedger.ts',
  },
  {
    service: 'hydroponics-service',
    schema: 'hydroponics',
    path: 'apps/hydroponics-service/src/database/migrations/1801000000000-EnsureHydroponicsTenantErasureProofLedger.ts',
  },
  {
    service: 'messaging-service',
    schema: 'messaging',
    path: 'apps/messaging-service/src/migrations/1801000000000-EnsureMessagingTenantErasureProofLedger.ts',
  },
  {
    service: 'notification-service',
    schema: 'notification',
    path: 'apps/notification-service/src/database/migrations/1801000000000-EnsureNotificationTenantErasureProofLedger.ts',
  },
  {
    service: 'sensor-service',
    schema: 'sensor',
    path: 'apps/sensor-service/src/database/migrations/1801000000000-EnsureSensorTenantErasureProofLedger.ts',
  },
  {
    // DB-INFRA-HIGH-003: config-service onboarded as an erasure target 2026-07-12.
    service: 'config-service',
    schema: 'config',
    path: 'apps/config-service/src/database/migrations/1801000000000-EnsureConfigTenantErasureProofLedger.ts',
  },
  {
    // DB-INFRA-HIGH-003: event-store-service (deletable-tables half) 2026-07-12.
    service: 'event-store-service',
    schema: 'event_store',
    path: 'apps/event-store-service/src/migrations/1801000000000-EnsureEventStoreTenantErasureProofLedger.ts',
  },
] as const;

function repoFile(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walkTsFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function relative(abs: string): string {
  return abs.replace(`${REPO_ROOT}/`, '');
}

describe('INVARIANT (COMPLIANCE-CRITICAL-001): tenant-erasure target roster is SSoT', () => {
  it('contains the 12 registry-mandated tenant-data services exactly once', () => {
    expect(TENANT_ERASURE_TARGET_SERVICE_COUNT).toBe(12);
    expect([...TENANT_ERASURE_TARGET_SERVICES].sort()).toEqual([
      'admin-api-service',
      'ai-service',
      'alert-engine',
      'billing-service',
      'config-service',
      'event-store-service',
      'farm-service',
      'hr-service',
      'hydroponics-service',
      'messaging-service',
      'notification-service',
      'sensor-service',
    ]);
    expect(new Set(TENANT_ERASURE_TARGET_SERVICES).size).toBe(
      TENANT_ERASURE_TARGET_SERVICES.length,
    );
  });

  it('backend target executor registry is keyed by the canonical target roster', () => {
    const registry = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-registry.ts',
    );
    const registryKeys = Array.from(registry.matchAll(/^\s*'([^']+)':\s*{/gm))
      .map((match) => match[1])
      .sort();
    expect(registryKeys).toEqual([...TENANT_ERASURE_TARGET_SERVICES].sort());
    for (const service of TENANT_ERASURE_TARGET_SERVICES) {
      expect(registry).toContain(`targetService: '${service}'`);
      expect(registry).toContain("proofLedger: { schema: '");
    }
  });

  it('tenant event contracts expose request, per-service proof, block/fail, and final proof events', () => {
    const events = repoFile('libs/event-contracts/src/tenant-events.ts');
    for (const symbol of [
      'TenantErasureRequestedEvent',
      'TenantDataErasedEvent',
      'TenantDataErasureFailedEvent',
      'TenantErasureBlockedEvent',
      'TenantErasedEvent',
      'TenantErasureTargetService',
    ]) {
      expect(events).toContain(symbol);
    }
  });
});

describe('INVARIANT (COMPLIANCE-CRITICAL-001): final TenantErased is orchestrator-only', () => {
  it('farm-service emits TenantDataErased proof, never final TenantErased', () => {
    const src = repoFile('apps/farm-service/src/compliance/services/tenant-erasure.service.ts');
    expect(src).toMatch(
      /createBaseEvent<TenantDataErasedEvent>\(\s*tenantErasureOutcomeEventType\(\s*'farm-service',\s*'erased'/u,
    );
    expect(src).not.toContain("createBaseEvent<TenantErasedEvent>('TenantErased'");
    expect(src).not.toContain("createBaseEvent('TenantErased'");
  });

  it('no runtime service publishes final TenantErased directly', () => {
    const roots = ['apps', 'libs', 'platform'].map((dir) => resolve(REPO_ROOT, dir));
    const offenders: string[] = [];
    const allowedOrchestrator =
      'apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts';
    for (const root of roots) {
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) continue;
      for (const file of walkTsFiles(root)) {
        const rel = relative(file);
        if (rel.startsWith('libs/event-contracts/src/')) continue;
        if (rel.includes('/__tests__/') || rel.endsWith('.spec.ts')) continue;
        if (rel === allowedOrchestrator) continue;
        const src = readFileSync(file, 'utf8');
        if (
          /createBaseEvent(?:<[^>]+>)?\(\s*['"]TenantErased['"]/.test(src) ||
          /eventType\s*:\s*['"]TenantErased['"]/.test(src)
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('admin-api owns final proof aggregation and status purge finalization', () => {
    const src = repoFile('apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts');
    expect(src).toContain('TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET');
    expect(src).toContain('TENANT_ERASURE_OUTCOME_KINDS');
    expect(src).toContain('resolveTenantErasureOutcomeEventType(event.eventType)');
    expect(src).toContain('Tenant-erasure outcome identity mismatch');
    expect(src).not.toContain("subscribeWildcard('TenantDataErased'");
    expect(src).toContain('platform.request_tenant_schema_deletion');
    expect(src).toContain('isSchemaDeletionComplete');
    expect(src).toContain("createBaseEvent<TenantErasedEvent>('TenantErased'");
    expect(src).toContain('TenantStatus.PURGED');
    expect(src).toContain('TENANT_ERASURE_TARGET_SERVICES');
  });

  it('non-farm target services subscribe through the shared TenantErasureTargetModule', () => {
    const serviceModules: Record<string, string> = {
      'admin-api-service': 'apps/admin-api-service/src/tenant/tenant.module.ts',
      'ai-service': 'apps/ai-service/src/app.module.ts',
      'alert-engine': 'apps/alert-engine/src/app.module.ts',
      'billing-service': 'apps/billing-service/src/app.module.ts',
      'hr-service': 'apps/hr-service/src/app.module.ts',
      'hydroponics-service': 'apps/hydroponics-service/src/app.module.ts',
      'messaging-service': 'apps/messaging-service/src/app.module.ts',
      'notification-service': 'apps/notification-service/src/app.module.ts',
      'sensor-service': 'apps/sensor-service/src/app.module.ts',
    };

    for (const [service, modulePath] of Object.entries(serviceModules)) {
      const src = repoFile(modulePath);
      expect(src).toContain("from '@aquaculture/backend-common/compliance'");
      expect(src).toContain(`TenantErasureTargetModule.forService('${service}')`);
    }
  });

  it('shared target module is the only generic TenantErasureRequested subscriber', () => {
    const targetModule = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target.module.ts',
    );
    expect(targetModule).toMatch(/subscribeWildcard\(\s*['"]TenantErasureRequested['"]/u);
    expect(targetModule).toContain('TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS');
    expect(targetModule).toContain('TenantErasureTargetExecutor');

    const farmHandler = repoFile(
      'apps/farm-service/src/compliance/tenant-erasure-requested.handler.ts',
    );
    expect(farmHandler).toMatch(/subscribeWildcard\(\s*['"]TenantErasureRequested['"]/u);
    expect(farmHandler).toContain('TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS');
    expect(farmHandler).toContain('TenantErasureService');
  });

  it('uses a versioned full-replay durable for compliance request liveness', () => {
    expect(TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS).toEqual({
      durable: true,
      consumerVersion: 'tenant-erasure-v2',
      startFrom: 'beginning',
      ackWait: 60,
      maxRetries: -1,
    });

    const eventBusInterface = repoFile(
      'platform/libs/event-bus/src/interfaces/event-bus.interface.ts',
    );
    const natsEventBus = repoFile('platform/libs/event-bus/src/nats/nats-event-bus.ts');
    expect(eventBusInterface).toContain('consumerVersion?: string');
    expect(natsEventBus).toContain('options?.consumerVersion');
    expect(natsEventBus).toContain('`${baseName}-${consumerVersion}`');
  });

  it('shared target erasure is fail-closed on the canonical LegalHoldService', () => {
    const moduleSrc = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target.module.ts',
    );
    const executorSrc = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts',
    );

    expect(moduleSrc).toContain('LegalHoldModule.forRoot()');
    expect(moduleSrc).toMatch(/legalHoldService:\s*LegalHoldService/);
    expect(executorSrc).toMatch(
      /readonly legalHoldService:\s*TenantErasureTargetLegalHold/,
    );
    expect(executorSrc).toMatch(
      /interface TenantErasureTargetLegalHold[\s\S]{0,160}assertNoHold\(tenantId: string, scope: 'tenant'\): Promise<void>/,
    );
    expect(executorSrc).toContain(
      "await this.deps.legalHoldService.assertNoHold(event.tenantId, 'tenant')",
    );
    expect(executorSrc).toContain('error instanceof LegalHoldActiveError');
    expect(executorSrc).toMatch(/createBaseEvent<TenantErasureBlockedEvent>\(\s*blockedEventType/u);
    expect(executorSrc).toMatch(
      /tenantErasureOutcomeEventType\(\s*this\.options\.targetService,\s*'blocked'/u,
    );

    const holdOffset = executorSrc.indexOf('await this.deps.legalHoldService.assertNoHold');
    const transactionOffset = executorSrc.indexOf('return await this.deps.dataSource.transaction');
    expect(holdOffset).toBeGreaterThan(0);
    expect(holdOffset).toBeLessThan(transactionOffset);
  });

  it('shared target proofs use a durable ledger instead of outbox retention', () => {
    const executorSrc = repoFile(
      'libs/backend-common/src/compliance/tenant-erasure/tenant-erasure-target-executor.ts',
    );
    const outboxMigration = repoFile('platform/libs/outbox/src/outbox-migration.ts');
    const backendDatabaseIndex = repoFile('libs/backend-common/src/database/index.ts');

    expect(outboxMigration).toContain('TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE');
    expect(outboxMigration).toContain('tenant_erasure_target_proofs');
    expect(executorSrc).toContain('readExistingProof(event');
    expect(executorSrc).toContain('recordProofLedger(manager, proofEvent)');
    expect(executorSrc).toContain('pg_advisory_xact_lock');
    expect(executorSrc).toContain('this.options.proofLedger.schema');
    expect(executorSrc).toContain('this.options.proofLedger.table');
    expect(backendDatabaseIndex).not.toContain('buildTransactionalOutboxUpSql');
  });

  it('declares every target proof ledger as source-schema infrastructure', () => {
    for (const options of Object.values(TENANT_ERASURE_TARGET_OPTIONS_BY_SERVICE)) {
      const moduleSchema = MODULE_SCHEMAS.find(
        (entry) =>
          entry.moduleName === options.moduleName && entry.sourceSchema === options.sourceSchema,
      );
      expect(moduleSchema).toBeDefined();
      expect(moduleSchema?.infrastructureTables ?? []).toContain(options.proofLedger.table);
      expect(moduleSchema?.tables ?? []).not.toContain(options.proofLedger.table);
    }
  });

  it('creates target proof ledgers through forward migrations, not edited applied migrations', () => {
    expect(TARGET_PROOF_LEDGER_FORWARD_MIGRATIONS.map((entry) => entry.service).sort()).toEqual(
      [...TENANT_ERASURE_TARGET_SERVICES].sort(),
    );

    for (const entry of TARGET_PROOF_LEDGER_FORWARD_MIGRATIONS) {
      const migration = repoFile(entry.path);
      expect(migration).toContain('SourceOnlyMigration');
      expect(migration).toContain('buildTenantErasureTargetProofLedgerUpSql');
      expect(migration).toContain('buildTenantErasureTargetProofLedgerDownSql');
      expect(migration).toContain(`schema: '${entry.schema}'`);
      expect(migration).toContain(`idx_${entry.schema}_erasure_proofs_tenant`);
      expect(migration).toContain(`idx_${entry.schema}_erasure_proofs_event`);
      expect(migration).toContain(`idx_${entry.schema}_erasure_proofs_target`);
    }
  });

  it('admin erasure request validates legal hold before operation creation', () => {
    const src = repoFile('apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts');

    expect(src).toMatch(
      /@Inject\(LegalHoldService\)[\s\S]{0,120}private readonly legalHoldService:\s*TenantErasureLegalHoldService/,
    );
    expect(src).not.toMatch(/@Optional\s*\(\s*\)[\s\S]{0,160}legalHoldService/);
    expect(src).toContain("await this.legalHoldService.assertNoHold(command.tenantId, 'tenant')");

    const holdOffset = src.indexOf('await this.legalHoldService.assertNoHold(command.tenantId');
    const runnerOffset = src.indexOf('const queryRunner = this.dataSource.createQueryRunner()');
    const insertOffset = src.indexOf('INSERT INTO admin.tenant_erasure_operations');
    expect(holdOffset).toBeGreaterThan(0);
    expect(holdOffset).toBeLessThan(runnerOffset);
    expect(holdOffset).toBeLessThan(insertOffset);
  });

  it('admin finalizer re-checks legal hold before schema deletion and final proof', () => {
    const src = repoFile('apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts');
    expect(src).toContain('private readonly legalHoldService: TenantErasureLegalHoldService');
    expect(src).toContain('const legalHoldCheckedAt = await this.assertLiveLegalHold');
    expect(src).toContain('const finalLegalHoldCheckedAt = await this.assertLiveLegalHold');
    expect(src).toContain('"legalHoldCheckedAt" = $5');
    expect(src).toContain('"legalHoldCheckedAt" = $6');
    expect(src).toContain('initialLegalHoldCheckedAt');
  });

  it('farm consumes orchestrator requests and returns service-scoped proof', () => {
    const handler = repoFile(
      'apps/farm-service/src/compliance/tenant-erasure-requested.handler.ts',
    );
    const service = repoFile('apps/farm-service/src/compliance/services/tenant-erasure.service.ts');
    expect(handler).toMatch(/subscribeWildcard\(\s*['"]TenantErasureRequested['"]/u);
    expect(handler).toContain('TENANT_ERASURE_REQUEST_SUBSCRIPTION_OPTIONS');
    expect(handler).toContain('eraseFromTenantErasureRequest(event)');
    expect(service).toContain('eraseFromTenantErasureRequest');
    expect(service).toContain('idempotencyKey: `tenant-erasure:${operationId}:farm-service`');
    expect(service).toContain('event.dryRun');
    expect(service).toContain('recordProofLedger(mgr, erasedEvent)');
    expect(service).toContain('createBaseEvent<TenantErasureBlockedEvent>');
    expect(service).toMatch(/tenantErasureOutcomeEventType\(\s*'farm-service',\s*'blocked'/u);
    expect(service).toContain('createBaseEvent<TenantDataErasureFailedEvent>');
    expect(service).toMatch(/tenantErasureOutcomeEventType\(\s*'farm-service',\s*'failed'/u);
  });

  it('farm erasure dependencies are required and legal-hold is checked before erasure work', () => {
    const src = repoFile('apps/farm-service/src/compliance/services/tenant-erasure.service.ts');
    expect(src).not.toMatch(/@Optional\s*\(\s*\)[\s\S]{0,160}(outboxPublisher|legalHoldService)/);
    expect(src).toMatch(/private readonly outboxPublisher:\s*OutboxPublisher/);
    expect(src).toMatch(/private readonly legalHoldService:\s*LegalHoldService/);

    const legalHoldOffset = src.indexOf('await this.legalHoldService.assertNoHold');
    const replayOffset = src.indexOf('const replay = await this.lookupExistingErasure');
    const ticketOffset = src.indexOf('const ticket = this.pending.get');
    const executeOffset = src.indexOf('const result = await this.executeErasure');
    expect(legalHoldOffset).toBeGreaterThan(0);
    expect(legalHoldOffset).toBeLessThan(replayOffset);
    expect(legalHoldOffset).toBeLessThan(ticketOffset);
    expect(legalHoldOffset).toBeLessThan(executeOffset);
  });

  it('farm AppModule imports the canonical LegalHoldModule', () => {
    const src = repoFile('apps/farm-service/src/app.module.ts');
    expect(src).toContain("from '@aquaculture/backend-common/compliance'");
    expect(src).toContain('LegalHoldModule.forRoot()');
  });

  it('observability has no second tenant-erasure entrypoint outside the roster', () => {
    const gdprModule = repoFile('apps/observability-service/src/gdpr/gdpr.module.ts');
    const appModule = repoFile('apps/observability-service/src/app.module.ts');
    expect(gdprModule).not.toContain('EraseObservabilityTenantDataHandler');
    expect(gdprModule).toContain('ExportObservabilityTenantDataHandler');
    expect(appModule).toContain('excludes observability');
  });
});
