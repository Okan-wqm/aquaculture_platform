/** RFC 8785/JCS data and hashing authority shared by Node and browser runtimes. */

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonLimitsV1 {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

export const CANONICAL_JSON_LIMITS_V1: CanonicalJsonLimitsV1 = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 4 * 1_024 * 1_024,
});

export interface CanonicalHashAuthorityV1 {
  readonly domain: string;
  readonly schemaVersion: string;
}

const canonicalJsonDocumentBrand: unique symbol = Symbol('CanonicalJsonDocumentV1');

export interface CanonicalJsonDocumentV1 {
  readonly schemaVersion: 'canonical-json-document/v1';
  readonly value: CanonicalJsonValue;
  readonly [canonicalJsonDocumentBrand]: true;
}

const canonicalDocuments = new WeakSet<object>();
const OMIT_WIRE_MEMBER = Symbol('OMIT_WIRE_MEMBER');

function isStructuredCloneFunction(candidate: unknown): candidate is (value: unknown) => unknown {
  return typeof candidate === 'function';
}

function resolveStructuredClone(): ((value: unknown) => unknown) | undefined {
  const candidate: unknown = Reflect.get(globalThis, 'structuredClone');
  return isStructuredCloneFunction(candidate) ? candidate : undefined;
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 1) {
    const first = value.charCodeAt(offset);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(offset + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        codePoint = 0x1_0000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        offset += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

interface SnapshotState {
  readonly mode: 'strict' | 'wire-v1';
  readonly limits: CanonicalJsonLimitsV1;
  readonly ancestors: WeakSet<object>;
  nodes: number;
  sourceBytes: number;
}

/** Locale-independent UTF-16 code-unit ordering required by RFC 8785. */
export function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveLimits(limits?: Partial<CanonicalJsonLimitsV1>): CanonicalJsonLimitsV1 {
  const resolved = {
    maxDepth: limits?.maxDepth ?? CANONICAL_JSON_LIMITS_V1.maxDepth,
    maxNodes: limits?.maxNodes ?? CANONICAL_JSON_LIMITS_V1.maxNodes,
    maxBytes: limits?.maxBytes ?? CANONICAL_JSON_LIMITS_V1.maxBytes,
  };
  for (const [name, value] of Object.entries(resolved)) {
    const ceiling = CANONICAL_JSON_LIMITS_V1[name as keyof CanonicalJsonLimitsV1];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new TypeError(`Canonical JSON ${name} must be an integer between 1 and ${ceiling}`);
    }
  }
  return Object.freeze(resolved);
}

function normalizeUnicodeScalarString(
  value: string,
  state: SnapshotState,
  repairLoneSurrogates: boolean,
): string {
  const normalized = repairLoneSurrogates ? value.replace(/[\uD800-\uDFFF]/gu, '\uFFFD') : value;
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = normalized.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('CANONICAL_JSON_INVALID_UNICODE');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('CANONICAL_JSON_INVALID_UNICODE');
    }
  }
  state.sourceBytes += utf8Bytes(normalized).byteLength;
  if (state.sourceBytes > state.limits.maxBytes) {
    throw new TypeError('Canonical JSON source exceeds its byte limit');
  }
  return normalized;
}

function ownDataDescriptors(value: object): PropertyDescriptorMap {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('CANONICAL_JSON_OPAQUE_OBJECT');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError('CANONICAL_JSON_ACCESSOR');
    }
    if (typeof key === 'symbol') {
      throw new TypeError('CANONICAL_JSON_SYMBOL_PROPERTY');
    }
  }
  return descriptors;
}

