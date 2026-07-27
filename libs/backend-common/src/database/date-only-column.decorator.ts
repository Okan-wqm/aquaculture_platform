import { Column, ColumnOptions, ValueTransformer } from 'typeorm';

/**
 * A calendar date ('YYYY-MM-DD'), branded so it cannot be confused with an
 * arbitrary string or silently used as a `Date`.
 *
 * WHY THIS EXISTS: PostgreSQL `date` columns hydrate as 'YYYY-MM-DD' STRINGS,
 * not Date objects — `PostgresDriver.prepareHydratedValue` normalizes them via
 * `DateUtils.mixedDateToDateString()` before any transformer runs. An entity
 * that annotates such a property as `Date` is therefore an unchecked lie: the
 * compiler happily accepts `.toISOString()` / `.getFullYear()` and the call
 * throws a TypeError at runtime the moment a row exists (APA-130).
 *
 * Modelling the column as a branded string matches driver reality, removes the
 * timezone ambiguity a `Date` carries for a calendar date, and turns every
 * Date-method call into a COMPILE error instead of a production crash.
 *
 * This is the exact analogue of `MoneyColumn`/`DecimalValueTransformer`, which
 * solved the same DB-scalar-vs-TS-scalar mismatch for NUMERIC.
 */
export type IsoDateString = string & { readonly __isoDate: unique symbol };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Narrow a Date or a 'YYYY-MM-DD' string to `IsoDateString`.
 *
 * Throws on anything else — a malformed calendar date must fail loudly at the
 * boundary rather than reach the database or a comparison. Callers holding a
 * nullable value must branch on null themselves; funnelling `null` in here
 * would turn "clear this date" into a 500.
 */
export function toIsoDateString(value: Date | string): IsoDateString {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('toIsoDateString: received an invalid Date');
    }
    return value.toISOString().slice(0, 10) as IsoDateString;
  }
  if (!ISO_DATE_RE.test(value)) {
    throw new Error(`toIsoDateString: expected 'YYYY-MM-DD', received '${value}'`);
  }
  return value as IsoDateString;
}

/** Null-tolerant companion for nullable `date` columns. */
export function toIsoDateStringOrNull(
  value: Date | string | null | undefined,
): IsoDateString | null {
  return value === null || value === undefined ? null : toIsoDateString(value);
}

class DateOnlyTransformer implements ValueTransformer {
  to(value: IsoDateString | Date | null | undefined): string | null {
    return toIsoDateStringOrNull(value);
  }

  from(value: string | Date | null | undefined): IsoDateString | null {
    return toIsoDateStringOrNull(value);
  }
}

const DATE_ONLY_TRANSFORMER = new DateOnlyTransformer();

export interface DateOnlyColumnOptions {
  name?: string;
  nullable?: boolean;
  primary?: boolean;
  comment?: string;
}

/**
 * `@Column({ type: 'date' })` with the calendar-date contract enforced.
 *
 * Declares the property as `IsoDateString` (see the type docs). Emits the same
 * DDL as a plain `date` column — a transformer is TS-side only — so adding it
 * to an existing entity needs NO migration and does not move the schema-drift
 * baseline.
 */
export function DateOnlyColumn(options?: DateOnlyColumnOptions): PropertyDecorator {
  const columnOptions: ColumnOptions = {
    type: 'date',
    transformer: DATE_ONLY_TRANSFORMER,
    nullable: options?.nullable ?? false,
  };
  if (options?.name) columnOptions.name = options.name;
  if (options?.primary !== undefined) columnOptions.primary = options.primary;
  if (options?.comment) columnOptions.comment = options.comment;
  return Column(columnOptions);
}
