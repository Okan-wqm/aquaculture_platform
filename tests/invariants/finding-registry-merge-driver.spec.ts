/**
 * INVARIANT: the finding registry's merge driver is declared, registered,
 * and correct — including about what it refuses.
 *
 * Three failure modes, each of which has shipped in this repository:
 *
 *  1. A DECLARED-BUT-DEAD driver. `.gitattributes` pinned
 *     `docs/aria/CURRENT_STATE.md merge=ours` with a full written rationale,
 *     and nothing in the repo ever ran `git config merge.ours.driver`. `ours`
 *     is not a git built-in, so git fell back to the default text merge and
 *     the pin never once took effect. The parity test below makes that state
 *     unreachable: every `merge=<name>` attribute must name a built-in or a
 *     key in `tools/gates/git-merge-drivers.json`, and the `prepare` script
 *     must run the installer that registers them.
 *
 *  2. A MERGE THAT RESOLVES WHAT IT SHOULD NOT. The registry is an audit
 *     ledger; a driver that silently picks a side would be indistinguishable
 *     from tampering. So the refusals are tested as hard as the resolutions:
 *     a deleted row, a reordered row, the same finding decided differently
 *     on both sides, and a duplicate id across two branches all have to come
 *     back as conflicts, not as answers.
 *
 *  3. A MERGE THAT LEAVES A BROKEN CHAIN. The end-to-end case re-creates the
 *     exact 2026-09-11 shape — upstream closes findings and rechains
 *     everything after them, the branch appends one row — and asserts the
 *     merged ledger verifies, keeps upstream's closures, and keeps the
 *     branch's row as the tail.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  type Finding,
  parseRegistryJsonl,
  rechain,
  serializeRegistryJsonl,
  verify,
} from '../../tools/gates/finding-registry-chain';
import { mergeAppendOnlyRegistry } from '../../tools/gates/finding-registry-merge';

const REPO_ROOT = resolve(process.cwd());
const REGISTRY_RELATIVE_PATH = 'docs/reviews/_registry/findings.jsonl';
const DRIVER_MANIFEST_PATH = join(REPO_ROOT, 'tools/gates/git-merge-drivers.json');
const INSTALLER_RELATIVE_PATH = 'tools/gates/install-git-merge-drivers.mjs';

/** Drivers git implements itself; they need no config entry. */
const GIT_BUILTIN_MERGE_DRIVERS = new Set(['text', 'binary', 'union']);

interface MergeDriverSpec {
  readonly name: string;
  readonly driver: string;
}

function readDriverManifest(): Record<string, MergeDriverSpec> {
  const parsed: unknown = JSON.parse(readFileSync(DRIVER_MANIFEST_PATH, 'utf8'));
  const drivers = (parsed as { drivers?: unknown }).drivers;
  if (drivers === null || typeof drivers !== 'object') {
    throw new Error(`Merge driver manifest has no "drivers" object: ${DRIVER_MANIFEST_PATH}`);
  }
  return drivers as Record<string, MergeDriverSpec>;
}

function gitAttributeMergeDrivers(): Array<{ pattern: string; driver: string }> {
  const raw = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  const pins: Array<{ pattern: string; driver: string }> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^(\S+)\s+(.*)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;
    const merge = /(?:^|\s)merge=(\S+)/.exec(match[2]);
    if (!merge?.[1]) continue;
    pins.push({ pattern: match[1], driver: merge[1] });
  }
  return pins;
}

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: 'HIGH',
    state: 'OPEN',
    title: `synthetic ${id}`,
    owner_agent: 'admin-expert',
    raised_in_cycle: '2026-09-05-superadmin-audit',
    created_at: '2026-09-05T00:00:00Z',
    closed_at: null,
    closing_commits: [],
    deadline: null,
    owner_user: null,
    override_of: null,
    prev_hash: '0'.repeat(64),
    content_hash: '0'.repeat(64),
    ...overrides,
  };
}

/** A chained ledger, as it would exist on disk. */
function ledger(
  ids: readonly string[],
  overrides: Record<string, Partial<Finding>> = {},
): Finding[] {
  const entries = ids.map((id) => finding(id, overrides[id] ?? {}));
  rechain(entries, 0);
  return entries;
}

function closeRow(entries: readonly Finding[], id: string, sha: string): Finding[] {
  const next = entries.map((entry) => ({ ...entry }));
  const index = next.findIndex((entry) => entry.id === id);
  const target = next[index];
  if (!target) throw new Error(`no such row: ${id}`);
  target.state = 'RESOLVED';
  target.closed_at = '2026-09-10T12:00:00Z';
  target.closing_commits = [sha];
  rechain(next, index);
  return next;
}

function appendRow(entries: readonly Finding[], id: string): Finding[] {
  const next = [...entries.map((entry) => ({ ...entry })), finding(id)];
  rechain(next, next.length - 1);
  return next;
}

