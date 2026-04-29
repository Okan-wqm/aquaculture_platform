export * from './audit-log.entity';
export * from './audit-log.service';
export * from './audit-log.interceptor';
export * from './audit-log.module';
export * from './audited-operation.decorator';
export * from './audited-operation.interceptor';
export * from './audited-operation.module';
export * from './ip-hash.util';
// AUDITTRAIL-HIGH-004 cure: low-level HTTP access stream.
// Distinct entity / service / module from the semantic-action
// audit stream — see access-log.entity.ts class docstring for
// the divergence-by-design rationale.
export * from './access-log.entity';
export * from './access-log.service';
export * from './access-log.module';
// AUDIT_LOG_SERVICE is the canonical DI token; only the tokens module
// owns it. Re-exporting here lets consumers import it from
// `@aquaculture/backend-common/audit` without a deep-tokens path.
// AuditMethod / AuditResult / AuditSeverity / CreateAuditEntryDto come
// transitively via `./audit-log.entity` (which re-exports them from
// the tokens module) — no need to duplicate.
export { AUDIT_LOG_SERVICE } from './audit-log.tokens';
export type { IAuditLogService } from './audit-log.tokens';
