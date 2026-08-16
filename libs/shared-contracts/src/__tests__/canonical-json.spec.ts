import { createHash } from 'node:crypto';

import {
  canonicalJsonHashPreimageV1,
  canonicalJsonSha256,
  canonicalJsonStringify,
  canonicalWireJsonStringifyV1,
  compareUtf16CodeUnits,
  createCanonicalJsonDocumentV1,
  createWireJsonDocumentV1,
  mobileCommandPayloadSha256V1,
  sha256Hex,
} from '../canonical-json';

const TEST_AUTHORITY = Object.freeze({
  domain: 'aquaculture.test-vector',
  schemaVersion: 'canonical-test/v1',
});

describe('cross-runtime canonical JSON authority', () => {
  it('implements the RFC 8785 number serialization sample', () => {
    const document = createCanonicalJsonDocumentV1([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27]);
    expect(canonicalJsonStringify(document)).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-27]');
  });

  it('implements RFC 8785 UTF-16 property ordering', () => {
    const document = createCanonicalJsonDocumentV1({
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    });
    expect(canonicalJsonStringify(document)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(['€', '\r', 'דּ', '1', '😀', '\u0080', 'ö'].sort(compareUtf16CodeUnits)).toEqual([
      '\r',
      '1',
      '\u0080',
      'ö',
      '€',
      '😀',
      'דּ',
    ]);
  });

  it('requires validated immutable documents and snapshots the source', () => {
    const source = { b: 2, a: [1, null] };
    const document = createCanonicalJsonDocumentV1(source);
    source.b = 9;
    expect(canonicalJsonStringify(document)).toBe('{"a":[1,null],"b":2}');
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.value)).toBe(true);
    expect(() => canonicalJsonStringify(source as never)).toThrow(
      'unvalidated or proxied documents',
    );
  });

  it('separates strict JSON data from the bounded legacy wire normalizer', () => {
    const value = {
      at: new Date('2026-08-08T00:00:00.000Z'),
      omitted: undefined,
      list: [undefined],
    };
    expect(() => createCanonicalJsonDocumentV1(value)).toThrow('CANONICAL_JSON_STRICT_DATE');
    expect(canonicalWireJsonStringifyV1(value)).toBe(
      '{"at":"2026-08-08T00:00:00.000Z","list":[null]}',
    );
    expect(canonicalJsonStringify(createWireJsonDocumentV1({ text: '\ud800' }))).toBe(
      '{"text":"�"}',
    );
    expect(() => createCanonicalJsonDocumentV1({ text: '\ud800' })).toThrow(
      'CANONICAL_JSON_INVALID_UNICODE',
    );
  });

  it('rejects accessors without invoking them and rejects proxies', () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'leaked';
      },
    });
    expect(() => createCanonicalJsonDocumentV1(accessor)).toThrow('CANONICAL_JSON_ACCESSOR');
    expect(getterCalls).toBe(0);
    expect(() => createCanonicalJsonDocumentV1(new Proxy({ safe: true }, {}))).toThrow(
      'rejects proxies',
    );
  });

  it('fails closed on cycles, sparse arrays, depth, nodes and bytes', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => createCanonicalJsonDocumentV1(cycle)).toThrow('CANONICAL_JSON_CYCLE');
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => createCanonicalJsonDocumentV1(sparse)).toThrow('CANONICAL_JSON_SPARSE_ARRAY');
    expect(() =>
      createCanonicalJsonDocumentV1({ one: { two: { three: true } } }, { maxDepth: 2 }),
    ).toThrow('depth limit');
    expect(() => createCanonicalJsonDocumentV1([1, 2, 3], { maxNodes: 3 })).toThrow('node limit');
    expect(() => createCanonicalJsonDocumentV1({ data: '0123456789' }, { maxBytes: 8 })).toThrow(
      'byte limit',
    );
  });

  it('never reflects attacker-controlled property names in diagnostics', () => {
    const attackerKey = `TOP-SECRET-${'x'.repeat(8_000)}\ncontrol`;
    const value = Object.defineProperty({}, attackerKey, {
      enumerable: false,
      value: true,
    });
    let message = '';
    try {
      createCanonicalJsonDocumentV1(value);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('CANONICAL_JSON_NON_ENUMERABLE_DATA');
    expect(message).not.toContain('TOP-SECRET');
    expect(message.length).toBeLessThan(128);
  });

  it('domain-separates hashes and matches Node createHash byte-for-byte', () => {
    const document = createCanonicalJsonDocumentV1({ b: 2, a: 1 });
    const preimage = canonicalJsonHashPreimageV1(TEST_AUTHORITY, document);
    expect(canonicalJsonSha256(TEST_AUTHORITY, document)).toBe(
      createHash('sha256').update(preimage, 'utf8').digest('hex'),
    );
    expect(
      canonicalJsonSha256(
        { domain: 'aquaculture.other-test-vector', schemaVersion: 'canonical-test/v1' },
        document,
      ),
    ).not.toBe(canonicalJsonSha256(TEST_AUTHORITY, document));
  });

  it('matches published SHA-256 vectors in the browser-safe implementation', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const payload = { fish: 'çipura', quantity: 12.5 };
    expect(mobileCommandPayloadSha256V1(payload)).toBe(
      canonicalJsonSha256(
        {
          domain: 'aquaculture.mobile-command-payload',
          schemaVersion: 'mobile-command-payload/v1',
        },
        createWireJsonDocumentV1(payload),
      ),
    );
  });
});
