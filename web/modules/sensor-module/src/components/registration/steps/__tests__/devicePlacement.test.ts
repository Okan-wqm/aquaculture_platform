import { describe, expect, it } from 'vitest';

import { devicePlacement } from '../devicePlacement';

describe('devicePlacement', () => {
  it('records a tank as the device’s tank, not as equipment', () => {
    expect(devicePlacement({ id: 't1', isTank: true })).toEqual({
      tankId: 't1',
      equipmentId: undefined,
    });
  });

  it('records non-tank water equipment as equipment', () => {
    expect(devicePlacement({ id: 'e1', isTank: false })).toEqual({
      tankId: undefined,
      equipmentId: 'e1',
    });
    expect(devicePlacement({ id: 'e2' })).toEqual({ tankId: undefined, equipmentId: 'e2' });
  });

  it('clears both when nothing is picked', () => {
    expect(devicePlacement(undefined)).toEqual({ tankId: undefined, equipmentId: undefined });
  });
});
