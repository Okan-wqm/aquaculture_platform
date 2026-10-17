/**
 * Command values as the design writes figures (digest pages-new §0): each
 * locale's own decimal mark, and a negative value with the true minus sign
 * (U+2212), never the hyphen-minus Intl emits.
 */
import { describe, expect, it } from 'vitest';

import { formatCommandNumber } from '../commandFormat';

describe('formatCommandNumber', () => {
  it("writes each locale's decimal mark, up to three decimals", () => {
    expect(formatCommandNumber(42.5, 'en')).toBe('42.5');
    expect(formatCommandNumber(42.5, 'tr')).toBe('42,5');
    expect(formatCommandNumber(1.01234, 'en')).toBe('1.012');
  });

  it('writes a negative value with the minus sign U+2212', () => {
    expect(formatCommandNumber(-3.2, 'en')).toBe('−3.2');
    expect(formatCommandNumber(-3.2, 'tr')).toBe('−3,2');
    expect(formatCommandNumber(-3.2, 'en')).not.toContain('-');
  });
});
