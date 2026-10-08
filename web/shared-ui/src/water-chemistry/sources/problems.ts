/**
 * Why a water-chemistry input has no usable source — every code the binding
 * and reading API can answer with — what fixes each, and the words for it.
 *
 * The codes are the backend's own vocabularies, registered as GraphQL enums
 * (the generated types below): the channel-binding rule (shared-contracts
 * CHANNEL_BINDING_PROBLEM), the reading resolver (ReadingProblem,
 * ReadingUnresolved) and the input-set verdict (WaterChemistryInputProblem,
 * WaterChemistrySetProblem). Refusals of a write carry a stable
 * `extensions.code` from shared-contracts PARAMETER_SOURCE_ERROR.
 *
 * PROBLEM_FIX is a Record over every code, so a code added to the API without
 * an owner here fails the build; the message keys are template literals over
 * the same union, so a code without en/tr text fails it too.
 */
import {
  CHANNEL_BINDING_PROBLEMS,
  PARAMETER_SOURCE_ERROR,
  type ChannelBindingProblem,
  type ParameterSourceErrorCode,
} from '@aquaculture/shared-contracts';

import type {
  ReadingProblem,
  ReadingUnresolved,
  WaterChemistryInputProblem,
  WaterChemistrySetProblem,
} from '../../generated/graphql-types';
import type { I18nContextValue } from '../../i18n/I18nProvider';

export type SourceProblemCode =
  | ChannelBindingProblem
  | ReadingProblem
  | ReadingUnresolved
  | WaterChemistryInputProblem
  | WaterChemistrySetProblem;

/**
 * Where a problem is fixed: the parameter's configuration (farm Parameters),
 * the sensor channel's meaning or state (sensor channel manager), the sensor
 * itself (device page), the source binding at the point (farm Sources), or
 * the system's setup (type, volume).
 */
export type ProblemFix = 'parameter' | 'channel' | 'sensor' | 'source' | 'system';

export const PROBLEM_FIX: Readonly<Record<SourceProblemCode, ProblemFix>> = {
  // The channel-binding rule (shared-contracts), in report order.
  PARAMETER_HAS_NO_QUANTITY: 'parameter',
  PARAMETER_UNIT_NOT_CONVERTIBLE: 'parameter',
  NO_SENSOR: 'source',
  NO_CHANNEL: 'source',
  SENSOR_INACTIVE: 'sensor',
  CHANNEL_DISABLED: 'channel',
  CHANNEL_HAS_NO_QUANTITY: 'channel',
  QUANTITY_MISMATCH: 'channel',
  CHANNEL_HAS_NO_UNIT: 'channel',
  CHANNEL_UNIT_NOT_CONVERTIBLE: 'channel',
  NOT_AT_POINT: 'sensor',
  // Why a source the bind would accept was passed over for its value.
  NO_SAMPLE: 'sensor',
  SAMPLE_QUALITY_BAD: 'sensor',
  OLDER_THAN_WINDOW: 'source',
  VALUE_NOT_NUMERIC: 'source',
  UNIT_NOT_CONVERTIBLE: 'parameter',
  // Why a parameter has no value at a point.
  NO_SOURCE: 'source',
  NO_USABLE_SOURCE: 'source',
  // Why one input cannot feed a calculation.
  NO_PARAMETER: 'parameter',
  NO_VALUE: 'source',
  NOT_AT_SAME_POINT: 'source',
  NOT_SAME_SAMPLE: 'source',
  // Why a calculation is refused or incomplete at a point.
  SYSTEM_NOT_RECIRCULATING: 'system',
  VOLUME_MISSING: 'system',
  VOLUME_BELOW_TANK_WATER: 'system',
  INPUTS_INCOMPLETE: 'source',
};

function isSourceProblemCode(value: string): value is SourceProblemCode {
  return Object.prototype.hasOwnProperty.call(PROBLEM_FIX, value);
}

/** Every problem code the views can be handed. */
export const SOURCE_PROBLEM_CODES: readonly SourceProblemCode[] =
  Object.keys(PROBLEM_FIX).filter(isSourceProblemCode);

/** Every stable refusal code of the parameter-source API. */
export const PARAMETER_SOURCE_ERROR_CODES: readonly ParameterSourceErrorCode[] =
  Object.values(PARAMETER_SOURCE_ERROR);

type Translate = I18nContextValue['t'];

/** The message for a problem code, in the current language. */
export function problemText(
  t: Translate,
  code: SourceProblemCode,
  vars?: Record<string, string | number>,
): string {
  return t(`wqSource.problem.${code}`, vars);
}

/** The message for a refusal code, in the current language. */
export function errorText(t: Translate, code: ParameterSourceErrorCode): string {
  return t(`wqSource.error.${code}`);
}

/** A write the parameter-source API refused, as the UI branches on it. */
export interface BindingRefusal {
  readonly code: ParameterSourceErrorCode;
  /** For CHANNEL_BINDING_REFUSED: why the channel cannot feed the parameter there. */
  readonly problems: readonly ChannelBindingProblem[];
  /** CONCURRENT_WRITE and SENSOR_DIRECTORY_UNAVAILABLE: nothing was decided, try again. */
  readonly retryable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isErrorCode(value: unknown): value is ParameterSourceErrorCode {
  return (
    typeof value === 'string' && (PARAMETER_SOURCE_ERROR_CODES as readonly string[]).includes(value)
  );
}

function isBindingProblem(value: unknown): value is ChannelBindingProblem {
  return (
    typeof value === 'string' && (CHANNEL_BINDING_PROBLEMS as readonly string[]).includes(value)
  );
}

/**
 * The GraphQL errors an error carries: the shared client's GraphQLClientError
 * keeps them as `graphqlErrors`, graphql-request as `response.errors`.
 */
function graphqlErrorsOf(error: unknown): readonly unknown[] {
  if (!isRecord(error)) return [];
  if (Array.isArray(error.graphqlErrors)) return error.graphqlErrors;
  const response = error.response;
  if (isRecord(response) && Array.isArray(response.errors)) return response.errors;
  return [];
}

/**
 * The parameter-source refusal an error carries, or null when it is not one
 * (a network failure, an authorization error, a validation error).
 */
export function bindingRefusal(error: unknown): BindingRefusal | null {
  for (const entry of graphqlErrorsOf(error)) {
    if (!isRecord(entry) || !isRecord(entry.extensions)) continue;
    const { code, context } = entry.extensions;
    if (!isErrorCode(code)) continue;
    const listed = isRecord(context) && Array.isArray(context.problems) ? context.problems : [];
    return {
      code,
      problems: listed.filter(isBindingProblem),
      retryable:
        code === PARAMETER_SOURCE_ERROR.CONCURRENT_WRITE ||
        code === PARAMETER_SOURCE_ERROR.SENSOR_DIRECTORY_UNAVAILABLE,
    };
  }
  return null;
}
