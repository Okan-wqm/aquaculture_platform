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

import type { AdminApiRouteBody, AdminApiRouteResponse } from './generated/admin-route-contracts';

/** Generated from the backend response-contract DAG; never maintain a parallel session shape. */
export type ImpersonationSession =
  AdminApiRouteResponse<'GET /impersonation/sessions'>['items'][number];

export type ImpersonationSessionStatus = ImpersonationSession['status'];
export type ImpersonationReasonCode = ImpersonationSession['reason'];

export type ImpersonationPermission =
  AdminApiRouteResponse<'GET /impersonation/permissions'>['items'][number];

/**
 * POST /impersonation/sessions/start response — the ONLY response that carries
 * the raw impersonation token (revealed once; reads never echo it back).
 */
export type StartImpersonationResponse =
  AdminApiRouteResponse<'POST /impersonation/sessions/start'>;

/**
 * POST /impersonation/sessions/start request body (backend StartImpersonationDto).
 * No admin identity fields: the backend derives superAdminId from the JWT and
 * rejects unknown properties (forbidNonWhitelisted).
 */
export type StartImpersonationRequest = AdminApiRouteBody<'POST /impersonation/sessions/start'>;
