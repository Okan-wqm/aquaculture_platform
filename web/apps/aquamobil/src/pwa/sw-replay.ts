/**
 * @module sw-replay
 * @description Closed-app Background Sync replay (MOB-MEDIUM-002).
 *
 * Before this module, the SW `sync` handler only posted SYNC_COMPLETE to open
 * window clients — with the app CLOSED there was nobody to notify, so a field
 * worker's offline records sat stranded until the next launch. This module is
 * the real drain lane for that case:
 *
 *   1. If ANY window client is open, the foreground OfflineProvider owns the
 *      drain (it has the richer executor incl. the blob lane) — the SW only
 *      notifies and stops, so an operation can never execute twice.
 *   2. With ZERO clients, the SW takes the shared Web Lock
 *      ({@link QUEUE_DRAIN_LOCK}, also held by the foreground syncNow), mints
 *      an access token through the httpOnly refresh cookie (same-origin
 *      `credentials: 'include'` — the cookie is available to SW fetches), and
 *      runs syncAllOperations against the refreshed identity's tenant with a
 *      fetch-based executor built on the shared operation registry.
 *   3. Any refresh failure is a SILENT no-op: the queue is untouched and the
 *      "will sync when you reopen the app" story stays true.
 *
 * Mutual exclusion: the zero-clients gate plus the shared Web Lock make an
 * SW-drain racing a foreground drain structurally impossible. The residual
 * window — the app booting and firing its own cookie refresh in the instant
 * the SW's refresh is in flight — is bounded to one request round-trip; the
 * SW re-checks for clients after acquiring the lock to shrink it further.
 * Where Web Locks are unavailable there is no cross-context mutual exclusion,
 * so the SW conservatively leaves the drain to the next foreground.
 *
 * MSG-MEDIUM-055: blob-lane ops (uploadAndSendMessage) are SKIPPED — their
 * presign → PUT → send replay needs the foreground media plumbing. They stay
 * queued with retryCount untouched and drain on the next app open.
 */

import { GraphQLReplayError, type GraphQLEnvelopeError } from './graphql-replay-error';
import { syncAllOperations } from './offline-queue';
import {
  OPERATION_MUTATIONS,
  SW_REPLAY_SKIP_TYPES,
  buildOperationVariables,
  getLeaveSubmitFollowUp,
} from './operation-registry';

import type { OperationPayload, OperationType } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Shared Web Lock name — the foreground syncNow (useOfflineQueue.tsx) holds
 * the SAME lock around its drain, so the two lanes serialize.
 */
export const QUEUE_DRAIN_LOCK = 'aquamobil-queue-drain';

/** SEC-06: CSRF defense-in-depth header, identical to the app's auth lane. */
const CSRF_HEADER = { 'X-Requested-With': 'XMLHttpRequest' } as const;

/**
 * Minimal refresh document — deliberately NOT a copy of useAuth's
 * REFRESH_MUTATION: the SW needs only the token and the tenant identity, so it
 * selects only those fields (a narrower selection is always schema-compatible).
 * The `input.refreshToken` argument is an empty string by contract — the real
 * refresh token is the httpOnly cookie the request carries.
 */
const SW_REFRESH_MUTATION = `
  mutation RefreshToken($input: RefreshTokenInput!) {
    refreshToken(input: $input) {
      accessToken
      user {
        tenantId
      }
    }
  }
`;

interface SwAuthIdentity {
  accessToken: string;
  tenantId: string;
}

interface GraphQLEnvelope {
  data?: unknown;
  errors?: GraphQLEnvelopeError[];
}

/**
 * Mint a fresh access token + tenant identity from the httpOnly refresh
 * cookie. Returns null on ANY failure (no cookie, expired session, network) —
 * the caller treats null as "leave the queue for the next foreground".
 */
async function refreshViaCookie(): Promise<SwAuthIdentity | null> {
  try {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CSRF_HEADER },
      credentials: 'include',
      body: JSON.stringify({
        query: SW_REFRESH_MUTATION,
        variables: { input: { refreshToken: '' } },
      }),
    });
    if (!response.ok) return null;
    const result = (await response.json()) as {
      data?: { refreshToken?: { accessToken?: string; user?: { tenantId?: string | null } } };
    };
    const accessToken = result.data?.refreshToken?.accessToken;
    const tenantId = result.data?.refreshToken?.user?.tenantId;
    if (!accessToken || !tenantId) return null;
    return { accessToken, tenantId };
  } catch (error) {
    logger.warn('[sw-replay] cookie refresh failed — queue left for next foreground', error);
    return null;
  }
}

