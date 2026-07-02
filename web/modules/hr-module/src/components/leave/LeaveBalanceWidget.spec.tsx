import { describe, expect, it } from 'vitest';

import { sanitizeColor } from './LeaveBalanceWidget';

describe('LeaveBalanceWidget color policy', () => {
  it('accepts only hex colors from API data', () => {
    expect(sanitizeColor('#0ea5e9')).toBe('#0ea5e9');
    expect(sanitizeColor('#abc')).toBe('#abc');
  });

  it('falls back for non-color CSS payloads', () => {
    expect(sanitizeColor('red; background-image: url(//example.invalid)')).toBe('#6366f1');
    expect(sanitizeColor(undefined, '#111827')).toBe('#111827');
  });
});
