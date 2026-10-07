import {
  channelKeyMeaning,
  effectiveQuantity,
  isAcceptedUnit,
  measuredQuantity,
  parseQuantityId,
  type QuantityFamily,
  type QuantityId,
} from '@aquaculture/shared-contracts';

/**
 * What a channel measures, read from its key and its operator's declaration
 * through the measured-quantity registry — the one place the sensor service
 * answers "which quantity is this channel".
 */
export interface ChannelQuantityView {
  /** The quantity the channel reports, or null when it is not yet known. */
  quantity: QuantityId | null;
  /** The family the key names when it does not say which member, else null. */
  family: QuantityFamily | null;
}

/** A stored declaration that is not a registry id reads as no declaration. */
export function channelQuantity(
  channelKey: string,
  declaredQuantity: string | null | undefined,
): ChannelQuantityView {
  return {
    quantity: effectiveQuantity(channelKey, parseQuantityId(declaredQuantity)),
    family: channelKeyMeaning(channelKey)?.family ?? null,
  };
}

/**
 * Why a declaration cannot stand on this channel, or null when it can:
 * the id is unknown, contradicts what the key names, or the channel's unit is
 * not a spelling of the quantity's unit (a µg/L H2S declared on a mg/L channel
 * would feed the chemistry a value 1000× off).
 */
export function declarationConflict(
  channelKey: string,
  declared: string,
  unit: string | null | undefined,
): string | null {
  const quantity = parseQuantityId(declared);
  if (quantity === null) {
    return `'${declared}' is not a measured quantity`;
  }
  if (effectiveQuantity(channelKey, quantity) === null) {
    return `Channel key '${channelKey}' does not measure ${quantity}`;
  }
  if (unit && !isAcceptedUnit(quantity, unit)) {
    return `Unit '${unit}' is not a unit of ${quantity} (${measuredQuantity(quantity).unit})`;
  }
  return null;
}