/** POST one GraphQL document with the minted SW identity. Throws on errors. */
async function postGraphQL(
  auth: SwAuthIdentity,
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch('/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.accessToken}`,
      'X-Tenant-Id': auth.tenantId,
      ...CSRF_HEADER,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status}`);
  }
  const result = (await response.json()) as GraphQLEnvelope;
  if (result.errors && result.errors.length > 0) {
    // Same classification as the foreground lane: the server's code decides
    // whether the queue retries (MOB-CRITICAL-018 class).
    throw GraphQLReplayError.fromEnvelope(result.errors);
  }
  return result.data;
}

/**
 * The SW-side executor for syncAllOperations. Blob-lane types never reach it
 * (they ride in syncAllOperations' skipTypes), so the cast to the
 * single-mutation subset is guaranteed by construction.
 */
function createSwExecutor(auth: SwAuthIdentity) {
  return async (type: OperationType, payload: OperationPayload): Promise<unknown> => {
    const mutationType = type as Exclude<OperationType, 'uploadAndSendMessage'>;
    const data = await postGraphQL(
      auth,
      OPERATION_MUTATIONS[mutationType],
      buildOperationVariables(mutationType, payload),
    );
    // createLeaveRequest chains an immediate submit — same contract as the
    // foreground lane (shared registry helper, cannot drift).
    const followUp = getLeaveSubmitFollowUp(type, data);
    if (followUp) {
      await postGraphQL(auth, followUp.query, followUp.variables);
    }
    return data;
  };
}

/**
 * The minimal surface of the SW global this module needs — typed narrowly so
 * the replay is unit-testable without a real ServiceWorkerGlobalScope.
 */
/**
 * The single Web Locks capability the closed-app drain depends on. Interface
 * segregation: this lane calls only `request` (never `query`), so narrowing to
 * exactly what is used keeps the scope — and its test doubles — honest. A real
 * `LockManager` structurally satisfies it.
 */
export interface QueueDrainLockManager {
  request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<void>;
}

export interface BackgroundSyncScope {
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<
      ReadonlyArray<{ postMessage(message: unknown): void }>
    >;
  };
  navigator: { locks?: QueueDrainLockManager };
}

async function notifyClients(swSelf: BackgroundSyncScope): Promise<boolean> {
  const clients = await swSelf.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const client of clients) {
    // SYNC_COMPLETE is the message the OfflineProvider listens for — it
    // refreshes the queue and runs the foreground drain.
    client.postMessage({ type: 'SYNC_COMPLETE' });
  }
  return clients.length > 0;
}

/**
 * Entry point wired into the SW `sync` event (messaging-sw.ts).
 */
export async function handleBackgroundSyncEvent(swSelf: BackgroundSyncScope): Promise<void> {
  // Lane 1: an open app owns the drain — notify and stop (no double-execution).
  if (await notifyClients(swSelf)) return;

  // Lane 2: closed app. Web Locks are required for cross-context mutual
  // exclusion with a foreground that may open mid-drain; without them the SW
  // conservatively defers to the next foreground (queue intact, never lost).
  const locks = swSelf.navigator.locks;
  if (!locks) return;

  await locks.request(QUEUE_DRAIN_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) return; // a foreground drain holds the lock — it owns the queue

    // Shrink the refresh race window: an app that opened between the first
    // check and lock acquisition owns the drain.
    if (await notifyClients(swSelf)) return;

    const auth = await refreshViaCookie();
    if (!auth) return;

    try {
      const result = await syncAllOperations(auth.tenantId, createSwExecutor(auth), {
        skipTypes: SW_REPLAY_SKIP_TYPES,
      });
      logger.info('[sw-replay] closed-app drain finished', result);
    } catch (error) {
      // Per-op failures are already recorded on the ops themselves; this only
      // catches infrastructure errors so the sync event never rejects.
      logger.error('[sw-replay] closed-app drain aborted', error);
    }
  });
}
