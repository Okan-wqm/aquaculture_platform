// Constants & DI tokens
export {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_OPTIONS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_RETRIES,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
} from './constants';

// Abstract base class — concrete services subclass this
export { OutboxEntityBase } from './outbox-entity.base';

// Public API
export { OutboxPublisher } from './outbox-publisher.service';
export { OutboxWorkerService } from './outbox-worker.service';
export {
  assertOutboxTenantIntegrity,
  OutboxTenantIntegrityError,
} from './tenant-integrity';
export { OutboxMetricsService } from './outbox-metrics.service';
export { OutboxModule } from './outbox.module';
export {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
  TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE,
} from './outbox-migration';
export type {
  TenantErasureTargetProofLedgerDdlOptions,
  TransactionalOutboxDdlOptions,
} from './outbox-migration';
