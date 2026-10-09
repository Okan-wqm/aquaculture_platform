/**
 * How a measured quantity is named in the water-chemistry views: its id, what
 * it is measured as and its canonical unit, from the one registry
 * (shared-contracts MEASURED_QUANTITIES) — so "tan" reads as total ammonia as
 * N in mg/L wherever a channel or a parameter is picked.
 */
import { measuredQuantity, parseQuantityId } from '@aquaculture/shared-contracts';

/** e.g. `tan — total ammonia as N, mg/L`; an id the registry does not know is shown as it is. */
export function quantityLabel(id: string): string {
  const known = parseQuantityId(id);
  if (known === null) return id;
  const quantity = measuredQuantity(known);
  const detail: string[] = quantity.basis === null ? [] : [quantity.basis];
  detail.push(quantity.unit);
  return `${known} — ${detail.join(', ')}`;
}
