/**
 * Whether a sensor channel can feed a water-chemistry parameter — the one rule
 * the bind command, its dry run and every read of a bound source apply, and
 * the vocabulary of reasons the UI shows when it cannot.
 *
 * A parameter records a measured quantity in its own unit; a channel reports a
 * quantity in its unit. They fit when they name EXACTLY the same quantity (no
 * derivation: TAN and NH3-N are different quantities, and deriving one from
 * the other needs pH and temperature — a reading-time calculation, not a
 * binding) and both units convert to that quantity's canonical unit, so a
 * value can be carried from one to the other. The channel must also exist, be
 * enabled and belong to an active sensor.
 *
 * Where the sensor stands is the binding owner's question (its measurement
 * points are farm topology): `NOT_AT_POINT` is part of this vocabulary so the
 * UI has one list, and the farm service decides it.
 *
 * Zero dependencies beyond the registry; a structural channel type so this
 * library does not import the event contracts the description travels in.
 */
import { parseQuantityId, unitConversion, type QuantityId } from './quantities';

/**
 * Every reason a channel cannot feed a parameter, in the order they are
 * reported. Append-only: the UI keys its messages on these strings. An object
 * so the farm GraphQL enum is this table itself.
 */
export const CHANNEL_BINDING_PROBLEM = {
  /** The parameter records no measured quantity (a family with no declared member, or a code no channel measures). */
  PARAMETER_HAS_NO_QUANTITY: 'PARAMETER_HAS_NO_QUANTITY',
  /** The parameter's unit is not a unit of its quantity, so no value can be converted into it. */
  PARAMETER_UNIT_NOT_CONVERTIBLE: 'PARAMETER_UNIT_NOT_CONVERTIBLE',
  /** No sensor has this id in the tenant. */
  NO_SENSOR: 'NO_SENSOR',
  /** The sensor has no channel with this key. */
  NO_CHANNEL: 'NO_CHANNEL',
  /** The sensor is deactivated. */
  SENSOR_INACTIVE: 'SENSOR_INACTIVE',
  /** The channel is disabled. */
  CHANNEL_DISABLED: 'CHANNEL_DISABLED',
  /** The channel's key names a family or nothing, and no quantity was declared for it. */
  CHANNEL_HAS_NO_QUANTITY: 'CHANNEL_HAS_NO_QUANTITY',
  /** The channel measures another quantity than the parameter records. */
  QUANTITY_MISMATCH: 'QUANTITY_MISMATCH',
  /** The channel declares no unit, so its values cannot be converted. */
  CHANNEL_HAS_NO_UNIT: 'CHANNEL_HAS_NO_UNIT',
  /** The channel's unit is not a unit of its quantity. */
  CHANNEL_UNIT_NOT_CONVERTIBLE: 'CHANNEL_UNIT_NOT_CONVERTIBLE',
  /** The channel's sensor does not stand at the measurement point (farm topology decides). */
  NOT_AT_POINT: 'NOT_AT_POINT',
} as const;

export type ChannelBindingProblem =
  (typeof CHANNEL_BINDING_PROBLEM)[keyof typeof CHANNEL_BINDING_PROBLEM];

/** The problem codes in report order. */
export const CHANNEL_BINDING_PROBLEMS: readonly ChannelBindingProblem[] =
  Object.values(CHANNEL_BINDING_PROBLEM);

/** What a parameter records: its effective quantity (null when it records none) and its unit. */
export interface BindableParameter {
  readonly quantity: QuantityId | null;
  readonly unit: string;
}

/** The facts of a described channel this rule reads (a structural subset of the sensor description). */
export interface DescribedChannel {
  readonly presence: 'FOUND' | 'NO_SENSOR' | 'NO_CHANNEL';
  readonly sensorActive: boolean | null;
  readonly enabled: boolean | null;
  /** The channel's effective quantity id, as the sensor service reports it. */
  readonly quantity: string | null;
  readonly unit: string | null;
}

