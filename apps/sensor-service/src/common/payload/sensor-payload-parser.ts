/**
 * Sensor payload parser — the single extraction engine shared by channel
 * discovery (registration-time) and runtime reads (protocol adapters).
 *
 * SENSOR-HIGH-082: the HTTP_REST adapter's `parseResponse` was a placeholder that
 * returned empty values, so a configured REST sensor never produced a reading and
 * its dataPath / responseFormat / dataMapping were silently discarded. This module
 * is the one place that walks a response body into channel values, so discovery
 * ("what channels exist") and read ("their current values") traverse identically.
 *
 * Pure functions — no I/O, no DI, no NestJS. Both `ChannelDiscoveryService` and
 * `HttpRestAdapter` import it directly, avoiding any module/DI coupling.
 */

/** A channel value coerced to the shape a reading stores. */
export type ChannelValue = number | string | boolean | null;

/** One extracted leaf: its raw key, full dot-path, and value. */
export interface ExtractedEntry {
  key: string;
  dataPath: string;
  value: unknown;
}

/** Supported response body formats. */
export type PayloadFormat = 'json' | 'xml' | 'csv' | 'text';

/**
 * Normalize a raw key to a stable channel key (lowercase, non-alphanumerics
 * collapsed to `_`, trimmed). Discovery and read MUST use the same normalization
 * so a reading's keys line up with the discovered channels' keys.
 */
export function normalizeChannelKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Keys that are transport/identity metadata, not sensor channels. */
const METADATA_FIELDS = new Set([
  'timestamp',
  'time',
  'datetime',
  'date',
  'device_id',
  'deviceid',
  'sensor_id',
  'sensorid',
  'id',
  'uuid',
  'guid',
  'topic',
  'message_id',
  'messageid',
  'tenant',
  'tenantid',
  'tenant_id',
  'created',
  'updated',
  'modified',
  'version',
  'v',
  'seq',
  'sequence',
]);

/**
 * True when a key is transport/identity metadata (excluded from channels + reads),
 * e.g. `timestamp`, `device_id`, `sequence`. Shared so discovery and read agree.
 */
export function isMetadataFieldKey(key: string): boolean {
  return METADATA_FIELDS.has(key.toLowerCase());
}

/**
 * Coerce an arbitrary extracted value into a channel value. Numeric strings
 * become numbers; boolean-ish strings become booleans; objects/undefined become
 * null (a leaf we cannot represent is absent, never a fabricated 0).
 */
export function coerceChannelValue(value: unknown): ChannelValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
    const lower = trimmed.toLowerCase();
    if (['true', 'false', 'yes', 'no', 'on', 'off'].includes(lower)) {
      return lower === 'true' || lower === 'yes' || lower === 'on';
    }
    return value;
  }
  // Arrays / objects are not directly representable as a single channel value.
  return null;
}

/**
 * Navigate a dot-path (e.g. `data.readings.temperature`) into a parsed body.
 * Returns `undefined` if any segment is missing. Numeric segments index arrays.
 */
export function extractValueAtPath(root: unknown, dotPath: string): unknown {
  if (!dotPath) {
    return root;
  }
  let current: unknown = root;
  for (const segment of dotPath.split('.')) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Recursively flatten a JSON object to leaf entries keyed by dot-path. Mirrors the
 * discovery walk: nested objects recurse with a dot-path prefix, an array whose
 * first element is numeric contributes that element, and keys for which
 * `shouldSkip` returns true (metadata such as `timestamp`, `device_id`) are
 * excluded along with their subtree.
 */
export function flattenJsonEntries(
  payload: unknown,
  prefix = '',
  shouldSkip?: (key: string) => boolean,
): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return entries;
  }

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (shouldSkip?.(key)) {
      continue;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      entries.push(...flattenJsonEntries(value, fullPath, shouldSkip));
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0 && typeof value[0] === 'number') {
        entries.push({ key, dataPath: fullPath, value: value[0] });
      }
      continue;
    }

    if (value !== null && value !== undefined) {
      entries.push({ key, dataPath: fullPath, value });
    }
  }

  return entries;
}

/**
 * Parse a single-row CSV body into entries. When the first line contains a
 * non-numeric cell it is treated as a header row and paired with the second line;
 * otherwise cells are keyed `value_<index>`.
 */
