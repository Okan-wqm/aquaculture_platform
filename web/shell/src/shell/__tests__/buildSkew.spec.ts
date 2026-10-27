/**
 * Build skew (FE-MEDIUM-380, PKG-42): an open tab compares the build it runs with the build the
 * server serves, on focus, on navigation and on a GraphQL validation failure, and reloads when
 * they differ, at a moment no typed input is lost.
 *
 * - navigation and a validation failure reload at once: the old build is about to fetch a chunk
 *   that no longer exists, or its documents already fail against the new schema;
 * - focus only learns of the new build; the next navigation reloads without asking again, so a
 *   form the user left half-filled survives the return to the tab;
 * - the server is asked at most once per interval on focus and navigation, never more than once
 *   at a time, and always on a validation failure;
 * - a reload toward a build happens once per tab: an edge that keeps serving the old document
 *   cannot make the tab reload in a loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILD_SKEW_CHECK_INTERVAL_MS,
  BUILD_SKEW_RELOAD_MARKER,
  createBuildSkewMonitor,
  type BuildSkewDeps,
  type BuildSkewStorage,
} from '../buildSkew';

const RUNNING = '1'.repeat(64);
const SERVED = '2'.repeat(64);
const NEWER = '3'.repeat(64);

function memoryStorage(initial: Record<string, string> = {}): BuildSkewStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

interface Harness {
  readonly deps: BuildSkewDeps;
  readonly fetchServedBuildId: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  readonly reload: ReturnType<typeof vi.fn<() => void>>;
  readonly storage: ReturnType<typeof memoryStorage>;
  advance(ms: number): void;
}

function harness(overrides: Partial<BuildSkewDeps> = {}, served: string | null = SERVED): Harness {
  let clock = 1_000_000;
  const fetchServedBuildId = vi.fn<() => Promise<string | null>>(() => Promise.resolve(served));
  const reload = vi.fn<() => void>();
  const storage = memoryStorage();
  return {
    fetchServedBuildId,
    reload,
    storage,
    advance: (ms) => {
      clock += ms;
    },
    deps: {
      runningBuildId: RUNNING,
      fetchServedBuildId,
      reload,
      now: () => clock,
      storage,
      ...overrides,
    },
  };
}

describe('createBuildSkewMonitor', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('reloads on navigation when the server serves another build', async () => {
    await createBuildSkewMonitor(h.deps).check('navigation');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.storage.values.get(BUILD_SKEW_RELOAD_MARKER)).toBe(SERVED);
  });

  it('does not reload while the server serves the running build', async () => {
    const same = harness({}, RUNNING);
    const monitor = createBuildSkewMonitor(same.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(same.reload).not.toHaveBeenCalled();
  });

  it('reloads on a GraphQL validation failure when the server serves another build', async () => {
    await createBuildSkewMonitor(h.deps).check('validation-failure');
    expect(h.reload).toHaveBeenCalledTimes(1);
  });

  it('on focus learns of the new build without reloading; the next navigation reloads without asking again', async () => {
    const monitor = createBuildSkewMonitor(h.deps);
    await monitor.check('focus');
    expect(h.reload).not.toHaveBeenCalled();
    expect(h.fetchServedBuildId).toHaveBeenCalledTimes(1);

    await monitor.check('navigation');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.fetchServedBuildId).toHaveBeenCalledTimes(1);
  });

  it('does nothing in a document that names no build (the dev server)', async () => {
    const dev = harness({ runningBuildId: null });
    const monitor = createBuildSkewMonitor(dev.deps);
    await monitor.check('focus');
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(dev.fetchServedBuildId).not.toHaveBeenCalled();
    expect(dev.reload).not.toHaveBeenCalled();
  });

  it('does not reload when the served build cannot be read', async () => {
    const unknown = harness({}, null);
    const monitor = createBuildSkewMonitor(unknown.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(unknown.reload).not.toHaveBeenCalled();
  });

  it('asks the server at most once per interval on focus and navigation', async () => {
    const same = harness({}, RUNNING);
    const monitor = createBuildSkewMonitor(same.deps);
    await monitor.check('focus');
    await monitor.check('navigation');
    await monitor.check('focus');
    expect(same.fetchServedBuildId).toHaveBeenCalledTimes(1);

    same.advance(BUILD_SKEW_CHECK_INTERVAL_MS);
    await monitor.check('navigation');
    expect(same.fetchServedBuildId).toHaveBeenCalledTimes(2);
  });

  it('asks the server on every validation failure, inside the interval too', async () => {
    const same = harness({}, RUNNING);
    const monitor = createBuildSkewMonitor(same.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(same.fetchServedBuildId).toHaveBeenCalledTimes(2);
  });

  it('shares one request between checks that overlap', async () => {
    let answer: (id: string | null) => void = () => undefined;
    const slow = harness({
      fetchServedBuildId: vi.fn<() => Promise<string | null>>(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      ),
    });
    const monitor = createBuildSkewMonitor(slow.deps);
    const first = monitor.check('validation-failure');
    const second = monitor.check('validation-failure');
    answer(SERVED);
    await Promise.all([first, second]);
    expect(slow.deps.fetchServedBuildId).toHaveBeenCalledTimes(1);
    expect(slow.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads toward a build once per tab: landing on the old build again does not loop', async () => {
    // The tab already reloaded toward SERVED and still runs RUNNING (the edge served the old
    // document again): it must not reload toward SERVED a second time.
    const looped = harness({ storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: SERVED }) });
    await createBuildSkewMonitor(looped.deps).check('navigation');
    expect(looped.reload).not.toHaveBeenCalled();
  });

  it('still reloads toward a newer build than the one it once reloaded toward', async () => {
    const newer = harness(
      { storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: SERVED }) },
      NEWER,
    );
    await createBuildSkewMonitor(newer.deps).check('navigation');
    expect(newer.reload).toHaveBeenCalledTimes(1);
  });

  it('clears the marker once the tab runs the build it reloaded toward', () => {
    const arrived = harness({
      runningBuildId: SERVED,
      storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: SERVED }),
    });
    createBuildSkewMonitor(arrived.deps);
    expect(arrived.deps.storage?.getItem(BUILD_SKEW_RELOAD_MARKER)).toBeNull();
  });

  it('never reloads without storage for the once-per-tab guard', async () => {
    const noStorage = harness({ storage: null });
    await createBuildSkewMonitor(noStorage.deps).check('navigation');
    expect(noStorage.reload).not.toHaveBeenCalled();
  });
});