/** Why a parameter cannot take any channel source, in report order; empty when it can. */
export function parameterProblems(parameter: BindableParameter): ChannelBindingProblem[] {
  if (parameter.quantity === null) {
    return ['PARAMETER_HAS_NO_QUANTITY'];
  }
  return unitConversion(parameter.quantity, parameter.unit) === null
    ? ['PARAMETER_UNIT_NOT_CONVERTIBLE']
    : [];
}

/**
 * Why this channel cannot feed this parameter, in report order; empty when it
 * can (placement aside — see NOT_AT_POINT). A missing sensor or channel stops
 * the list: nothing past presence is known about it.
 */
export function channelProblems(
  parameter: BindableParameter,
  channel: DescribedChannel,
): ChannelBindingProblem[] {
  const problems = parameterProblems(parameter);
  if (channel.presence === 'NO_SENSOR') {
    return [...problems, 'NO_SENSOR'];
  }
  if (channel.sensorActive === false) {
    problems.push('SENSOR_INACTIVE');
  }
  if (channel.presence === 'NO_CHANNEL') {
    return [...problems, 'NO_CHANNEL'];
  }
  if (channel.enabled === false) {
    problems.push('CHANNEL_DISABLED');
  }
  const quantity = parseQuantityId(channel.quantity);
  if (quantity === null) {
    problems.push('CHANNEL_HAS_NO_QUANTITY');
  } else if (parameter.quantity !== null && quantity !== parameter.quantity) {
    problems.push('QUANTITY_MISMATCH');
  }
  if (channel.unit === null) {
    problems.push('CHANNEL_HAS_NO_UNIT');
  } else if (quantity !== null && unitConversion(quantity, channel.unit) === null) {
    problems.push('CHANNEL_UNIT_NOT_CONVERTIBLE');
  }
  return problems;
}

/**
 * The stable codes (GraphQL `extensions.code`) of the parameter-source API's
 * refusals beyond the channel problems, so the binding UI branches on what
 * happened instead of parsing messages. Append-only.
 */
export const PARAMETER_SOURCE_ERROR = {
  /** The channel cannot feed the parameter here; `context.problems` says why. */
  CHANNEL_BINDING_REFUSED: 'CHANNEL_BINDING_REFUSED',
  /** A source rule is taken: the priority, the manual line, the channel, or the quantity. */
  SOURCE_CONFLICT: 'SOURCE_CONFLICT',
  /** A backup was asked for where there is no primary. */
  BACKUP_NEEDS_PRIMARY: 'BACKUP_NEEDS_PRIMARY',
  /** The parameter's code, unit or quantity changed (or it was deactivated) meanwhile. */
  PARAMETER_CHANGED: 'PARAMETER_CHANGED',
  /** The measurement point was removed or deactivated meanwhile. */
  POINT_RETIRED: 'POINT_RETIRED',
  /** The source being replaced was unbound meanwhile. */
  SOURCE_UNBOUND: 'SOURCE_UNBOUND',
  /** A sensor channel is bound: the parameter's code, unit, quantity and activity are fixed. */
  PARAMETER_BOUND: 'PARAMETER_BOUND',
  /** Measurements recorded the parameter: its code and unit are fixed. */
  PARAMETER_HAS_MEASUREMENTS: 'PARAMETER_HAS_MEASUREMENTS',
  /** Concurrent writes kept colliding (deadlock or serialization failure); retry. */
  CONCURRENT_WRITE: 'CONCURRENT_WRITE',
  /** The sensor service could not describe the channel; nothing was decided. */
  SENSOR_DIRECTORY_UNAVAILABLE: 'SENSOR_DIRECTORY_UNAVAILABLE',
} as const;

export type ParameterSourceErrorCode =
  (typeof PARAMETER_SOURCE_ERROR)[keyof typeof PARAMETER_SOURCE_ERROR];
