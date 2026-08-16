import type { EntityManager } from 'typeorm';

import { mutationInstantIsoV1, type MutationInstantV1 } from './mutation-instant';

const TENANT_MUTATION_SESSION_BRAND: unique symbol = Symbol();

/** Opaque, transaction-scoped write capability. It contains no ORM surface. */
export interface TenantMutationSession {
  readonly [TENANT_MUTATION_SESSION_BRAND]: true;
}

interface VerifiedTenantMutationSession {
  readonly manager: EntityManager;
  readonly sourceSchema: string;
  readonly tenantId: string;
}

const VERIFIED_SESSIONS = new WeakMap<object, VerifiedTenantMutationSession>();
const MUTATION_INSTANT_READERS = new WeakMap<object, () => Promise<MutationInstantV1>>();
const MUTATION_INSTANTS = new WeakMap<object, Promise<MutationInstantV1>>();

/** Internal mint authority: only the tenant transaction boundary may import it. */
export function mintTenantMutationSession(
  manager: EntityManager,
  sourceSchema: string,
  tenantId: string,
  readMutationInstant: () => Promise<MutationInstantV1>,
): TenantMutationSession {
  const session = Object.freeze({}) as TenantMutationSession;
  VERIFIED_SESSIONS.set(session, Object.freeze({ manager, sourceSchema, tenantId }));
  MUTATION_INSTANT_READERS.set(session, readMutationInstant);
  return session;
}

/** Internal adapter authority: only concrete durable mutation adapters may import it. */
export function readTenantMutationSession(
  session: TenantMutationSession,
  expectedSourceSchema: string,
): VerifiedTenantMutationSession {
  const verified = VERIFIED_SESSIONS.get(session);
  if (!verified) throw new Error('Unminted tenant mutation session rejected');
  if (verified.sourceSchema !== expectedSourceSchema) {
    throw new Error(
      `Tenant mutation session schema mismatch: expected ${expectedSourceSchema}, received ${verified.sourceSchema}`,
    );
  }
  return verified;
}

/** Stable, lazily-read PostgreSQL transaction timestamp for non-operation mutations. */
export function readTenantMutationInstantV1(
  session: TenantMutationSession,
  expectedSourceSchema: string,
): Promise<MutationInstantV1> {
  readTenantMutationSession(session, expectedSourceSchema);
  const existing = MUTATION_INSTANTS.get(session);
  if (existing) return existing;
  const reader = MUTATION_INSTANT_READERS.get(session);
  if (!reader) throw new Error('Tenant mutation session has no transaction-clock authority');
  const instant = reader();
  MUTATION_INSTANTS.set(session, instant);
  return instant;
}

/**
 * Pins a previously persisted operation instant before the first durable write.
 *
 * A retryable operation must not acquire a fresh transaction timestamp on each
 * attempt: doing so would make aggregate bytes depend on retry timing. The
 * operation coordinator therefore binds the immutable intent-envelope instant
 * to the opaque tenant session before dispatch. Non-operation transactions do
 * not call this authority and continue to lazily read PostgreSQL's stable
 * `transaction_timestamp()` through {@link readTenantMutationInstantV1}.
 *
 * Pinning after any clock read is rejected even when the ISO value happens to
 * match. That makes clock ownership structural and prevents two authorities
 * from racing to explain the same mutation.
 */
export function pinTenantMutationInstantV1(
  session: TenantMutationSession,
  expectedSourceSchema: string,
  instant: MutationInstantV1,
): void {
  readTenantMutationSession(session, expectedSourceSchema);
  mutationInstantIsoV1(instant);
  if (MUTATION_INSTANTS.has(session)) {
    throw new Error('Tenant mutation session clock was already resolved');
  }
  MUTATION_INSTANTS.set(session, Promise.resolve(instant));
}