describe('INVARIANT: finding registry merge driver', () => {
  it('declares no merge driver that nothing registers', () => {
    const manifest = readDriverManifest();
    const unregistered = gitAttributeMergeDrivers()
      .filter(
        (pin) => !GIT_BUILTIN_MERGE_DRIVERS.has(pin.driver) && manifest[pin.driver] === undefined,
      )
      .map(
        (pin) =>
          `${pin.pattern} declares merge=${pin.driver}, which is neither a git built-in ` +
          `(${[...GIT_BUILTIN_MERGE_DRIVERS].join(', ')}) nor a key in tools/gates/git-merge-drivers.json — ` +
          'git will silently fall back to its text merge and the pin will never take effect',
      );
    expect(unregistered).toEqual([]);
  });

  it('registers the declared drivers from the prepare script', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const prepare = (pkg as { scripts?: Record<string, string> }).scripts?.prepare ?? '';
    expect(prepare).toContain(INSTALLER_RELATIVE_PATH);
  });

  it('pins the registry itself to the append-only driver', () => {
    const pin = gitAttributeMergeDrivers().find(
      (entry) => entry.pattern === REGISTRY_RELATIVE_PATH,
    );
    expect(pin?.driver).toBe('findings-registry');
    expect(readDriverManifest()['findings-registry']?.driver).toContain(
      'finding-registry-merge-driver.ts',
    );
  });

  describe('the append-only three-way merge', () => {
    it('merges an upstream closure rechain with a branch append', () => {
      // The 2026-09-11 shape: upstream closed a row in the middle, which
      // rechained every row after it, while the branch appended one row.
      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002', 'ADMIN-HIGH-003']);
      const theirs = closeRow(base, 'ADMIN-HIGH-002', 'abc123456789');
      const ours = appendRow(base, 'ADMIN-HIGH-004');

      const result = mergeAppendOnlyRegistry(base, ours, theirs);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.entries.map((entry) => entry.id)).toEqual([
        'ADMIN-HIGH-001',
        'ADMIN-HIGH-002',
        'ADMIN-HIGH-003',
        'ADMIN-HIGH-004',
      ]);
      // Upstream's decision survives, and so does the branch's row.
      expect(result.entries[1]?.state).toBe('RESOLVED');
      expect(result.entries[1]?.closing_commits).toEqual(['abc123456789']);
      expect(result.entries[3]?.id).toBe('ADMIN-HIGH-004');
      expect(verify(result.entries).ok).toBe(true);
      expect(result.addedFrom).toEqual({ ours: 1, theirs: 0 });
    });

    it('puts upstream additions before the branch tail', () => {
      const base = ledger(['ADMIN-HIGH-001']);
      const theirs = appendRow(base, 'SENSOR-HIGH-063');
      const ours = appendRow(base, 'ADMIN-HIGH-135');

      const result = mergeAppendOnlyRegistry(base, ours, theirs);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.entries.map((entry) => entry.id)).toEqual([
        'ADMIN-HIGH-001',
        'SENSOR-HIGH-063',
        'ADMIN-HIGH-135',
      ]);
      expect(verify(result.entries).ok).toBe(true);
    });

    it('leaves an unchanged prefix byte-identical', () => {
      // The chain is a pure function of (contents, order), so rechaining a
      // merge must not perturb rows neither side touched.
      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002']);
      const ours = appendRow(base, 'ADMIN-HIGH-003');
      const result = mergeAppendOnlyRegistry(base, ours, base);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(serializeRegistryJsonl(result.entries.slice(0, 2))).toBe(serializeRegistryJsonl(base));
    });

    it('is a no-op when only upstream moved', () => {
      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002']);
      const theirs = closeRow(base, 'ADMIN-HIGH-001', 'abc123456789');
      const result = mergeAppendOnlyRegistry(base, base, theirs);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(serializeRegistryJsonl(result.entries)).toBe(serializeRegistryJsonl(theirs));
    });

    it('refuses a deleted row', () => {
      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002']);
      const ours = [{ ...(base[0] as Finding) }];
      const result = mergeAppendOnlyRegistry(base, ours, base);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('deleted');
    });

    it('refuses a reordered row', () => {
      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002']);
      const reordered = [{ ...(base[1] as Finding) }, { ...(base[0] as Finding) }];
      rechain(reordered, 0);
      const result = mergeAppendOnlyRegistry(base, reordered, base);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('reordered');
    });

    it('refuses the same finding decided differently on both sides', () => {
      const base = ledger(['ADMIN-HIGH-001']);
      const theirs = closeRow(base, 'ADMIN-HIGH-001', 'aaaaaaaaaaaa');
      const ours = closeRow(base, 'ADMIN-HIGH-001', 'bbbbbbbbbbbb');
      const result = mergeAppendOnlyRegistry(base, ours, theirs);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('changed differently on both sides');
    });

    it('accepts the same finding decided identically on both sides', () => {
      const base = ledger(['ADMIN-HIGH-001']);
      const closed = closeRow(base, 'ADMIN-HIGH-001', 'aaaaaaaaaaaa');
      const result = mergeAppendOnlyRegistry(base, closed, closed);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(serializeRegistryJsonl(result.entries)).toBe(serializeRegistryJsonl(closed));
    });

    it('refuses two branches that minted the same id', () => {
      const base = ledger(['ADMIN-HIGH-001']);
      const theirs = appendRow(base, 'ADMIN-HIGH-002');
      const ours = appendRow(base, 'ADMIN-HIGH-002');
      const result = mergeAppendOnlyRegistry(base, ours, theirs);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('duplicate finding id ADMIN-HIGH-002');
    });
  });

  describe('driven by git', () => {
    const git = (repo: string, args: readonly string[]): string =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'invariant',
          GIT_AUTHOR_EMAIL: 'invariant@example.com',
          GIT_COMMITTER_NAME: 'invariant',
          GIT_COMMITTER_EMAIL: 'invariant@example.com',
        },
      }).toString();

    const writeLedger = (repo: string, entries: readonly Finding[]): void => {
      const target = join(repo, REGISTRY_RELATIVE_PATH);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serializeRegistryJsonl(entries), 'utf8');
    };

    it('resolves the real shape without a conflict, and refuses a real one', () => {
      const repo = mkdtempSync(join(tmpdir(), 'findings-merge-driver-'));
      git(repo, ['init', '-q', '-b', 'main']);
      // The driver is registered with absolute paths because the merge runs
      // in this throwaway repo, not in the checkout that owns the script.
      const manifest = readDriverManifest();
      const driverCommand = (manifest['findings-registry']?.driver ?? '').replace(
        /tools\/gates\//g,
        `${REPO_ROOT}/tools/gates/`,
      );
      git(repo, ['config', '--local', 'merge.findings-registry.driver', driverCommand]);
      writeFileSync(
        join(repo, '.gitattributes'),
        `${REGISTRY_RELATIVE_PATH} merge=findings-registry\n`,
        'utf8',
      );

      const base = ledger(['ADMIN-HIGH-001', 'ADMIN-HIGH-002', 'ADMIN-HIGH-003']);
      writeLedger(repo, base);
      git(repo, ['add', '-A']);
      git(repo, ['commit', '-q', '-m', 'chore: seed the ledger']);

      git(repo, ['checkout', '-q', '-b', 'branch']);
      writeLedger(repo, appendRow(base, 'ADMIN-HIGH-135'));
      git(repo, ['commit', '-q', '-a', '-m', 'chore: branch appends a finding']);

      git(repo, ['checkout', '-q', 'main']);
      writeLedger(repo, closeRow(base, 'ADMIN-HIGH-002', 'abc123456789'));
      git(repo, ['commit', '-q', '-a', '-m', 'chore: upstream closes a finding']);

      git(repo, ['checkout', '-q', 'branch']);
      // No conflict: this is the whole point of the driver.
      git(repo, ['merge', '-q', '--no-edit', 'main']);

      const merged = parseRegistryJsonl(readFileSync(join(repo, REGISTRY_RELATIVE_PATH), 'utf8'));
      expect(merged.map((entry) => entry.id)).toEqual([
        'ADMIN-HIGH-001',
        'ADMIN-HIGH-002',
        'ADMIN-HIGH-003',
        'ADMIN-HIGH-135',
      ]);
      expect(merged[1]?.state).toBe('RESOLVED');
      expect(verify(merged).ok).toBe(true);
      expect(git(repo, ['status', '--porcelain']).trim()).toBe('');

      // And a genuine conflict still stops the merge, with markers on disk.
      const afterMerge = merged;
      git(repo, ['checkout', '-q', '-b', 'divergent', 'main']);
      writeLedger(repo, closeRow(afterMerge.slice(0, 3), 'ADMIN-HIGH-003', 'cccccccccccc'));
      git(repo, ['commit', '-q', '-a', '-m', 'chore: upstream closes 003']);
      git(repo, ['checkout', '-q', 'main']);
      writeLedger(repo, closeRow(afterMerge.slice(0, 3), 'ADMIN-HIGH-003', 'dddddddddddd'));
      git(repo, ['commit', '-q', '-a', '-m', 'chore: main closes 003 differently']);

      let refused = false;
      try {
        git(repo, ['merge', '-q', '--no-edit', 'divergent']);
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      expect(readFileSync(join(repo, REGISTRY_RELATIVE_PATH), 'utf8')).toContain('<<<<<<<');
    }, 60_000);
  });
});
