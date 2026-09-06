import Decimal from 'decimal.js';
import { Column, ColumnOptions } from 'typeorm';

/**
 * TypeORM value transformer that converts between Decimal.js and
 * PostgreSQL's native NUMERIC type (which TypeORM surfaces as string).
 *
 * WHY: The existing DecimalTransformer uses parseFloat(), which
 * silently loses precision on values like 0.1 + 0.2. This transformer
 * preserves full precision through the entire read/write cycle.
 *
 * Write path: Decimal → string (PostgreSQL NUMERIC accepts string input)
 * Read  path: string → Decimal (lossless conversion)
 */
export class DecimalValueTransformer {
  /**
   * Called when writing to the database.
   * Converts Decimal to its string representation for PostgreSQL.
   *
   * @param value - Decimal value from the application
   * @returns String for PostgreSQL or null
   */
  to(value: Decimal | null | undefined): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return value.toString();
  }

  /**
   * Called when reading from the database.
   * Converts PostgreSQL numeric string to Decimal.js instance.
   *
   * @param value - String value from PostgreSQL
   * @returns Decimal.js instance or null
   */
  from(value: string | null | undefined): Decimal | null {
    if (value === null || value === undefined) {
      return null;
    }
    return new Decimal(value);
  }
}

/**
 * Column options for @MoneyColumn() — exposed for testing and composition.
 */
export interface MoneyColumnOptions {
  /** Column name override */
  name?: string;
  /** Whether the column allows NULL (default: false) */
  nullable?: boolean;
  /** Numeric precision — total digits (default: 19) */
  precision?: number;
  /** Numeric scale — decimal places (default: 4) */
  scale?: number;
  /** Default value expression */
  default?: number | string;
  /** Column comment */
  comment?: string;
}

// SECURITY: Singleton transformer instance — stateless, safe to share.
const DECIMAL_TRANSFORMER = new DecimalValueTransformer();

/**
 * TypeORM column decorator for monetary / precise-decimal values.
 *
 * Sets the column to PostgreSQL `numeric(19,4)` with a transformer
 * that converts between Decimal.js and the DB string representation.
 *
 * Replaces the broken pattern of `@Column({ type: 'decimal', transformer: new DecimalTransformer() })`
 * which uses `parseFloat()` and loses precision.
 *
 * @param options - Optional column configuration overrides
 *
 * @example
 * ```typescript
 * @Entity()
 * class Invoice {
 *   @MoneyColumn()
 *   totalAmount!: Decimal;
 *
 *   @MoneyColumn({ nullable: true, comment: 'Tax amount before rounding' })
 *   taxAmount!: Decimal | null;
 * }
 * ```
 */
export function MoneyColumn(options?: MoneyColumnOptions): PropertyDecorator {
  const columnOptions: ColumnOptions = {
    type: 'numeric',
    precision: options?.precision ?? 19,
    scale: options?.scale ?? 4,
    nullable: options?.nullable ?? false,
    transformer: DECIMAL_TRANSFORMER,
  };

  if (options?.name) {
    columnOptions.name = options.name;
  }
  if (options?.default !== undefined) {
    columnOptions.default = options.default;
  }
  if (options?.comment) {
    columnOptions.comment = options.comment;
  }

  return Column(columnOptions);
}

/**
 * Column options for `@PercentColumn()`.
 */
export interface PercentColumnOptions {
  name?: string;
  nullable?: boolean;
  default?: number | string;
  comment?: string;
}

/**
 * TypeORM column decorator for a percentage in [0, 100].
 *
 * `numeric(5,2)` with the same lossless Decimal transformer money uses — a
 * percentage multiplies money, so a float here reaches the invoice as surely
 * as a float in the price would. Three byte-identical private copies of this
 * transformer had grown inside billing's entities (plan cycle prices, custom
 * plans, discount codes); the CHECK that bounds the value to [0, 100] belongs
 * with the table, but the representation belongs here.
 *
 * @example
 * ```typescript
 * @PercentColumn({ name: 'commitment_discount_percent', default: 0 })
 * commitmentDiscountPercent!: Decimal;
 * ```
 */
export function PercentColumn(options?: PercentColumnOptions): PropertyDecorator {
  const columnOptions: ColumnOptions = {
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: options?.nullable ?? false,
    transformer: DECIMAL_TRANSFORMER,
  };

  if (options?.name) {
    columnOptions.name = options.name;
  }
  if (options?.default !== undefined) {
    columnOptions.default = options.default;
  }
  if (options?.comment) {
    columnOptions.comment = options.comment;
  }

  return Column(columnOptions);
}
