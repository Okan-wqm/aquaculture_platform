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
   * Passes the number through unchanged.
   */
  to(value: number | null | undefined): number | null {
    if (value === null || value === undefined) {
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
