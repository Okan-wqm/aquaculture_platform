/**
 * @module TagRef
 *
 * Branded canonical tag reference — the single tag identity that flows
 * end-to-end through the sensor domain: widget bindings → ScadaPackage
 * document → deploy artifact → edge payload → runtime socket subscriptions.
 *
 * The canonical grammar mirrors how `UnifiedTagService.discoverTags()`
 * mints `unified_tags.fqn` rows (`${deviceCode}/${tagName}` from
 * `EdgeDevice.deviceCode` + `DeviceIoConfig.tagName`), so every valid
 * TagRef is resolvable against the tag registry by exact-FQN lookup.
 *
 * Tier-1 discipline: code that requires a `TagRef` cannot be handed a
 * free-text string — the brand is only obtainable through `parseTagRef`
 * (or `buildTagRef`), which enforce the grammar at the boundary.
 */

/**
 * Canonical tag reference: `${deviceCode}/${localName}`.
 * Obtainable only via {@link parseTagRef} / {@link buildTagRef}.
 */
export type TagRef = string & { readonly __tagRefBrand: unique symbol };

/**
 * Device segment: mirrors `EdgeDevice.deviceCode` (varchar 50, e.g.
 * `EDGE-AABB1122`). First char alphanumeric; dash/underscore/dot allowed
 * afterwards; no `/`, no whitespace.
 */
export const TAG_REF_DEVICE_CODE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$';

/**
 * Local-name segment: mirrors `DeviceIoConfig.tagName` (varchar 50, unique
 * per device; dotted names like `tank1.do` are in active use).
 */
export const TAG_REF_LOCAL_NAME_PATTERN = '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$';

/** Full-reference pattern (single `/` separator between the two segments). */
export const TAG_REF_PATTERN =
  '^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}/[A-Za-z0-9_][A-Za-z0-9_.-]{0,49}$';

const DEVICE_CODE_REGEX = new RegExp(TAG_REF_DEVICE_CODE_PATTERN);
const LOCAL_NAME_REGEX = new RegExp(TAG_REF_LOCAL_NAME_PATTERN);
const TAG_REF_REGEX = new RegExp(TAG_REF_PATTERN);

/** Thrown when a raw string violates the TagRef grammar. */
export class TagRefParseError extends Error {
  constructor(
    public readonly raw: string,
    reason: string,
  ) {
    super(`Invalid TagRef ${JSON.stringify(raw)}: ${reason}`);
    this.name = 'TagRefParseError';
  }
}

/** Type guard: does `raw` satisfy the canonical TagRef grammar? */
export function isTagRef(raw: string): raw is TagRef {
  return TAG_REF_REGEX.test(raw);
}

/**
 * Parse a raw string into a branded {@link TagRef}.
 * @throws TagRefParseError when the grammar is violated.
 */
export function parseTagRef(raw: string): TagRef {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TagRefParseError(String(raw), 'empty value');
  }
  const separatorIndex = raw.indexOf('/');
  if (separatorIndex === -1) {
    throw new TagRefParseError(raw, "missing '/' separator (expected deviceCode/localName)");
  }
  if (raw.indexOf('/', separatorIndex + 1) !== -1) {
    throw new TagRefParseError(raw, "more than one '/' separator");
  }
  const deviceCode = raw.slice(0, separatorIndex);
  const localName = raw.slice(separatorIndex + 1);
  if (!DEVICE_CODE_REGEX.test(deviceCode)) {
    throw new TagRefParseError(raw, `device segment ${JSON.stringify(deviceCode)} violates ${TAG_REF_DEVICE_CODE_PATTERN}`);
  }
  if (!LOCAL_NAME_REGEX.test(localName)) {
    throw new TagRefParseError(raw, `local-name segment ${JSON.stringify(localName)} violates ${TAG_REF_LOCAL_NAME_PATTERN}`);
  }
  return raw as TagRef;
}

/** Build a TagRef from its two validated segments. */
export function buildTagRef(deviceCode: string, localName: string): TagRef {
  return parseTagRef(`${deviceCode}/${localName}`);
}

/**
 * Adopt a registry row's FQN as a TagRef. The registry mints FQNs with the
 * same grammar; a violation here means corrupt registry data, so it throws.
 */
export function tagRefFromUnifiedTag(tag: { fqn: string }): TagRef {
  return parseTagRef(tag.fqn);
}

/** Split a TagRef back into its segments. */
export function splitTagRef(ref: TagRef): { deviceCode: string; localName: string } {
  const separatorIndex = ref.indexOf('/');
  return {
    deviceCode: ref.slice(0, separatorIndex),
    localName: ref.slice(separatorIndex + 1),
  };
}
