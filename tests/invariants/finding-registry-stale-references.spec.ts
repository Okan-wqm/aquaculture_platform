/**
 * ARIA-LOW-990 and the stale-text list of the MF-2 conformance audit (R14b) —
 * nothing a reader follows names the frozen segment as the registry, and no
 * live source credits machinery MF-2 deleted.
 *
 * ## Why
 *
 * Since MF-2 `docs/reviews/_registry/findings.jsonl` is the genesis segment: it
 * holds the findings registered before the freeze and nothing else. A finding
 * is read through `finding-registry project` and filed with `finding-registry
 * add`, which writes an event log under `findings/<PREFIX>/<ID>.jsonl`. Text
 * that still sends a reader to `findings.jsonl` has two failure modes:
 *
 *   - an agent told to read the open rulings from it sees only findings born
 *     before the freeze, and misses every later one;
 *   - a person told to file a finding under it (the fuzz crash issue's step 4)
 *     appends a row, and the genesis pin refuses the commit.
 *
 * Comments that credit a deleted mechanism (the seed script, the merge
 * driver's duplicate-id refusal, the `finding-registry` deep import of
 * backend-common) mislead the next reader the same way: they name a remedy or
 * an owner that no longer exists.
 *
 * ## What these tests pin
 *
 *   - a line under `.claude/` or `.github/workflows/` that names the registry
 *     file also says it is the frozen genesis segment;
 *   - no tracked source file outside the specs that pin the deletions, the
 *     archived migrations and the dated review records names a script, service
 *     or driver behaviour MF-2 deleted.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const THIS_SPEC = 'tests/invariants/finding-registry-stale-references.spec.ts';

/** `git grep -n` lines (`path:line:text`) of tracked files; exit 1 is no match, anything else is a failed scan. */
function gitGrep(pattern: string, pathspecs: readonly string[], extended = false): string[] {
  const result = spawnSync(
    'git',
    ['-C', REPO_ROOT, 'grep', '-n', extended ? '-E' : '-F', '-e', pattern, '--', ...pathspecs],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status === 1) return [];
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  return result.stdout.split('\n').filter(Boolean);
}

describe('ARIA-LOW-990 - guidance names the projection and the writer, not the frozen segment', () => {
  const REGISTRY_FILE = 'docs/reviews/_registry/findings.jsonl';
  const FROZEN = /frozen|genesis/i;

  it('the scan sees the guidance it is meant to judge', () => {
    // Guidance names the registry CLI throughout; a scan that matched none of it would prove nothing.
    expect(gitGrep('finding-registry', ['.claude', '.github/workflows']).length).toBeGreaterThan(5);
  });

  it('every line under .claude/ and .github/workflows/ that names findings.jsonl calls it the frozen genesis segment', () => {
    const unqualified = gitGrep(REGISTRY_FILE, ['.claude', '.github/workflows']).filter(
      (line) => !FROZEN.test(line),
    );
    expect(unqualified).toEqual([]);
  });
});

describe('MF-2 conformance audit - no live source credits machinery MF-2 deleted', () => {
  /** What MF-2 removed, by the name a comment would use. */
  const REMOVED = [
    'seed-finding-registry',
    'seed-claude-audit-findings',
    'patch-registry-phase2b',
    'seed-audit-findings',
    'migrate-schema-violations',
    'registry-rechain-after-squash',
    'backend-common/finding-registry',
    'FindingRegistryService',
    "merge driver's duplicate-id",
  ];

  /**
   * Code and instructions only. The registry's own rows, the review records and the plans are
   * history, the archived migrations are immutable, and the specs that pin a deletion must name it.
   */
  const LIVE_SOURCE = [
    'tests',
    'tools',
    'libs',
    'apps',
    'scripts',
    'aria-kernel',
    '.github',
    '.claude',
    ':(exclude,glob)**/.archive/**',
    ':(exclude)tests/invariants/registry-no-main-writer.spec.ts',
    `:(exclude)${THIS_SPEC}`,
  ];

  it('the scan sees the sources it is meant to judge', () => {
    expect(gitGrep('finding-registry', LIVE_SOURCE).length).toBeGreaterThan(20);
  });

  it('no tracked source names a script, service or driver behaviour MF-2 deleted', () => {
    const stale = REMOVED.flatMap((name) =>
      gitGrep(name, LIVE_SOURCE).map((line) => `${name}: ${line.slice(0, 160)}`),
    );
    expect(stale).toEqual([]);
  });
});