function snapshot(
  value: unknown,
  state: SnapshotState,
  depth: number,
  arrayMember: boolean,
): CanonicalJsonValue | typeof OMIT_WIRE_MEMBER {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new TypeError('Canonical JSON source exceeds its node limit');
  }
  if (depth > state.limits.maxDepth) {
    throw new TypeError('Canonical JSON source exceeds its depth limit');
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return normalizeUnicodeScalarString(value, state, state.mode === 'wire-v1');
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('CANONICAL_JSON_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'undefined') {
    if (state.mode === 'wire-v1') return arrayMember ? null : OMIT_WIRE_MEMBER;
    throw new TypeError('CANONICAL_JSON_STRICT_UNDEFINED');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('CANONICAL_JSON_NON_DATA_VALUE');
  }
  if (typeof value === 'bigint') throw new TypeError('CANONICAL_JSON_BIGINT');
  if (typeof value !== 'object') {
    throw new TypeError('CANONICAL_JSON_UNSUPPORTED_VALUE');
  }
  if (state.mode === 'wire-v1' && value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Wire JSON rejects invalid dates');
    const instant = value.toISOString();
    return normalizeUnicodeScalarString(instant, state, false);
  }
  if (value instanceof Date) throw new TypeError('CANONICAL_JSON_STRICT_DATE');
  if (state.ancestors.has(value)) throw new TypeError('CANONICAL_JSON_CYCLE');
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError('CANONICAL_JSON_OPAQUE_PROTOTYPE');
  }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('CANONICAL_JSON_NON_DATA_OBJECT');
  }
  const descriptors = ownDataDescriptors(value);
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const allowedKeys = new Set(['length']);
      const result: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('CANONICAL_JSON_SPARSE_ARRAY');
        }
        const entry = snapshot(descriptor.value, state, depth + 1, true);
        result.push(entry === OMIT_WIRE_MEMBER ? null : entry);
      }
      const extra = Object.keys(descriptors).find((key) => !allowedKeys.has(key));
      if (extra) throw new TypeError('CANONICAL_JSON_ARRAY_PROPERTY');
      return Object.freeze(result);
    }
    const result: Record<string, CanonicalJsonValue> = Object.create(null);
    for (const key of Object.keys(descriptors).sort(compareUtf16CodeUnits)) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('CANONICAL_JSON_NON_ENUMERABLE_DATA');
      }
      normalizeUnicodeScalarString(key, state, false);
      const entry = snapshot(descriptor.value, state, depth + 1, false);
      if (entry !== OMIT_WIRE_MEMBER) result[key] = entry;
    }
    return Object.freeze(result);
  } finally {
    state.ancestors.delete(value);
  }
}

function documentFromSnapshot(value: CanonicalJsonValue): CanonicalJsonDocumentV1 {
  const document = Object.freeze({
    schemaVersion: 'canonical-json-document/v1' as const,
    value,
    [canonicalJsonDocumentBrand]: true as const,
  });
  canonicalDocuments.add(document);
  return document;
}

function createDocument(
  value: unknown,
  mode: SnapshotState['mode'],
  limits?: Partial<CanonicalJsonLimitsV1>,
): CanonicalJsonDocumentV1 {
  const state: SnapshotState = {
    mode,
    limits: resolveLimits(limits),
    ancestors: new WeakSet<object>(),
    nodes: 0,
    sourceBytes: 0,
  };
  const normalized = snapshot(value, state, 0, false);
  if (normalized === OMIT_WIRE_MEMBER) {
    throw new TypeError('Canonical JSON root must be serializable');
  }
  const clone = resolveStructuredClone();
  if (typeof clone !== 'function') {
    throw new TypeError('Canonical JSON requires structured-clone proxy detection');
  }
  try {
    clone(value);
  } catch {
    throw new TypeError('Canonical JSON rejects proxies and non-cloneable inputs');
  }
  if (utf8Bytes(serializeCanonicalValue(normalized)).byteLength > state.limits.maxBytes) {
    throw new TypeError('Canonical JSON output exceeds its byte limit');
  }
  return documentFromSnapshot(normalized);
}

/** Validates and snapshots immutable JSON data; Date/undefined coercion is forbidden. */
export function createCanonicalJsonDocumentV1(
  value: unknown,
  limits?: Partial<CanonicalJsonLimitsV1>,
): CanonicalJsonDocumentV1 {
  return createDocument(value, 'strict', limits);
}

