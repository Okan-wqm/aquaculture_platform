import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { parseStrictJson } from '../src/kernel/strict-json';

const digest = (value: unknown): string =>
  createHash('sha256').update(canonicalJsonBytes(value)).digest('hex');

describe('strict JSON', () => {
  it('decodes UTF-8 fatally and accepts only JSON whitespace', () => {
    expect(() => parseStrictJson(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
    expect(parseStrictJson(Buffer.from('\t {"a":1}\r\n'))).toEqual({ a: 1 });
    expect(() => parseStrictJson(Buffer.from('\u00a0{"a":1}'))).toThrow(/token/);
  });

  it.each(['{"a":1,"a":2}', '{"outer":{"a":1,"a":2}}', '{"a":1,"\\u0061":2}'])(
    'rejects duplicate decoded keys: %s',
    (source) => {
      expect(() => parseStrictJson(Buffer.from(source))).toThrow(/duplicate key/);
    },
  );

  it.each(['1.0', '1e2', '-0', '9007199254740992'])(
    'rejects non-canonical or unsafe number %s',
    (source) => expect(() => parseStrictJson(Buffer.from(source))).toThrow(/integer/),
  );

  it.each(['"\\uD800"', '"\\uDC00"', 'null trailing'])(
    'rejects invalid string or trailing content %s',
    (source) => expect(() => parseStrictJson(Buffer.from(source))).toThrow(),
  );

  it('sorts object keys recursively by Unicode code point', () => {
    const value = parseStrictJson(Buffer.from('{"z":{"😀":1,"a":2},"é":3,"a":4}'));
    expect(canonicalJsonBytes(value).toString()).toBe('{"a":4,"z":{"a":2,"😀":1},"é":3}');
  });

  it('orders BMP private-use before supplementary keys unlike UTF-16 default sort', () => {
    const supplementary = String.fromCodePoint(0x10000);
    expect(canonicalJsonBytes({ [supplementary]: 2, '\uE000': 1 }).toString()).toBe(
      `{"":1,"${supplementary}":2}`,
    );
  });

  it('is insertion-order independent without Unicode normalization', () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({ value: '\u00e9' })).not.toBe(digest({ value: 'e\u0301' }));
  });

  it('fails closed before recursive nesting can exhaust the call stack', () => {
    const source = `${'['.repeat(65)}0${']'.repeat(65)}`;
    expect(() => parseStrictJson(Buffer.from(source))).toThrow(/nesting limit/);
  });

  it('rejects documents beyond the bounded byte budget', () => {
    const source = JSON.stringify('x'.repeat(4 * 1024 * 1024));
    expect(() => parseStrictJson(Buffer.from(source))).toThrow(/byte limit/);
  });

  it('rejects excessively wide documents with bounded work', () => {
    const source = `[${Array.from({ length: 100_001 }, () => '0').join(',')}]`;
    expect(() => parseStrictJson(Buffer.from(source))).toThrow(/value limit/);
  });
});
