import { describe, expect, it } from 'vitest';

import { __test } from '../featureFlags';

const { readBoolFlag } = __test;

describe('featureFlags.readBoolFlag', () => {
  it('returns the default when the env var is unset/empty', () => {
    expect(readBoolFlag(undefined, true)).toBe(true);
    expect(readBoolFlag(undefined, false)).toBe(false);
    expect(readBoolFlag('', true)).toBe(true);
    expect(readBoolFlag(null, false)).toBe(false);
  });

  it('treats false/0/off/no (any case) as false', () => {
    for (const v of ['false', 'FALSE', '0', 'off', 'Off', 'no', 'NO']) {
      expect(readBoolFlag(v, true)).toBe(false);
    }
  });

  it('treats any other non-empty value as true', () => {
    for (const v of ['true', '1', 'on', 'yes', 'enabled']) {
      expect(readBoolFlag(v, false)).toBe(true);
    }
  });
});
