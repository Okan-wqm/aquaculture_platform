import {
  canonicalWireJsonStringifyV1,
  compareUtf16CodeUnits,
  sha256Hex,
} from '../../../libs/shared-contracts/src/canonical-json';

export const HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1 =
  'hash-linked-canonical-wire-json-sha256/v1' as const;

type HashLinkedNode =
  | {
      readonly schemaVersion: typeof HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1;
      readonly kind: 'leaf';
      readonly value: null | boolean | number | string;
    }
  | {
      readonly schemaVersion: typeof HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1;
      readonly kind: 'array';
      readonly items: readonly string[];
    }
  | {
      readonly schemaVersion: typeof HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1;
      readonly kind: 'object';
      readonly entries: readonly (readonly [string, string])[];
    };

const MAX_HASH_LINK_DEPTH = 64;

function nodeDigest(node: HashLinkedNode): string {
  return sha256Hex(canonicalWireJsonStringifyV1(node));
}

function ownDataDescriptors(value: object): PropertyDescriptorMap {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_OPAQUE_OBJECT');
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if ('get' in descriptor || 'set' in descriptor) {
      throw new TypeError('HASH_LINKED_CANONICAL_JSON_ACCESSOR');
    }
    if (typeof key === 'symbol') {
      throw new TypeError('HASH_LINKED_CANONICAL_JSON_SYMBOL_PROPERTY');
    }
  }
  return descriptors;
}

function hashLinkedNode(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  arrayMember: boolean,
): string | undefined {
  if (depth > MAX_HASH_LINK_DEPTH) {
    throw new TypeError('Hash-linked canonical JSON source exceeds its depth limit');
  }
  if (value === undefined) {
    return arrayMember
      ? nodeDigest({
          schemaVersion: HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
          kind: 'leaf',
          value: null,
        })
      : undefined;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return nodeDigest({
      schemaVersion: HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
      kind: 'leaf',
      value,
    });
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_NON_DATA_VALUE');
  }
  if (typeof value === 'bigint') {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_BIGINT');
  }
  if (typeof value !== 'object') {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_UNSUPPORTED_VALUE');
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError('Hash-linked canonical JSON rejects invalid dates');
    }
    return hashLinkedNode(value.toISOString(), ancestors, depth, arrayMember);
  }
  if (ancestors.has(value)) {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_CYCLE');
  }
  let prototype: object | null;
  try {
    prototype = Reflect.getPrototypeOf(value);
  } catch {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_OPAQUE_PROTOTYPE');
  }
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('HASH_LINKED_CANONICAL_JSON_NON_DATA_OBJECT');
  }

  const descriptors = ownDataDescriptors(value);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const allowedKeys = new Set(['length']);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError('HASH_LINKED_CANONICAL_JSON_SPARSE_ARRAY');
        }
        const digest = hashLinkedNode(descriptor.value, ancestors, depth + 1, true);
        if (!digest) throw new TypeError('HASH_LINKED_CANONICAL_JSON_INTERNAL_INVARIANT');
        items.push(digest);
      }
      const extra = Object.keys(descriptors).find((key) => !allowedKeys.has(key));
      if (extra) throw new TypeError('HASH_LINKED_CANONICAL_JSON_ARRAY_PROPERTY');
      return nodeDigest({
        schemaVersion: HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
        kind: 'array',
        items,
      });
    }

    const entries: Array<readonly [string, string]> = [];
    for (const key of Object.keys(descriptors).sort(compareUtf16CodeUnits)) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('HASH_LINKED_CANONICAL_JSON_NON_ENUMERABLE_DATA');
      }
      const digest = hashLinkedNode(descriptor.value, ancestors, depth + 1, false);
      if (digest !== undefined) entries.push([key, digest] as const);
    }
    return nodeDigest({
      schemaVersion: HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
      kind: 'object',
      entries,
    });
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Content-addresses an arbitrarily wide wire-JSON tree without weakening the
 * shared per-document canonical JSON limits. Every leaf and container is a
 * small JCS document; parent hashes bind ordered child hashes transitively.
 */
export function hashLinkedCanonicalWireJsonSha256V1(value: unknown): string {
  const clone: unknown = Reflect.get(globalThis, 'structuredClone');
  if (typeof clone !== 'function') {
    throw new TypeError('Hash-linked canonical JSON requires structured-clone proxy detection');
  }
  try {
    Reflect.apply(clone, globalThis, [value]);
  } catch {
    throw new TypeError('Hash-linked canonical JSON rejects proxies and non-cloneable inputs');
  }
  const digest = hashLinkedNode(value, new WeakSet<object>(), 0, false);
  if (!digest) throw new TypeError('Hash-linked canonical JSON root must be serializable');
  return digest;
}
