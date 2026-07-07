/**
 * Auth-service credential-confirmation NATS query contract (request/reply —
 * NOT a BaseEvent envelope).
 *
 * WHY this exists: an irreversible self-service action in another service —
 * messaging's GDPR Article-17 `anonymizeMyData` mutation — must re-confirm
 * the caller's OWN password before it destroys their data. The credential
 * SSoT is auth-service; a tenant-owned service must never store or check a
 * password hash itself. This contract lets the owning service ask auth
 * EXACTLY one question — "does this plaintext match this user's stored
 * password?" — and get back a single boolean.
 *
 * Subject naming follows the established `request.auth.<op>` request/reply
 * pattern (see tenant-commands.ts / auth-user-queries.ts).
 *
 * # No-oracle posture (deliberate, load-bearing)
 *
 *   - The reply is a BARE BOOLEAN, never a richer object. This is BOTH the
 *     anti-oracle lock (no field can leak whether the user exists, is
 *     locked, etc.) AND a wire-compatibility guarantee: the sole caller
 *     issues `send<boolean, VerifyPasswordQuery>` and treats a truthy reply
 *     as "password valid". A result OBJECT would make `!!reply` true for a
 *     wrong password — a fail-OPEN during any rollout skew. Errors are
 *     surfaced as an RpcException (caller fails closed), never as `false`
 *     conflated with a wrong password... except that the responder is free
 *     to fail closed to `false` if it prefers to block the irreversible
 *     action on any doubt.
 *   - The responder MUST be timing-safe (run the same peppered-bcrypt
 *     pipeline for a missing user as for a real one) and MUST NOT mutate
 *     lockout state — this is a re-confirmation, not a login; locking an
 *     account because the owner mistyped a GDPR confirmation is hostile.
 *   - The responder rate-limits per userId (defence-in-depth against a
 *     compromised caller; the legitimate GDPR mutation is already
 *     rate-limited caller-side).
 */

export const AUTH_CREDENTIAL_SUBJECTS = {
  /**
   * Confirm a user's CURRENT password. Request: {@link VerifyPasswordQuery}.
   * Reply: bare `boolean` (`true` iff the plaintext matches the stored hash);
   * an RpcException on validation failure / rate-limit / internal error so the
   * caller fails closed on the irreversible action it gates.
   */
  VERIFY_PASSWORD: 'request.auth.verifyPassword',
} as const;

/**
 * Request payload for {@link AUTH_CREDENTIAL_SUBJECTS.VERIFY_PASSWORD}.
 *
 * `userId` MUST be the caller's own authenticated user id (the caller derives
 * it from its verified request context, never from client input). auth trusts
 * the calling service's NATS cert identity for that binding and additionally
 * rate-limits per `userId`.
 */
export interface VerifyPasswordQuery {
  userId: string;
  /** Plaintext to confirm. Bounded (1..128) to match the login DTO. */
  password: string;
  correlationId?: string;
}
