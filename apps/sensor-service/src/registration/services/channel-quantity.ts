import {
  channelKeyMeaning,
  effectiveQuantity,
  measuredQuantity,
  parseQuantityId,
  type QuantityFamily,
  type QuantityId,
  unitConversion,
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

/** What a channel with this key and declaration measures. */
export function channelQuantity(
  channelKey: string,
  declaredQuantity: QuantityId | null | undefined,
): ChannelQuantityView {
  return {
    quantity: effectiveQuantity(channelKey, declaredQuantity),
    family: channelKeyMeaning(channelKey)?.family ?? null,
  };
}

/**
 * The unit a declared channel reads in: the unit given with the declaration,
 * else the channel's own, else the quantity's canonical unit — a declared
 * channel never has no unit.
 */
export function declaredUnit(
  quantity: QuantityId,
  requested: string | undefined,
  current: string | null | undefined,
): string {
  return requested ?? current ?? measuredQuantity(quantity).unit;
}

/**
 * Why a declaration cannot stand on this channel, or null when it can:
 * the id is unknown, is not one the key allows, or the channel's unit is
 * neither a spelling of the quantity's unit nor one it converts from (a µg/L
 * H2S declared on an unconvertible unit would feed the chemistry a value off
 * by an unknown factor).
 */
export function declarationConflict(
  channelKey: string,
  declared: string,
  unit: string,
): string | null {
  const quantity = parseQuantityId(declared);
  if (quantity === null) {
    return `'${declared}' is not a measured quantity`;
  }
  if (effectiveQuantity(channelKey, quantity) === null) {
    return `Channel key '${channelKey}' cannot be declared as ${quantity}`;
  }
  if (unitConversion(quantity, unit) === null) {
    return `Unit '${unit}' is not a unit of ${quantity} (${measuredQuantity(quantity).unit})`;
  }
  return null;
}