/** Explicit legacy wire policy: Date→ISO, object undefined omitted, array undefined→null. */
export function createWireJsonDocumentV1(
  value: unknown,
  limits?: Partial<CanonicalJsonLimitsV1>,
): CanonicalJsonDocumentV1 {
  return createDocument(value, 'wire-v1', limits);
}

function serializeCanonicalValue(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonicalValue).join(',')}]`;
  const record = value as { readonly [key: string]: CanonicalJsonValue };
  return `{${Object.keys(record)
    .sort(compareUtf16CodeUnits)
    .map((key) => `${JSON.stringify(key)}:${serializeCanonicalValue(record[key]!)}`)
    .join(',')}}`;
}

/** Strict RFC 8785 serializer; only documents minted by the validator are accepted. */
export function canonicalJsonStringify(document: CanonicalJsonDocumentV1): string {
  if (!canonicalDocuments.has(document)) {
    throw new TypeError('Canonical JSON rejects unvalidated or proxied documents');
  }
  const bytes = serializeCanonicalValue(document.value);
  if (utf8Bytes(bytes).byteLength > CANONICAL_JSON_LIMITS_V1.maxBytes) {
    throw new TypeError('Canonical JSON output exceeds its byte limit');
  }
  return bytes;
}

export function canonicalWireJsonStringifyV1(
  value: unknown,
  limits?: Partial<CanonicalJsonLimitsV1>,
): string {
  return canonicalJsonStringify(createWireJsonDocumentV1(value, limits));
}

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Lower-case hexadecimal SHA-256 over UTF-8 bytes. */
export function sha256Hex(value: string): string {
  const input = utf8Bytes(value);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choice + ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, '0')).join('');
}

function assertHashAuthority(authority: CanonicalHashAuthorityV1): void {
  if (!/^[a-z0-9][a-z0-9._/-]{2,127}$/.test(authority.domain)) {
    throw new TypeError('Canonical hash domain is invalid');
  }
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\/v[1-9][0-9]{0,8}$/.test(authority.schemaVersion)) {
    throw new TypeError('Canonical hash schemaVersion is invalid');
  }
}

export function canonicalJsonHashPreimageV1(
  authority: CanonicalHashAuthorityV1,
  document: CanonicalJsonDocumentV1,
): string {
  assertHashAuthority(authority);
  if (!canonicalDocuments.has(document)) {
    throw new TypeError('Canonical hash rejects unvalidated or proxied documents');
  }
  return serializeCanonicalValue({
    domain: authority.domain,
    schemaVersion: authority.schemaVersion,
    value: document.value,
  });
}

export function canonicalJsonSha256(
  authority: CanonicalHashAuthorityV1,
  document: CanonicalJsonDocumentV1,
): string {
  return sha256Hex(canonicalJsonHashPreimageV1(authority, document));
}

export function canonicalWireJsonSha256V1(
  authority: CanonicalHashAuthorityV1,
  value: unknown,
  limits?: Partial<CanonicalJsonLimitsV1>,
): string {
  return canonicalJsonSha256(authority, createWireJsonDocumentV1(value, limits));
}

/**
 * Cross-client identity for the payload bytes carried by mobile command
 * envelopes.  Both online web mutations and the offline PWA queue import this
 * function; no client is allowed to invent its own serializer or hash domain.
 */
export const MOBILE_COMMAND_PAYLOAD_HASH_AUTHORITY_V1: CanonicalHashAuthorityV1 = Object.freeze({
  domain: 'aquaculture.mobile-command-payload',
  schemaVersion: 'mobile-command-payload/v1',
});

export function mobileCommandPayloadSha256V1(value: unknown): string {
  return canonicalWireJsonSha256V1(MOBILE_COMMAND_PAYLOAD_HASH_AUTHORITY_V1, value);
}
