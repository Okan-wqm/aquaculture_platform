import { ValueTransformer } from 'typeorm';

/**
 * Transformer for bigint columns.
 * PostgreSQL returns bigint values as strings; this transformer
 * converts them to JavaScript numbers only while they fit inside the
 * JavaScript safe-integer range. Larger values fail fast instead of silently
 * losing ledger precision.
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
      if (!Number.isSafeInteger(value)) {
        throw new Error(`Unsafe bigint value cannot be represented as number: ${value}`);
      }
      return value;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`Unsafe bigint value cannot be represented as number: ${value}`);
    }
    return parsed;
  }
}

/**
 * Transformer for public ledger positions.
 *
 * Event-store global/stream positions are PostgreSQL bigint values that can
 * exceed Number.MAX_SAFE_INTEGER. Keep them as decimal strings in TypeScript
 * so public DTOs never expose precision-losing JavaScript numbers.
 */
export class BigIntStringTransformer implements ValueTransformer {
  to(value: string | number | bigint | undefined | null): string | undefined | null {
    if (value === undefined || value === null) {
      return value;
    }
    return value.toString();
  }

  from(value: string | number | bigint | undefined | null): string {
    if (value === undefined || value === null) {
      return '0';
    }
    return value.toString();
  }
}
