import { ValueTransformer } from 'typeorm';

/**
 * Transformer for decimal/numeric columns to ensure proper number type conversion.
 *
 * PostgreSQL returns decimal/numeric column values as JavaScript strings.
 * Without this transformer, arithmetic like `"1.5" + "2.0"` produces `"1.52.0"`
 * instead of `3.5`.
 *
 * Usage:
 * ```typescript
 * @Column({ type: 'decimal', precision: 15, scale: 2, transformer: new DecimalTransformer() })
 * totalCost: number;
 * ```
 */
export class DecimalTransformer implements ValueTransformer {
  /**
   * Called when writing to the database.
   *
   * `undefined` and `null` are NOT the same thing here, and collapsing them was
   * a platform-wide insert bug. `undefined` means "the caller did not provide
   * this column"; returning `undefined` leaves it out of the INSERT so the
   * column's DEFAULT applies. Returning `null` instead makes TypeORM write an
   * explicit NULL, which a `NOT NULL DEFAULT 0` column rejects —
   *
   *     null value in column "used_capacity" of relation "storage_locations"
   *     violates not-null constraint
   *
   * — even though both the entity (`default: 0`) and the migration
   * (`numeric(15,2) NOT NULL DEFAULT '0'`) are correct. 44 column declarations
   * across 79 entities pair this transformer with a `default:`, and every one
   * of them was unusable without naming the column explicitly. Found by
   * `feeding-record-tenant-isolation.postgres.spec.ts` the first time CI ran
   * the farm integration lane (INFRA-MEDIUM-142).
   *
   * `null` still passes through as `null`: an explicit null is a deliberate
   * value for a nullable column, and clearing one must stay possible.
   */
  to(value: number | null | undefined): number | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }
    return value;
  }

  /**
   * Called when reading from the database.
   * Converts the PostgreSQL string representation back to a JavaScript number.
   */
  from(value: string | number | null | undefined): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return value;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }
}

/**
 * Map a nullable numeric column onto an optional response field, PRESERVING zero.
 *
 * `DecimalTransformer.from` already says "absent" with `null`, so a read has two
 * distinct values to carry forward: `null` (nobody measured this) and `0` (someone
 * measured zero). A truthiness guard — `value ? Number(value) : undefined` — collapses
 * them, and always in the direction that reads as "no data":
 *
 *   - a batch's `sgr` of 0 is a batch that did not grow, reported as unmeasured;
 *   - a tank's `freeboard` of 0 is a tank filled to the rim, reported as unknown;
 *   - a feeding record's `feedCost` of 0 is feed that cost nothing, dropped from the total;
 *   - a storage location's `capacity` of 0 is a decommissioned location, shown as unbounded.
 *
 * Every column this applies to is `nullable: true`, so the schema already has a
 * representation for "unset" and zero is never a sentinel for it. Enforced by
 * `tests/invariants/nullable-numeric-zero-preserved.spec.ts`.
 */
export function numberOrUndefined(value: number | string | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
