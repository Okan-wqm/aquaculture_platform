/**
 * SessionSnapshot (plan A1) — a single immutable read-model of the current session,
 * composed from the existing token / tenant / epoch authorities (api-client +
 * session-epoch + token-lifecycle). It is the SSoT for "is there an authenticated
 * tenant session", so the non-React layers (sockets, clients) stop scattering
 * `getAccessToken() && getTenantId()` checks across the codebase.
 *
 * `ready` is the authenticated-tenant-session predicate: an access token AND an
 * effective tenant are both present.
 *
 * SCOPE NOTE: the plan's tenant-VERIFIED ready (also requiring
 * `tenantStatus === ACTIVE`, plus `userId` / `role`) needs AuthContext to PUSH the
 * server-resolved status into this snapshot, and a reactive subscribe that
 * `tokenLifecycle` does not yet expose — those are a later PR-A piece. The backend
 * `EffectiveTenantMiddleware` remains the authority on tenant status (PR-C / #667).
 * This v1 composes only what the token/tenant authorities already know.
 *
 * This is a READ-MODEL, not a store of record — every field is read fresh from its
 * owning authority on each call, so it can never go stale relative to them.
 */
import { getAccessToken, getTenantId } from './api-client';
import { getSessionEpoch } from './session-epoch';
import { tokenLifecycle, type TokenState } from './token-lifecycle';

export interface SessionSnapshot {
  readonly accessToken: string | null;
  readonly effectiveTenantId: string | null;
  readonly sessionEpoch: number;
  readonly tokenState: TokenState;
  /** True when an access token AND an effective tenant are both present. */
  readonly ready: boolean;
}

export function getSessionSnapshot(): SessionSnapshot {
  const accessToken = getAccessToken();
  const effectiveTenantId = getTenantId();
  return {
    accessToken,
    effectiveTenantId,
    sessionEpoch: getSessionEpoch(),
    tokenState: tokenLifecycle.getState(),
    ready: !!accessToken && !!effectiveTenantId,
  };
}
