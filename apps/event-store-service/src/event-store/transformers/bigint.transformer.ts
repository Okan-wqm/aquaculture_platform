import { ValueTransformer } from 'typeorm';

/**
 * Transformer for bigint columns.
 * PostgreSQL returns bigint values as strings; this transformer
 * converts them to JavaScript numbers on read and passes numbers
 * through on write. Values above Number.MAX_SAFE_INTEGER will
 * lose precision — acceptable for the current scale assumptions.
 */
export class BigIntTransformer implements ValueTransformer {
  to(value: number | undefined | null): number | undefined | null {
    return value;
  }

  from(value: string | number | undefined | null): number {
    if (value === undefined || value === null) {
      return 0;
    }
    if (typeof value === 'number') {
      return value;
    }
    return parseInt(value, 10);
  }
}
