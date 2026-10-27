/**
 * Build skew (FE-MEDIUM-380, PKG-42): an open tab compares every build it runs — the shell and
 * each remote it has loaded — with the build the server serves for it, on focus, on navigation
 * and on a GraphQL validation failure, and reloads when any differs, at a moment no typed input
 * is lost.
 *
 * - a release that rebuilds only a remote reloads the tab too: frontend images are built per
 *   affected project, so the shell's id alone stays the same while the tab's copy of the remote
 *   asks for chunks its container no longer has;
 * - navigation and a validation failure reload at once: an old build is about to fetch a chunk
 *   that no longer exists, or its documents already fail against the new schema;
 * - focus only learns of the new build; the next navigation reloads without asking again, so a
 *   form the user left half-filled survives the return to the tab;
 * - the server is asked at most once per interval on focus and navigation, never more than once
 *   at a time, and always on a validation failure;
 * - a reload toward a target happens once: an edge that keeps serving an old document or entry
 *   cannot make the tab reload in a loop.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BUILD_SKEW_CHECK_INTERVAL_MS,
  BUILD_SKEW_RELOAD_MARKER,
  createBuildSkewMonitor,
  type BuildSkewDeps,
  type BuildSkewStorage,
  type RunningBuildPart,
} from '../buildSkew';

const SHELL_MANIFEST = 'https://app.example/build-manifest.json';
const FARM_MANIFEST = 'https://app.example/remotes/farm-module/build-manifest.json';
const RUNNING = '1'.repeat(64);
const SERVED = '2'.repeat(64);
const NEWER = '3'.repeat(64);
const FARM_RUNNING = '4'.repeat(64);
const FARM_SERVED = '5'.repeat(64);

const SHELL: RunningBuildPart = { manifestUrl: SHELL_MANIFEST, buildId: RUNNING };
const FARM: RunningBuildPart = { manifestUrl: FARM_MANIFEST, buildId: FARM_RUNNING };

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

type FetchServed = (manifestUrl: string) => Promise<string | null>;

interface Harness {
  readonly deps: BuildSkewDeps;
  readonly fetchServedBuildId: ReturnType<typeof vi.fn<FetchServed>>;
  readonly reload: ReturnType<typeof vi.fn<() => void>>;
  readonly storage: ReturnType<typeof memoryStorage>;
  /** The parts the tab runs; a test loads a remote by pushing one. */
  readonly parts: RunningBuildPart[];
  advance(ms: number): void;
}

