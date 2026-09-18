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
export type { OutboxEnqueueOptions } from './outbox-publisher.service';
export { OutboxWorkerService } from './outbox-worker.service';
export {
  OUTBOX_DELIVERY_POLICY_FIELD,
  OUTBOX_ROUTING_SCOPE_FIELD,
  OUTBOX_SECURITY_RECOVERY_POLICY,
  OUTBOX_SYSTEM_TENANT_ID,
  OutboxStorageMetadataError,
  assertOutboxDeliveryPolicyIntegrity,
  hasSecurityRecoveryDeliveryPolicy,
  withoutOutboxRoutingAttestation,
} from './outbox-routing';
export type {
  OutboxDeliveryPolicy,
  OutboxFeatureOptions,
  OutboxRoutingScope,
  OutboxStoredPayload,
} from './outbox-routing';
export { assertOutboxTenantIntegrity, OutboxTenantIntegrityError } from './tenant-integrity';
export { OutboxMetricsService } from './outbox-metrics.service';
export { OutboxModule } from './outbox.module';
export {
  buildEventDlqDownSql,
  buildEventDlqUpSql,
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
  buildTransactionalOutboxDownSql,
  buildTransactionalOutboxUpSql,
  EVENT_DLQ_TABLE,
  TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE,
} from './outbox-migration';
export type {
  EventDlqDdlOptions,
  TenantErasureTargetProofLedgerDdlOptions,
  TransactionalOutboxDdlOptions,
} from './outbox-migration';
