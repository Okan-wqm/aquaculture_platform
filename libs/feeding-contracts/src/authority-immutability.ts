import { createCanonicalJsonDocumentV1 } from '@aquaculture/shared-contracts';

/**
 * Recursively freezes a compiled authority graph before any digest or runtime
 * consumer can observe it. Authority catalogs are JSON-shaped by contract;
 * the strict canonical validator rejects cycles and every non-data shape before
 * the original graph is frozen in place.
 */
export function freezeAuthorityGraphV1<T>(value: T): T {
  createCanonicalJsonDocumentV1(value);
  const visited = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (visited.has(candidate)) return;

    visited.add(candidate);
    for (const child of Object.values(candidate)) {
      freeze(child);
    }
    Object.freeze(candidate);
  };

  freeze(value);
  return value;
}
