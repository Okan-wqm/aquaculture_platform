/** Canonical, provenance-bearing instant capability for durable mutations. */

const MUTATION_INSTANT_BRAND: unique symbol = Symbol();
const MINTED_MUTATION_INSTANTS = new WeakSet<object>();

export type MutationInstantSourceV1 =
  | 'database_transaction'
  | 'persisted_feeding_operation'
  | 'test_authority';

export interface MutationInstantV1 {
  readonly [MUTATION_INSTANT_BRAND]: true;
  readonly schemaVersion: 'mutation-instant/v1';
  readonly source: MutationInstantSourceV1;
  readonly observedAt: string;
}

export const TENANT_MUTATION_INSTANT_SQL_V1 = `SELECT to_char(
  transaction_timestamp() AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
) AS "mutationInstant"`;

export interface MutationInstantQueryExecutorV1 {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

function canonicalInstant(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Mutation instant must be a canonical UTC ISO-8601 string');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError('Mutation instant must be a canonical UTC ISO-8601 string');
  }
  return value;
}

/**
 * Internal mint authority. Production imports are exact-set governed; public
 * consumers receive only opaque capabilities from a transaction/session.
 */
export function mintMutationInstantV1(
  source: MutationInstantSourceV1,
  observedAt: unknown,
): MutationInstantV1 {
  const instant = Object.freeze({
    [MUTATION_INSTANT_BRAND]: true as const,
    schemaVersion: 'mutation-instant/v1' as const,
    source,
    observedAt: canonicalInstant(observedAt),
  });
  MINTED_MUTATION_INSTANTS.add(instant);
  return instant;
}

function verifyMutationInstantV1(instant: MutationInstantV1): MutationInstantV1 {
  if (!MINTED_MUTATION_INSTANTS.has(instant)) {
    throw new TypeError('Unminted mutation instant rejected');
  }
  return instant;
}

export function mutationInstantIsoV1(instant: MutationInstantV1): string {
  return verifyMutationInstantV1(instant).observedAt;
}

/** Returns a fresh projection so aggregate code cannot mutate the capability. */
export function mutationInstantDateV1(instant: MutationInstantV1): Date {
  return new Date(mutationInstantIsoV1(instant));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads the stable PostgreSQL transaction clock; no process-clock fallback exists. */
export async function readDatabaseMutationInstantV1(
  executor: MutationInstantQueryExecutorV1,
): Promise<MutationInstantV1> {
  const result: unknown = await executor.query(TENANT_MUTATION_INSTANT_SQL_V1);
  const row = Array.isArray(result) ? result[0] : undefined;
  if (!isRecord(row) || Object.keys(row).some((key) => key !== 'mutationInstant')) {
    throw new TypeError('Database transaction did not return its canonical mutation instant');
  }
  return mintMutationInstantV1('database_transaction', row['mutationInstant']);
}
