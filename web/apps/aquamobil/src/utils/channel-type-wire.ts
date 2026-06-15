// ============================================================================
// channel-type-wire — ChannelType GraphQL wire-form codec (single boundary SSoT)
// ============================================================================

/**
 * WHY (MSG-HIGH-054): messaging-service registers `ChannelType` with
 * `registerEnumType(ChannelType, { name: 'ChannelType' })` and NO `valuesMap`.
 * NestJS/graphql-js therefore exposes the enum *KEYS* (`DIRECT`, `GROUP`, `AI`)
 * as the GraphQL wire literals, while the TypeScript enum VALUES — and the
 * `channels.type` CHECK constraint — are lowercase (`direct`, `group`, `ai`).
 *
 * Empirically (graphql-js GraphQLEnumType):
 *   parseValue('group')  -> THROWS  "Value \"group\" does not exist in ChannelType"
 *   parseValue('GROUP')  -> 'group'
 *   serialize('group')   -> 'GROUP'
 *
 * Consequences for AquaMobil, which uses the lowercase form internally
 * (`type ChannelType = 'direct' | 'group' | 'ai'`) across ~20 read comparisons:
 *   - SEND: posting `type: 'group'` in CreateChannelInput is coerced by the
 *     server enum and rejected with a 400 before the resolver runs — the
 *     chartered MSG-HIGH-054 "Group/AI channel creation 400".
 *   - READ: the messaging subgraph *serializes* the stored `'group'` back to
 *     the wire literal `'GROUP'`; Apollo Gateway forwards that verbatim, so the
 *     mobile client actually receives `'GROUP'`, not `'group'`. Every
 *     `channel.type === 'group'` comparison would silently mismatch.
 *
 * WHAT: this module is the single point of truth that converts between the
 * AquaMobil-internal lowercase `ChannelType` and the GraphQL wire KEY, applied
 * symmetrically at both boundaries (write via {@link toWireChannelType},
 * read via {@link fromWireChannelType}). Downstream UI keeps comparing the
 * lowercase form — no read site changes, and the wire form can never leak in.
 *
 * The canonical backend counterpart is the resolver input-boundary
 * normalization (INFRA-CRITICAL-013 pattern) in channel.resolver.ts.
 *
 * @see docs/reviews/aquamobil-e2e-audit/2026-06-13-findings.md#MSG-HIGH-054
 */

import type { ChannelType, ChannelTypeWire } from '@/types/messaging';

/**
 * Internal (lowercase) ChannelType -> GraphQL wire KEY.
 * Exhaustive over `ChannelType`; adding a member is a compile-time error here.
 */
const INTERNAL_TO_WIRE: Record<ChannelType, ChannelTypeWire> = {
  direct: 'DIRECT',
  group: 'GROUP',
  ai: 'AI',
};

/**
 * GraphQL wire KEY -> internal (lowercase) ChannelType.
 * Derived from {@link INTERNAL_TO_WIRE} so the two directions cannot drift.
 */
const WIRE_TO_INTERNAL: Record<ChannelTypeWire, ChannelType> = Object.fromEntries(
  (Object.keys(INTERNAL_TO_WIRE) as ChannelType[]).map((internal) => [
    INTERNAL_TO_WIRE[internal],
    internal,
  ]),
) as Record<ChannelTypeWire, ChannelType>;

/**
 * Convert an internal lowercase {@link ChannelType} to the GraphQL wire KEY
 * the messaging subgraph enum accepts. Use at every GraphQL *write* boundary
 * (CreateChannelInput.type).
 *
 * @param type - internal lowercase channel type (`'direct' | 'group' | 'ai'`)
 * @returns the wire KEY (`'DIRECT' | 'GROUP' | 'AI'`)
 */
export function toWireChannelType(type: ChannelType): ChannelTypeWire {
  return INTERNAL_TO_WIRE[type];
}

/**
 * Normalize a channel type received from the GraphQL *read* boundary into the
 * internal lowercase {@link ChannelType}. Tolerant of an already-lowercase
 * value (e.g. a value restored from the IndexedDB offline cache that was
 * written by an older build) so cache round-trips never throw.
 *
 * @param wire - value as received on the wire (`'GROUP'`) or a legacy
 *               already-internal value (`'group'`)
 * @returns the internal lowercase channel type
 */
export function fromWireChannelType(wire: string): ChannelType {
  if (isChannelTypeWire(wire)) return WIRE_TO_INTERNAL[wire];
  // Already lowercase (legacy cache or a value that never round-tripped the
  // enum). Validate it is a known internal value before trusting it.
  const lower = wire.toLowerCase();
  if (isChannelType(lower)) return lower;
  throw new Error(`Unknown ChannelType wire value: ${wire}`);
}

/** Type guard: is `value` one of the GraphQL wire KEYs? Narrows to {@link ChannelTypeWire}. */
function isChannelTypeWire(value: string): value is ChannelTypeWire {
  return Object.prototype.hasOwnProperty.call(WIRE_TO_INTERNAL, value);
}

/** Type guard: is `value` one of the internal lowercase {@link ChannelType} values? */
function isChannelType(value: string): value is ChannelType {
  return Object.prototype.hasOwnProperty.call(INTERNAL_TO_WIRE, value);
}

/**
 * Return a shallow copy of a channel-shaped object with its `type` normalized
 * to the internal lowercase form. Read hooks apply this so every downstream
 * comparison (`channel.type === 'group'`) stays correct regardless of the
 * wire casing.
 *
 * @param channel - any object carrying a `type: string` field from the wire
 * @returns the same object shape with `type` coerced to {@link ChannelType}
 */
export function normalizeChannelType<T extends { type: string }>(
  channel: T,
): Omit<T, 'type'> & { type: ChannelType } {
  return { ...channel, type: fromWireChannelType(channel.type) };
}
