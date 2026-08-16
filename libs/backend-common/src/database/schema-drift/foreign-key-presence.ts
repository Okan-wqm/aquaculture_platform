/**
 * Shared Class-K decision kernel.
 *
 * Production boot validation and the migration harness intentionally use the
 * same cardinality contract. Keeping the decision pure and shared prevents a
 * migration from passing the harness while the runtime validator rejects the
 * same foreign-key surface (or the reverse).
 */
export interface ForeignKeyPresenceDrift {
  readonly direction: 'missing_in_database' | 'orphaned_in_database';
  readonly entityCount: number;
  readonly databaseCount: number;
  readonly delta: number;
}

export function compareForeignKeyPresence(
  entityCount: number,
  databaseCount: number,
): ForeignKeyPresenceDrift | null {
  if (!Number.isSafeInteger(entityCount) || entityCount < 0) {
    throw new Error(`Invalid entity foreign-key count: ${entityCount}`);
  }
  if (!Number.isSafeInteger(databaseCount) || databaseCount < 0) {
    throw new Error(`Invalid database foreign-key count: ${databaseCount}`);
  }
  if (entityCount === databaseCount) return null;
  return Object.freeze({
    direction:
      entityCount > databaseCount ? 'missing_in_database' : 'orphaned_in_database',
    entityCount,
    databaseCount,
    delta: Math.abs(entityCount - databaseCount),
  });
}
