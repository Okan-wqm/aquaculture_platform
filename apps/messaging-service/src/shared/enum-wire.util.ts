// ============================================================================
// Enum wire-serialization SSoT (S1-CODEGEN / MSG-CRITICAL-055)
// ============================================================================
//
// WHY this exists (the enum-casing class root cause):
//   The messaging string enums are value-mapped — the TypeScript enum NAME is
//   uppercase (the GraphQL wire form) while the VALUE is the lowercase persisted
//   DB form:
//       enum MessageContentType { TEXT = 'text', IMAGE = 'image', … }
//       enum ReceiptStatus      { DELIVERED = 'delivered', READ = 'read' }
//   NestJS GraphQL serializes the enum NAME on the wire (`TEXT`, `DELIVERED`);
//   graphql-codegen therefore generates the UPPERCASE union for the client. But
//   the gateway NATS→Socket.IO bridge hydrates a message DIRECTLY from the DB
//   row (getMessageForBroadcast), bypassing the GraphQL serialization layer, so
//   it would otherwise emit the raw lowercase VALUE (`text`, `delivered`). The
//   same logical field then has two wire forms depending on the delivery path
//   (GraphQL query vs. live WS) — the exact drift S1 eliminates.
//
// WHAT this fixes:
//   `toWireEnumName` is the canonical VALUE→NAME projection. It derives the NAME
//   from the TypeScript enum object itself (reverse lookup over Object.entries),
//   so the mapping can NEVER drift from the enum definition — adding a new enum
//   member is automatically covered, no parallel table to maintain. The WS
//   hydrator runs every enum field it emits through this projection so the live
//   WS wire form is byte-identical to the GraphQL wire form (the UPPERCASE
//   GraphQL enum NAME).
//
// Architectural tier: "make it automatic" — the GraphQL-name wire form becomes
// the zero-effort default for the non-GraphQL (WS) emit path, derived from the
// single enum SSoT rather than a hand-maintained map.
//
// @see apps/messaging-service/src/event-handlers/messaging-nats.handler.ts
// @see libs/event-contracts/src/websocket-envelopes.ts (the UPPERCASE WS contract)
// ============================================================================

/**
 * Project a runtime string-enum VALUE (the lowercase persisted DB form) to its
 * GraphQL wire NAME (the UPPERCASE enum key) for a value-mapped TypeScript
 * string enum.
 *
 * The mapping is derived from the enum object's own `Object.entries`, so it
 * stays in lock-step with the enum definition: there is no second source of
 * truth to keep in sync. Adding a new enum member is automatically covered.
 *
 * The return type is the enum's KEY union (`keyof TEnum & string`), i.e. the
 * exact GraphQL enum-NAME union. For the messaging enums that key union is
 * identical to the generated graphql-codegen union (`'TEXT' | 'IMAGE' | …`) and
 * to the WS-envelope contract union (`WsMessageContentType`), so the projected
 * value assigns straight into the WS field with NO cast and any future
 * divergence is a compile error.
 *
 * The runtime value is always a member of the enum (the DB CHECK constraint and
 * the entity column type guarantee it), so the reverse lookup always resolves;
 * the non-null assertion documents that invariant rather than hiding a bug.
 *
 * @param enumObject the value-mapped TypeScript string enum (e.g. MessageContentType)
 * @param value      the runtime DB value to project (e.g. 'text')
 * @returns the GraphQL enum NAME (e.g. 'TEXT'), typed as the enum's key union
 */
export function toWireEnumName<TEnum extends Record<string, string>>(
  enumObject: TEnum,
  value: TEnum[keyof TEnum],
): keyof TEnum & string {
  const entry = Object.entries(enumObject).find(
    ([, enumValue]) => enumValue === value,
  );
  if (!entry) {
    // The entity column type + DB CHECK constraint guarantee `value` is a
    // member of the enum; an unmapped value is a corrupted row, not a casing
    // mismatch. Surface it loudly instead of emitting an unrenderable literal.
    throw new Error(
      `toWireEnumName: value "${value}" is not a member of the provided enum`,
    );
  }
  return entry[0];
}

/**
 * Inverse of {@link toWireEnumName}: normalize a value-mapped string enum's
 * inbound GraphQL wire form (the UPPERCASE enum NAME, e.g. `'MEMBER'`/`'ALL'`)
 * to the canonical lowercase DB VALUE (`'member'`/`'all'`) at the resolver input
 * boundary.
 *
 * WHY this exists (INFRA-CRITICAL-013 root cause, generalised for S1-CODEGEN):
 *   The messaging member enums (ChannelMemberRole, NotificationPreference) are
 *   value-mapped string enums registered with a metadata-only valuesMap, so the
 *   GraphQL wire form is the UPPERCASE NAME but the DB CHECK constraints
 *   (chk_member_role / chk_notification_pref) accept ONLY the lowercase VALUE.
 *   Depending on the graphql-js coercion path the resolver param may arrive as
 *   the NAME (`'MEMBER'`) or already as the VALUE (`'member'`); writing the NAME
 *   straight to the column violates the constraint. `addChannelMember` already
 *   normalized inline via an ad-hoc `(Enum as Record<…>)[role] ?? role` cast,
 *   but the sibling `updateNotificationPreference` did NOT — an asymmetry where
 *   one write path was fail-safe and the other fragile.
 *
 * WHAT this fixes:
 *   This is the single canonical NAME→VALUE projection, derived from the enum
 *   object itself (so it can never drift from the enum definition and adding a
 *   member is automatically covered). Both write paths route their inbound enum
 *   through it, so every messaging member-enum write is uniformly normalised to
 *   the DB VALUE with NO per-callsite cast. If the input is already the lowercase
 *   VALUE (the other coercion path), it is returned unchanged.
 *
 * Architectural tier: "make it automatic" — the constraint-safe DB VALUE becomes
 * the zero-effort default for every enum write, derived from the single enum
 * SSoT rather than a hand-maintained map or a per-resolver cast.
 *
 * @param enumObject the value-mapped TypeScript string enum (e.g. ChannelMemberRole)
 * @param input      the inbound wire literal — either the enum NAME or VALUE
 * @returns the canonical DB VALUE (`TEnum[keyof TEnum]`)
 */
export function normalizeEnumInput<TEnum extends Record<string, string>>(
  enumObject: TEnum,
  input: string,
): TEnum[keyof TEnum] {
  // Input is the UPPERCASE NAME (a key of the enum): map NAME → VALUE.
  if (Object.prototype.hasOwnProperty.call(enumObject, input)) {
    return enumObject[input] as TEnum[keyof TEnum];
  }
  // Input is already the lowercase VALUE (a member of the enum value set):
  // return it unchanged so an already-normalised value round-trips cleanly.
  const values = Object.values(enumObject);
  if (values.includes(input)) {
    return input as TEnum[keyof TEnum];
  }
  // Neither a NAME nor a VALUE — an unmappable literal that would violate the
  // DB CHECK constraint. Surface it loudly at the input boundary rather than
  // letting Postgres reject it deep in the write.
  throw new Error(
    `normalizeEnumInput: "${input}" is neither a NAME nor a VALUE of the provided enum`,
  );
}
