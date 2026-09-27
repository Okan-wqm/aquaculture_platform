import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  announceUpdate,
  dismissUpdate,
  getUpdateSnapshot,
  subscribeUpdate,
} from '../update-available';

describe('update-available store', () => {
  beforeEach(() => {
    dismissUpdate();
  });

  it('starts idle', () => {
    expect(getUpdateSnapshot()).toEqual({ available: false, apply: null });
  });

  it('announceUpdate exposes the apply action and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpdate(listener);
    const apply = vi.fn();

    announceUpdate(apply);

    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = getUpdateSnapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.apply).toBe(apply);
    unsubscribe();
  });

  it('dismissUpdate returns to idle and is a no-op when already idle', () => {
    const listener = vi.fn();
    subscribeUpdate(listener);
    announceUpdate(vi.fn());
    dismissUpdate();
    expect(getUpdateSnapshot().available).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    dismissUpdate();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('unsubscribed listeners are not notified', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpdate(listener);
    unsubscribe();
    announceUpdate(vi.fn());
    expect(listener).not.toHaveBeenCalled();
  });
});
