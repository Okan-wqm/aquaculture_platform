/**
 * Per-service NATS reply-inbox namespace — SSoT (ORPHAN-CRITICAL-402).
 *
 * # The defect this closes
 *
 * Core-NATS request-reply returns the response on the requester's reply
 * subject. nats.js mints that subject from a connection-level *inbox prefix*
 * whose default is the literal `_INBOX`. Every service on this platform used
 * that default AND held `subscribe: "_INBOX.>"` in its NATS ACL, so ANY
 * service certificate could passively subscribe the reply stream of EVERY
 * request-reply exchange on the broker — password-reset replies, user records,
 * admin RPC results. The ACL was a fleet-wide read grant on other services'
 * responses, not an isolation boundary.
 *
 * # The cure
 *
 * NATS subject matching is segment-exact on the first token, so two prefixes
 * that differ in their FIRST token can never match one another's wildcard
 * grant. Giving each NATS identity its own first token — `_INBOX_<identity>` —
 * turns "who may read this reply" into a per-certificate question the broker
 * answers structurally:
 *
 *   - `_INBOX_auth_service.>` is granted to CN=auth_service and to nobody else.
 *   - `_INBOX.>` (the shared token) is granted to nobody at all, and
 *     `services.schema.json` structurally rejects any attempt to re-add it.
 *   - Responders publish replies through the broker's `allow_responses`
 *     permission, which mints a per-request, expiring publish grant on the
 *     reply subject of a request the responder ACTUALLY received. No static
 *     publish grant on anyone else's inbox exists to be abused.
 *
 * `identity` is the mTLS client-certificate CN (ADR-015: the cert IS the
 * identity), which is exactly the key the NATS `authorization.users[]` block
 * is written against — so the prefix a client subscribes and the grant the
 * broker holds are derived from the same string and cannot drift.
 *
 * The two pre-existing scoped inboxes (`_INBOXBILLINGCFG`,
 * `_INBOXFARMMARINECFG` in `config-runtime.ts`) are the same mechanism applied
 * per-EXCHANGE rather than per-identity; they remain the tighter grant for
 * secret-bearing payloads and are unaffected by this module.
 */

/**
 * First-token namespace root for per-identity reply inboxes. A prefix is
 * `${PLATFORM_INBOX_PREFIX_ROOT}${identity}` — note there is NO trailing dot:
 * `createInbox(prefix)` appends `.<nuid>` itself.
 */
export const PLATFORM_INBOX_PREFIX_ROOT = '_INBOX_';

/**
 * The shared default inbox token that MUST NOT appear in any NATS grant.
 * Exported so the generator, the ACL smoke harness and the CI invariants all
 * ban the same literal instead of re-typing it.
 */
export const SHARED_INBOX_SUBJECT_TOKEN = '_INBOX';

/** The exact grant that made every reply platform-readable. Banned everywhere. */
export const SHARED_INBOX_GRANT = '_INBOX.>';

/**
 * Identity shape accepted as an inbox-prefix source. Matches the `name`
 * pattern in `infrastructure/nats/services.schema.json` (a certificate CN)
 * widened only to permit the dev/CI client identities that never reach a
 * broker with per-CN ACLs. Dots are excluded because a dot would split the
 * prefix into two NATS tokens and silently re-open the shared namespace.
 */
const INBOX_IDENTITY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Build the reply-inbox prefix for a NATS identity.
 *
 * @param identity mTLS certificate CN (production) or the dev/CI client
 *   identity that stands in for it. Never empty, never dotted.
 * @throws when the identity cannot form a single safe NATS token — a silent
 *   fallback here would reintroduce the shared `_INBOX` namespace, which is
 *   the exact defect this module exists to make impossible.
 */
export function serviceInboxPrefix(identity: string): string {
  if (!INBOX_IDENTITY_PATTERN.test(identity)) {
    throw new Error(
      `[nats-inbox] cannot derive a reply-inbox prefix from identity "${identity}": ` +
        'a NATS identity must be a single token matching ' +
        `${INBOX_IDENTITY_PATTERN.source} (no dots, no wildcards, non-empty). ` +
        'The inbox prefix is the per-service confidentiality boundary for ' +
        'request-reply payloads (ORPHAN-CRITICAL-402) — it is never defaulted.',
    );
  }
  return `${PLATFORM_INBOX_PREFIX_ROOT}${identity}`;
}

/**
 * Build the NATS subscribe grant that covers every reply subject minted from
 * {@link serviceInboxPrefix} for the same identity. This is the exact string
 * that must appear in that service's `subscribe` allow-list — and, for every
 * OTHER identity, must not.
 */
export function serviceInboxGrant(identity: string): string {
  return `${serviceInboxPrefix(identity)}.>`;
}

/**
 * True when a grant addresses ANY per-identity reply inbox. Used by the ACL
 * gates to reject a service that lists an inbox grant that is not its own.
 */
export function isServiceInboxGrant(subject: string): boolean {
  return subject.startsWith(PLATFORM_INBOX_PREFIX_ROOT);
}

/**
 * True when a grant addresses the shared, pre-cure `_INBOX` namespace — i.e.
 * the exact confidentiality hole ORPHAN-CRITICAL-402 closed.
 */
export function isSharedInboxGrant(subject: string): boolean {
  return (
    subject === SHARED_INBOX_SUBJECT_TOKEN || subject.startsWith(`${SHARED_INBOX_SUBJECT_TOKEN}.`)
  );
}
