/**
 * TagSubscriptionManager — teardown emits TAG_UNSUBSCRIBE (SENSOR-HIGH-042).
 *
 * The /scada socket is a shared singleton that stays connected across a
 * provider unmount. If reset() clears local ref-counts without telling the
 * server, the server strands the previously-active subscriptions and keeps
 * streaming tags no client wants. reset() must flush an unsubscribe for every
 * still-active server tag first.
 */
import { describe, it, expect, vi } from 'vitest';

import { TagSubscriptionManager } from '../TagSubscriptionManager';

describe('TagSubscriptionManager reset (SENSOR-HIGH-042)', () => {
  it('emits an unsubscribe for every active server tag on reset', () => {
    const onFlush = vi.fn<(sub: string[], unsub: string[]) => void>();
    const mgr = new TagSubscriptionManager(onFlush);

    mgr.subscribe('view-A', ['dev/temp', 'dev/level']);
    mgr.flushNow(); // tags now active on the server
    expect(onFlush).toHaveBeenLastCalledWith(['dev/temp', 'dev/level'], []);
    expect(mgr.getActiveSubscriptions().sort()).toEqual(['dev/level', 'dev/temp']);

    onFlush.mockClear();
    mgr.reset();

    // The teardown must have told the server to drop both tags.
    expect(onFlush).toHaveBeenCalledTimes(1);
    const [subscribed, unsubscribed] = onFlush.mock.calls[0];
    expect(subscribed).toEqual([]);
    expect(unsubscribed.sort()).toEqual(['dev/level', 'dev/temp']);

    // Local tracking is fully cleared.
    expect(mgr.getActiveSubscriptions()).toEqual([]);
  });

  it('does not emit on reset when nothing is active on the server', () => {
    const onFlush = vi.fn<(sub: string[], unsub: string[]) => void>();
    const mgr = new TagSubscriptionManager(onFlush);

    // Subscribe then unsubscribe before any flush: nothing ever reached the
    // server, so reset has nothing to tear down.
    mgr.subscribe('view-A', ['dev/temp']);
    mgr.unsubscribe('view-A');
    onFlush.mockClear();

    mgr.reset();

    expect(onFlush).not.toHaveBeenCalled();
  });
});