/** `served` maps a manifest URL to what the server serves there (absent: unknown). */
function harness(
  served: Record<string, string | null> = { [SHELL_MANIFEST]: SERVED },
  overrides: Partial<BuildSkewDeps> = {},
): Harness {
  let clock = 1_000_000;
  const parts: RunningBuildPart[] = [SHELL];
  const fetchServedBuildId = vi.fn<FetchServed>((manifestUrl) =>
    Promise.resolve(served[manifestUrl] ?? null),
  );
  const reload = vi.fn<() => void>();
  const storage = memoryStorage();
  return {
    fetchServedBuildId,
    reload,
    storage,
    parts,
    advance: (ms) => {
      clock += ms;
    },
    deps: {
      runningParts: () => parts,
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

  it('reloads on navigation when the server serves another shell build', async () => {
    await createBuildSkewMonitor(h.deps).check('navigation');
    expect(h.reload).toHaveBeenCalledTimes(1);
    expect(h.storage.values.get(BUILD_SKEW_RELOAD_MARKER)).toBe(`${SHELL_MANIFEST}=${SERVED}`);
  });

  it('does not reload while the server serves every build the tab runs', async () => {
    const same = harness({ [SHELL_MANIFEST]: RUNNING, [FARM_MANIFEST]: FARM_RUNNING });
    same.parts.push(FARM);
    const monitor = createBuildSkewMonitor(same.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(same.reload).not.toHaveBeenCalled();
  });

  it('reloads when only a loaded remote was redeployed and the shell build is unchanged', async () => {
    const remoteOnly = harness({ [SHELL_MANIFEST]: RUNNING, [FARM_MANIFEST]: FARM_SERVED });
    remoteOnly.parts.push(FARM);
    await createBuildSkewMonitor(remoteOnly.deps).check('validation-failure');
    expect(remoteOnly.reload).toHaveBeenCalledTimes(1);
    expect(remoteOnly.storage.values.get(BUILD_SKEW_RELOAD_MARKER)).toBe(
      `${FARM_MANIFEST}=${FARM_SERVED}`,
    );
  });

  it('asks the server for the shell and for each loaded remote, each at its own manifest', async () => {
    h.parts.push(FARM);
    await createBuildSkewMonitor(h.deps).check('navigation');
    expect(h.fetchServedBuildId.mock.calls.map(([url]) => url)).toEqual([
      SHELL_MANIFEST,
      FARM_MANIFEST,
    ]);
  });

  it('never asks about a remote the tab has not loaded: it will load the served build', async () => {
    const shellOnly = harness({ [SHELL_MANIFEST]: RUNNING, [FARM_MANIFEST]: FARM_SERVED });
    await createBuildSkewMonitor(shellOnly.deps).check('navigation');
    expect(shellOnly.fetchServedBuildId).toHaveBeenCalledTimes(1);
    expect(shellOnly.reload).not.toHaveBeenCalled();
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

  it('does nothing while the tab knows none of its builds (the dev server)', async () => {
    const dev = harness();
    dev.parts.splice(0);
    const monitor = createBuildSkewMonitor(dev.deps);
    await monitor.check('focus');
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(dev.fetchServedBuildId).not.toHaveBeenCalled();
    expect(dev.reload).not.toHaveBeenCalled();
  });

  it('does not reload when the served builds cannot be read', async () => {
    const unknown = harness({});
    unknown.parts.push(FARM);
    const monitor = createBuildSkewMonitor(unknown.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(unknown.reload).not.toHaveBeenCalled();
  });

  it('reloads for a part that differs even when another part cannot be read', async () => {
    const partial = harness({ [SHELL_MANIFEST]: null, [FARM_MANIFEST]: FARM_SERVED });
    partial.parts.push(FARM);
    await createBuildSkewMonitor(partial.deps).check('navigation');
    expect(partial.reload).toHaveBeenCalledTimes(1);
  });

  it('asks the server at most once per interval on focus and navigation', async () => {
    const same = harness({ [SHELL_MANIFEST]: RUNNING });
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
    const same = harness({ [SHELL_MANIFEST]: RUNNING });
    const monitor = createBuildSkewMonitor(same.deps);
    await monitor.check('navigation');
    await monitor.check('validation-failure');
    expect(same.fetchServedBuildId).toHaveBeenCalledTimes(2);
  });

  it('shares one round of requests between checks that overlap', async () => {
    let answer: (id: string | null) => void = () => undefined;
    const slow = harness(
      {},
      {
        fetchServedBuildId: vi.fn<FetchServed>(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        ),
      },
    );
    const monitor = createBuildSkewMonitor(slow.deps);
    const first = monitor.check('validation-failure');
    const second = monitor.check('validation-failure');
    answer(SERVED);
    await Promise.all([first, second]);
    expect(slow.deps.fetchServedBuildId).toHaveBeenCalledTimes(1);
    expect(slow.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads toward a target once: landing on the old build again does not loop', async () => {
    // The tab already reloaded toward SERVED and still runs RUNNING (the edge served the old
    // document again): it must not reload toward SERVED a second time.
    const looped = harness(undefined, {
      storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: `${SHELL_MANIFEST}=${SERVED}` }),
    });
    await createBuildSkewMonitor(looped.deps).check('navigation');
    expect(looped.reload).not.toHaveBeenCalled();
  });

  it('still reloads toward a newer build than the one it once reloaded toward', async () => {
    const newer = harness(
      { [SHELL_MANIFEST]: NEWER },
      { storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: `${SHELL_MANIFEST}=${SERVED}` }) },
    );
    await createBuildSkewMonitor(newer.deps).check('navigation');
    expect(newer.reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when a remote it loaded later differs after a reload toward the shell', async () => {
    const later = harness(
      { [SHELL_MANIFEST]: RUNNING, [FARM_MANIFEST]: FARM_SERVED },
      { storage: memoryStorage({ [BUILD_SKEW_RELOAD_MARKER]: `${SHELL_MANIFEST}=${RUNNING}` }) },
    );
    later.parts.push(FARM);
    await createBuildSkewMonitor(later.deps).check('navigation');
    expect(later.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads without storage for the once-per-target guard', async () => {
    const noStorage = harness(undefined, { storage: null });
    await createBuildSkewMonitor(noStorage.deps).check('navigation');
    expect(noStorage.reload).not.toHaveBeenCalled();
  });
});
