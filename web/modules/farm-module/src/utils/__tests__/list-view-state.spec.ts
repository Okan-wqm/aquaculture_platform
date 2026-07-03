import { describe, expect, it } from 'vitest';

import { isBlockingError } from '../list-view-state';

describe('isBlockingError', () => {
  it('blocks only when there is an error AND no data to show (initial load failure)', () => {
    expect(isBlockingError(new Error('boom'), false)).toBe(true);
  });

  it('does NOT block when cached data exists — stale-on-error stays visible', () => {
    expect(isBlockingError(new Error('boom'), true)).toBe(false);
  });

  it('does NOT block when there is no error', () => {
    expect(isBlockingError(null, false)).toBe(false);
    expect(isBlockingError(undefined, true)).toBe(false);
  });
});