export function parseCsvEntries(payload: string): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  if (typeof payload !== 'string') {
    return entries;
  }
  const lines = payload.trim().split('\n');
  if (lines.length === 0 || !lines[0]) {
    return entries;
  }

  const firstLine = lines[0].split(',').map((s) => s.trim());
  const hasHeaders = firstLine.some((v) => v.length > 0 && !Number.isFinite(Number(v)));

  if (hasHeaders && lines.length > 1 && lines[1]) {
    const values = lines[1].split(',').map((s) => s.trim());
    firstLine.forEach((header, index) => {
      if (values[index] !== undefined) {
        entries.push({ key: header, dataPath: header, value: values[index] });
      }
    });
  } else {
    firstLine.forEach((val, index) => {
      entries.push({ key: `value_${index}`, dataPath: `value_${index}`, value: val });
    });
  }

  return entries;
}

/**
 * Parse a key=value text body (delimited by `;`, `&`, or newline) into entries.
 * A body with no pairs but a single numeric value yields a `value` entry.
 */
export function parseTextEntries(payload: string): ExtractedEntry[] {
  const entries: ExtractedEntry[] = [];
  if (typeof payload !== 'string') {
    return entries;
  }

  for (const pair of payload.split(/[;&\n]/)) {
    const [key, value] = pair.split('=').map((s) => s.trim());
    if (key && value !== undefined) {
      entries.push({ key, dataPath: key, value });
    }
  }

  if (entries.length === 0) {
    const trimmed = payload.trim();
    if (trimmed !== '' && !Number.isNaN(Number.parseFloat(trimmed))) {
      entries.push({ key: 'value', dataPath: 'value', value: trimmed });
    }
  }

  return entries;
}

/**
 * Parse a raw response body per its declared format. JSON is parsed to an object;
 * XML is reduced to a flat `{ tag: text }` object via leaf-tag extraction; CSV and
 * text are returned verbatim for the row/pair parsers. A JSON parse failure throws
 * so the caller can surface an honest read error rather than silently emit nothing.
 */
export function parseBodyByFormat(raw: string, format: PayloadFormat): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(raw);
    case 'xml':
      return parseXmlLeaves(raw);
    case 'csv':
    case 'text':
    default:
      return raw;
  }
}

/**
 * Minimal XML leaf extraction: pulls `<tag>text</tag>` pairs into a flat object.
 * Not a full XML parser — it covers the flat vendor telemetry documents this
 * adapter targets; nested/attribute-heavy XML degrades to the leaves it can read.
 */
function parseXmlLeaves(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const leaf = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = leaf.exec(raw)) !== null) {
    const tag = match[1];
    const value = (match[2] ?? '').trim();
    if (tag && value !== '') {
      result[tag] = value;
    }
  }
  return result;
}

/** Options for {@link extractReadingValues}. */
export interface ExtractReadingOptions {
  /** Dot-path to the sub-document holding the readings (applied before mapping). */
  dataPath?: string;
  /** Explicit channelKey → dot-path map. When present, only these are extracted. */
  dataMapping?: Record<string, string>;
  /** Metadata keys to skip when auto-flattening JSON (no dataMapping). */
  shouldSkip?: (key: string) => boolean;
}

/**
 * Extract a channel-value map from a raw response body. This is the runtime read
 * path: parse the body, descend into `dataPath`, then either apply the explicit
 * `dataMapping` or auto-flatten the (JSON) document. Keys are normalized so they
 * line up with the discovered channels' keys. Values are coerced; a mapped path
 * that resolves to nothing is omitted (never a fabricated value).
 */
export function extractReadingValues(
  raw: string,
  format: PayloadFormat,
  options: ExtractReadingOptions = {},
): Record<string, ChannelValue> {
  const parsed = parseBodyByFormat(raw, format);
  const root = options.dataPath ? extractValueAtPath(parsed, options.dataPath) : parsed;
  const values: Record<string, ChannelValue> = {};

  if (options.dataMapping && Object.keys(options.dataMapping).length > 0) {
    for (const [channelKey, path] of Object.entries(options.dataMapping)) {
      const raw = extractValueAtPath(root, path);
      if (raw !== undefined) {
        values[normalizeChannelKey(channelKey)] = coerceChannelValue(raw);
      }
    }
    return values;
  }

  let entries: ExtractedEntry[];
  if (format === 'csv') {
    entries = parseCsvEntries(raw);
  } else if (format === 'text') {
    entries = parseTextEntries(raw);
  } else {
    entries = flattenJsonEntries(root, '', options.shouldSkip);
  }

  for (const entry of entries) {
    values[normalizeChannelKey(entry.key)] = coerceChannelValue(entry.value);
  }
  return values;
}
