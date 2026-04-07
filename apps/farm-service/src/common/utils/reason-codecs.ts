import {
  MORTALITY_REASONS,
  CULL_REASONS,
  type MortalityReasonCode,
  type CullReasonCode,
} from '@platform/event-contracts';

/**
 * Reason code converters for the event boundary.
 *
 * Existing GraphQL command DTOs and DB enum columns store mortality and cull
 * reasons in mixed casing (lowercase for the wire format, UPPERCASE for the
 * MortalityCause/CullReason TypeScript enums). The shared event-contracts
 * library defines the canonical UPPERCASE codes (`MortalityReasonCode`,
 * `CullReasonCode`) used in NATS payloads, WebSocket frames, and read models.
 *
 * Handlers call these helpers ONLY when building a domain event so the wire
 * format matches the contract — the DB write path is unchanged. Phase 5 will
 * tighten the upstream (frontend → command DTO → DB) to use UPPERCASE
 * end-to-end and these helpers will become identity functions.
 *
 * @see Phase 3 of farm domain real-time visibility plan.
 */

const MORTALITY_REASON_SET: ReadonlySet<string> = new Set(MORTALITY_REASONS);
const CULL_REASON_SET: ReadonlySet<string> = new Set(CULL_REASONS);

/**
 * Convert an arbitrary input string into a `MortalityReasonCode`.
 * Falls back to `'UNKNOWN'` when the input does not match any known code.
 */
export function toMortalityReasonCode(
  input: string | undefined | null,
): MortalityReasonCode {
  if (!input) return 'UNKNOWN';
  const upper = input.toUpperCase();
  return MORTALITY_REASON_SET.has(upper)
    ? (upper as MortalityReasonCode)
    : 'UNKNOWN';
}

/**
 * Convert an arbitrary input string into a `CullReasonCode`.
 * Falls back to `'OTHER'` when the input does not match any known code.
 */
export function toCullReasonCode(
  input: string | undefined | null,
): CullReasonCode {
  if (!input) return 'OTHER';
  const upper = input.toUpperCase();
  return CULL_REASON_SET.has(upper)
    ? (upper as CullReasonCode)
    : 'OTHER';
}
