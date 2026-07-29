/**
 * Impersonation domain types — GENERATED
 * (`tools/codegen/admin-contracts/manifest.ts`).
 *
 * WHY these shapes: reads NEVER carry token columns (DB-ADMIN-HIGH-002), which
 * is why the read model is `SafeImpersonationSession` — literally
 * `Omit<ImpersonationSession, secrets>` on the backend, so generating the entity
 * here would publish the session token. The raw token is revealed exactly once,
 * on the start response (DB-ADMIN-HIGH-001), which is what
 * `StartedImpersonationSession` adds.
 *
 * The request type is the controller's DTO, not the service input beside it:
 * `StartImpersonationRequest` on the service carries `superAdminId`,
 * `ipAddress` and `userAgent`, which the controller takes from the verified JWT
 * and the socket. A panel that sent them would be rejected by
 * `forbidNonWhitelisted`. The hand-written copy that used to live here had also
 * dropped `permissions`, so a super-admin could not scope a session's access at
 * start time.
 */

// GENERATED backend contracts — tools/codegen/admin-contracts/manifest.ts.
import type {
  ImpersonationAuditSummary,
  ImpersonationAction,
  ImpersonationPermissions,
  ImpersonationPermission,
  SafeImpersonationSession,
  StartedImpersonationSession,
  StartImpersonationRequest,
  GrantPermissionDto,
  ImpersonationEligibility,
  ImpersonationValidation,
  ImpersonationContext,
  ActiveSessionCount,
} from './generated/admin-contracts';

export type {
  ImpersonationAuditSummary,
  ImpersonationAction,
  ImpersonationPermissions,
  ImpersonationPermission,
  SafeImpersonationSession,
  StartedImpersonationSession,
  StartImpersonationRequest,
  GrantPermissionDto,
  ImpersonationEligibility,
  ImpersonationValidation,
  ImpersonationContext,
  ActiveSessionCount,
};

/**
 * The panel's historical names, kept as ALIASES so no call site changes.
 * Each was a hand-written second declaration.
 */
export type ImpersonationSession = SafeImpersonationSession;
export type StartImpersonationResponse = StartedImpersonationSession;
export type ImpersonationSessionStatus = SafeImpersonationSession['status'];
export type ImpersonationReasonCode = SafeImpersonationSession['reason'];

/**
 * The platform-wide impersonation aggregate — GENERATED from
 * `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`.
 *
 * The `InWindow` / `Now` suffixes are the contract, not decoration: this page
 * rendered an all-time session count under a hardcoded "(30d)" label. Deriving
 * the type means the panel cannot silently fall behind a change to what those
 * fields mean.
 */

