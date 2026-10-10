import { ValueTransformer } from 'typeorm';

/**
 * Transformer for PostgreSQL `date` columns exposed as GraphQL `DateTime`.
 *
 * PostgreSQL returns `date` columns as plain strings (`"2026-10-10"`). The
 * apollo GraphQL `DateTime` scalar refuses to serialize anything that is not a
 * `Date` instance, so an entity column declared as
 *
 * ```typescript
 * @Field()
 * @Column({ type: 'date' })
 * feedingDate!: Date;
 * ```
 *
 * hydrates as a string and every list query selecting it dies with
 * `Expected DateTime.serialize("2026-10-10") to return non-nullable value,
 * returned: null` (INTERNAL_SERVER_ERROR, `data: null`) — while create/update
 * keep working because their payloads carry in-memory `Date` objects. That
 * asymmetry hid the break until an end-to-end read exercise (FARM-CRITICAL-406).
 *
 * Usage:
 * ```typescript
 * @Column({ type: 'date', transformer: new DateColumnTransformer() })
 * feedingDate!: Date;
 * ```
 *
 * The write side is pass-through: TypeORM already serializes both `Date`
 * instances and `YYYY-MM-DD` strings correctly into a `date` column.
 * Enforced platform-wide by `tests/invariants/date-column-transformer.spec.ts`.
 */
export class DateColumnTransformer implements ValueTransformer {
  to(value: Date | string | null | undefined): Date | string | null | undefined {
    return value;
  }

  from(value: string | Date | null | undefined): Date | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (value instanceof Date) {
      return value;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}

/** Stateless shared instance — `new DateColumnTransformer()` is equivalent. */
export const dateColumnTransformer = new DateColumnTransformer();
