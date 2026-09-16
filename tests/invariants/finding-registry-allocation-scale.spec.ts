/**
 * The registry allocator sweeps every active worktree's registry to refuse
 * a duplicate id. On 2026-09-13 that sweep was 98 worktrees × ~1,600 rows
 * and `claimed.push(...ids)` — one argument per id — overflowed V8's call
 * stack, so EVERY registry mutation (`add`, `add-explicit`, `close`,
 * `sweep`) failed closed under the authority's own catch with
 * "Maximum call stack size exceeded". A gate that cannot run is a gate
 * that blocks every finding, so the sweep must scale with the worktree
 * count: this pins `claimedIdsForDomain` over an authority reporting more
 * ids than a spread call can carry.
 */
import { claimedIdsForDomain } from '../../tools/gates/finding-registry';

describe('finding registry allocation scale', () => {
  it('claims ids from more active registries than a spread call can carry', () => {
    // Well past V8's argument ceiling (~65k–125k depending on the frame).
    const perRegistry = 2_000;
    const registries = 100;
    const registryIds = Array.from({ length: registries }, (_, r) =>
      Array.from(
        { length: perRegistry },
        (_, i) => `ARIA-HIGH-${String(r * perRegistry + i + 1).padStart(3, '0')}`,
      ),
    );
    const readRegistry = jest.fn((registryPath: string): ReadonlyArray<string> => {
      const index = Number.parseInt(registryPath.slice(registryPath.lastIndexOf('/') + 1), 10);
      return registryIds[index] ?? [];
    });
    // The authority names one path per worktree; the ids behind each path are
    // what the sweep concatenates. Only the concatenation is under test, so
    // the registry read is injected through the ids each path resolves to.
    const authority = {
      lockPath: '/dev/null/finding-registry-v1.lock',
      reservationPath: '/dev/null/finding-id-reservations-v1.json',
      activeRegistryPaths: () => registryIds.map((_, index) => `/dev/null/registries/${index}`),
    };
    const claimed = claimedIdsForDomain('ARIA', [{ id: 'ARIA-HIGH-000' }], authority, {
      readIds: readRegistry,
    });
    expect(claimed.length).toBe(1 + registries * perRegistry);
    expect(claimed[claimed.length - 1]).toBe(`ARIA-HIGH-${registries * perRegistry}`);
    expect(readRegistry).toHaveBeenCalledTimes(registries);
  });
});
