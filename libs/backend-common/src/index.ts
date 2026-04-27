/**
 * backend-common root barrel — aggregates every sub-barrel for
 * back-compat with existing consumers (449 files import from this path
 * as of AUDIT-MEDIUM-005).
 *
 * NEW CODE should import from a specific subtree path instead:
 *   import { hashPassword } from '@aquaculture/backend-common/auth';
 *   import { TenantGuard } from '@aquaculture/backend-common/guards';
 *   import { maskPii } from '@aquaculture/backend-common/utils';
 *
 * Rationale: the root barrel re-exports ~20 subtrees, so every change in
 * any one of them invalidates every consumer of the root barrel, even
 * consumers that only use an unrelated subtree. Sub-barrel imports limit
 * TypeScript + bundler invalidation to the consumers that actually pull
 * from the changed subtree. See AUDIT-MEDIUM-005 + ADR-028 lib-creation
 * rubric.
 *
 * The two deliberately-NOT-re-exported subtrees remain deep-import-only:
 *   @aquaculture/backend-common/audit
 *   @aquaculture/backend-common/finding-registry
 *   @aquaculture/backend-common/ai-safety
 *   @aquaculture/backend-common/gdpr
 * These carry @Entity() decorators whose side-effect registers tables in
 * TypeORM's global metadata storage; re-exporting them from the root
 * barrel would pollute every backend-common consumer (DEFECT-1,
 * INFRA-CRITICAL-021). Consumers that need them import via the deep path.
 */

export * from './types';
export * from './tenant';
export * from './decorators';
export * from './guards';
export * from './utils';
export * from './http';
export { readSecret, bootstrapSecrets } from './config';
export * from './auth';
export * from './filters';
export * from './middleware';
export * from './database';
export * from './redis';
export * from './context';
export * from './logging';
export * from './telemetry';
export * from './metrics';
export * from './orchestrator-leader-election';
export * from './orchestrator-rate-limit';
export * from './security';
export * from './pagination';
export * from './health';

// Audit — DI-token-level exports only (see audit/audit-log.tokens);
// entity-touching classes remain deep-import-only to avoid TypeORM
// metadata pollution in unrelated services.
export {
  AUDIT_LOG_SERVICE,
  AuditSeverity,
} from './audit/audit-log.tokens';
export type {
  IAuditLogService,
  CreateAuditEntryDto,
} from './audit/audit-log.tokens';
export {
  AuditedOperation,
  AUDITED_OPERATION_KEY,
  AuditedOperationStatus,
} from './audit/audited-operation.decorator';
export type { AuditedOperationOptions } from './audit/audited-operation.decorator';

export * from './nats';
export * from './constants';
export * from './bootstrap';
export * from './monitoring';
export * from './websocket';
export * from './monetary';
