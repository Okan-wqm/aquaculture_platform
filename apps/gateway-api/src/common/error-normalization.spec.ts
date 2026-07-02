import { toError } from './error-normalization';

describe('toError', () => {
  it('returns Error instances unchanged', () => {
    const original = new Error('boom');
    expect(toError(original)).toBe(original);
  });

  it('wraps string rejections in an Error', () => {
    const result = toError('boom');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('boom');
  });

  it('JSON-stringifies plain object rejections instead of producing [object Object]', () => {
    const result = toError({ code: 'ETIMEDOUT', attempt: 3 });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('{"code":"ETIMEDOUT","attempt":3}');
  });

  it('falls back to String() for values that cannot be JSON-stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = toError(circular);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(String(circular));
  });

  it('handles primitive non-string rejections', () => {
    expect(toError(42).message).toBe('42');
    // JSON.stringify(undefined) returns the undefined value (not a string),
    // so `new Error(undefined)` falls back to Error's own default: ''.
    expect(toError(undefined).message).toBe('');
    expect(toError(null).message).toBe('null');
  });
});
