import { beforeEach, describe, expect, it } from 'vitest';

import {
  computeIdempotencyKey,
  draftHash,
  randomIdempotencyKey,
  releaseIdempotencyKey,
} from '../messageIdempotency';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('randomIdempotencyKey', () => {
  it('produces valid v4 UUIDs', () => {
    for (let i = 0; i < 32; i += 1) {
      expect(randomIdempotencyKey()).toMatch(UUID_RE);
    }
  });

  it('produces distinct keys across calls', () => {
    const keys = new Set(Array.from({ length: 64 }, () => randomIdempotencyKey()));
    expect(keys.size).toBe(64);
  });
});

describe('draftHash', () => {
  it('is deterministic for identical content', () => {
    expect(draftHash('hello')).toBe(draftHash('hello'));
  });

  it('separates different content', () => {
    expect(draftHash('hello')).not.toBe(draftHash('hello!'));
    expect(draftHash('')).not.toBe(draftHash(' '));
  });
});

describe('computeIdempotencyKey', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('returns the SAME key for the same draft in the same channel (retry/refresh stability)', () => {
    const first = computeIdempotencyKey('chan-1', 'günaydın');
    const second = computeIdempotencyKey('chan-1', 'günaydın');
    expect(second).toBe(first);
    expect(first).toMatch(UUID_RE);
  });

  it('returns DIFFERENT keys for different drafts', () => {
    const a = computeIdempotencyKey('chan-1', 'hello');
    const b = computeIdempotencyKey('chan-1', 'goodbye');
    expect(b).not.toBe(a);
  });

  it('scopes keys per channel — same text, different channels, different keys', () => {
    const a = computeIdempotencyKey('chan-1', 'hello');
    const b = computeIdempotencyKey('chan-2', 'hello');
    expect(b).not.toBe(a);
  });

  it('survives a page reload of the same draft (sessionStorage memoisation)', () => {
    // Simulate the reload: the module is stateless besides storage, so a fresh
    // call after storage persists must find the memoised key.
    const first = computeIdempotencyKey('chan-1', 'draft after crash');
    const stored = sessionStorage.getItem('msg-idem:chan-1:' + draftHash('draft after crash'));
    expect(stored).toBe(first);
    expect(computeIdempotencyKey('chan-1', 'draft after crash')).toBe(first);
  });

  it('switching drafts back and forth keeps each draft on its own stable key', () => {
    const a1 = computeIdempotencyKey('chan-1', 'first draft');
    computeIdempotencyKey('chan-1', 'second draft');
    const a2 = computeIdempotencyKey('chan-1', 'first draft');
    expect(a2).toBe(a1);
  });

  it('caps memoised keys per channel (bounded storage)', () => {
    for (let i = 0; i < 20; i += 1) {
      computeIdempotencyKey('chan-1', `draft-${i}`);
    }
    let count = 0;
    for (let i = 0; i < sessionStorage.length; i += 1) {
      if (sessionStorage.key(i)?.startsWith('msg-idem:chan-1:')) count += 1;
    }
    expect(count).toBeLessThanOrEqual(8);
    // The most recent draft stays memoised.
    const last = computeIdempotencyKey('chan-1', 'draft-19');
    expect(computeIdempotencyKey('chan-1', 'draft-19')).toBe(last);
  });

  it('still returns a valid key when sessionStorage throws (blocked storage)', () => {
    const original = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(computeIdempotencyKey('chan-1', 'no storage')).toMatch(UUID_RE);
    } finally {
      Object.defineProperty(window, 'sessionStorage', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('releaseIdempotencyKey (V1 MAJOR-1)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('a SUCCESSFUL send releases the memo — re-sending the identical text gets a NEW key', () => {
    const first = computeIdempotencyKey('chan-1', 'ok');
    releaseIdempotencyKey('chan-1', 'ok');
    const second = computeIdempotencyKey('chan-1', 'ok');
    expect(second).not.toBe(first);
    expect(second).toMatch(UUID_RE);
  });

  it('releasing one draft does not affect other drafts in the same channel', () => {
    const keep = computeIdempotencyKey('chan-1', 'hello');
    computeIdempotencyKey('chan-1', 'bye');
    releaseIdempotencyKey('chan-1', 'bye');
    expect(computeIdempotencyKey('chan-1', 'hello')).toBe(keep);
  });

  it('release of a never-memoised draft is a no-op', () => {
    expect(() => releaseIdempotencyKey('chan-1', 'nothing')).not.toThrow();
  });
});
