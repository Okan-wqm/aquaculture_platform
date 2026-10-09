import { describe, expect, it } from 'vitest';

import { quantityLabel } from '../quantities';

describe('quantityLabel', () => {
  it('names a registry quantity by its basis and unit', () => {
    expect(quantityLabel('tan')).toBe('tan — total ammonia as N, mg/L');
    expect(quantityLabel('temperature')).toBe('temperature — °C');
    expect(quantityLabel('mystery')).toBe('mystery');
  });
});
