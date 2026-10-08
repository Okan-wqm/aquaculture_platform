import { parseQuantityId, type QuantityId } from '@aquaculture/shared-contracts';
import type { ValueTransformer } from 'typeorm';

/**
 * A measured-quantity id column (`declaredQuantity`, `effectiveQuantity`):
 * a stored id the registry no longer knows reads as null — "records no known
 * quantity" — never as an unchecked string. Writes pass through, so an
 * unprovided value stays the column's DEFAULT and an explicit null clears it.
 */
export const QuantityIdTransformer: ValueTransformer = {
  to: (value: QuantityId | null | undefined): QuantityId | null | undefined => value,
  from: (value: unknown): QuantityId | null => parseQuantityId(value),
};
