/**
 * toIntlLocale — the one map from a UI locale to the tag Intl formats with.
 *
 * Pages that format dates and numbers in the browser's own zone (the HR Today
 * page, the sensor command log) each carried a copy of this map; it now has
 * one owner beside SupportedLocale. Both tags render a 24-hour clock and
 * day-before-month order, and keep their own digit grouping.
 */
import { describe, expect, it } from 'vitest';

import { SUPPORTED_LOCALES, toIntlLocale } from '../localePreference';

describe('toIntlLocale', () => {
  it('maps each supported locale to its Intl tag', () => {
    expect(toIntlLocale('en')).toBe('en-GB');
    expect(toIntlLocale('tr')).toBe('tr-TR');
  });

  it('covers every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(() => new Intl.NumberFormat(toIntlLocale(locale))).not.toThrow();
    }
  });

  it('formats as each locale writes numbers and a 24-hour clock', () => {
    const at = new Date(Date.UTC(2026, 9, 16, 15, 4, 0));
    const clock = (locale: 'en' | 'tr'): string =>
      new Intl.DateTimeFormat(toIntlLocale(locale), {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
      }).format(at);
    expect(clock('en')).toBe('15:04');
    expect(clock('tr')).toBe('15:04');
    expect(new Intl.NumberFormat(toIntlLocale('en')).format(1234.5)).toBe('1,234.5');
    expect(new Intl.NumberFormat(toIntlLocale('tr')).format(1234.5)).toBe('1.234,5');
  });
});
