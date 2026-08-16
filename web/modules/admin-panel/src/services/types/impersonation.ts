/**
 * Impersonation domain types
 *
 * WHY these shapes: the read model mirrors the backend `SafeImpersonationSession`
 * (admin-api `impersonation-session.entity.ts`) field-for-field. Read responses
 * NEVER carry token columns (DB-ADMIN-HIGH-002); the raw impersonation token is
 * revealed exactly once, on the start response (DB-ADMIN-HIGH-001). Request
 * types mirror the controller DTOs — the super-admin identity always comes from
 * the verified JWT, never from the request body.
 */
import type {
  AdminImpersonationActionV1,
  AdminGrantImpersonationPermissionV1,
  AdminImpersonationPermissionV1,
  AdminImpersonationPermissionCheckV1,
  AdminImpersonationPermissionRevocationV1,
  AdminImpersonationPermissionsV1,
  AdminImpersonationReasonV1,
  AdminImpersonationSessionStatusV1,
  AdminImpersonationSessionScopeV1,
  AdminImpersonationSessionV1,
  AdminImpersonationStatsV1,
  AdminStartedImpersonationSessionV1,
  AdminStartImpersonationRequestV1,
} from '@platform/admin-http-contracts';

/** Mirrors backend `ImpersonationStatus` — there is no 'revoked'; operator override is 'terminated'. */
export type ImpersonationSessionStatus = AdminImpersonationSessionStatusV1;
export type ImpersonationSessionScope = AdminImpersonationSessionScopeV1;

/** Mirrors backend `ImpersonationReason` — the start endpoint validates against this enum. */
export type ImpersonationReasonCode = AdminImpersonationReasonV1;

export type ImpersonationPermission = AdminImpersonationPermissionV1;
export type ImpersonationPermissionCheck = AdminImpersonationPermissionCheckV1;
export type ImpersonationPermissionRevocation = AdminImpersonationPermissionRevocationV1;
export type ImpersonationPermissions = AdminImpersonationPermissionsV1;
export type GrantImpersonationPermissionRequest = AdminGrantImpersonationPermissionV1;

/**
 * Read model for GET /impersonation/sessions* — the backend's
 * SafeImpersonationSession. Optionality follows the entity's nullable columns.
 * `actionsPerformed` (the action array) is intentionally omitted: the UI only
 * consumes the numeric `actionCount`.
 */
export type ImpersonationSession = AdminImpersonationSessionV1;

/**
 * POST /impersonation/sessions/start response — the ONLY response that carries
 * the raw impersonation token (revealed once; reads never echo it back).
 */
export type StartImpersonationResponse = AdminStartedImpersonationSessionV1;

/**
 * POST /impersonation/sessions/start request body (backend StartImpersonationDto).
 * No admin identity fields: the backend derives superAdminId from the JWT and
 * rejects unknown properties (forbidNonWhitelisted).
 */
export type StartImpersonationRequest = AdminStartImpersonationRequestV1;

/**
 * One entry of a session's action log — mirrors the backend `ImpersonationAction`
 * interface ({ action, resource, resourceId?, timestamp, details? }); the
 * log-action endpoint validates exactly these fields.
 */
export type ImpersonationAction = AdminImpersonationActionV1;
export type ImpersonationStats = AdminImpersonationStatsV1<ImpersonationSession>;
