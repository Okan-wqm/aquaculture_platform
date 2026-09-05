/**
 * Platform-wide invariant — affected-lane quarantine is TRACKED debt:
 *
 * `scripts/ci/affected-target-policy.json` lets the affected CI lane run a
 * target as a warning instead of a gate for the projects it names. Every such
 * entry is a test (or lint) the PR gate does not enforce, and CLAUDE.md allows
 * exactly one shape for that: an owner, a deadline and a tracked finding.
 *
 * # WHY
 *
 * Until 2026-09-04 the `test` map held 19 bare strings — "CI run 26116890061:
 * existing unit-test debt" — for farm-service, sensor-service, auth-service,
 * admin-api-service and fourteen more. No owner, no clock, no finding, one
 * key naming a project that no longer existed. ci-full, the lane that used to
 * run those suites regardless, stopped running on pull requests, so the
 * quarantine silently became the whole story for those projects
 * (PROC-MEDIUM-025). lint-quarantine-ssot.spec.ts guarded the lint exclusion
 * file's reasons and ceiling; nothing guarded this file.
 *
 * # WHAT
 *
 * The entry shape is the one tests/invariants/invariant-reachability.dormant.json
 * already uses — `{ owner, reason, expires_on, finding_id }` — for EVERY
 * target, so there is one vocabulary for "a gate we are not running yet".
 * scripts/ci/write-affected-target-report.mjs refuses the file when an entry
 * is malformed or past its expiry (the lane fails closed); this spec locks
 * the file's contents, proves that refusal behaviourally, keeps every finding
 * id real and unresolved, keeps every key a real Nx project, and ratchets the
 * `test` quarantine count downward.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ORPHAN_MD_HEADING_REGEX } from '../../tools/gates/finding-registry-store';
import { nxProjects } from './helpers/nx';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'scripts/ci/affected-target-policy.json');
const WRITER_PATH = join(REPO_ROOT, 'scripts/ci/write-affected-target-report.mjs');
const REGISTRY_PATH = join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');
const ORPHAN_MD_PATH = join(REPO_ROOT, 'docs/reviews/orphan-findings.md');

/**
 * Ratchet: the number of projects whose `test` target the affected lane does
 * NOT gate. Lower it when a key is deleted; never raise it. Measured
 * 2026-09-04 by running all 18 quarantined suites: every one was green, so
 * the map emptied and this ceiling is zero (PROC-MEDIUM-025).
 */
const MAX_TEST_QUARANTINE = 0;

interface QuarantineEntry {
  readonly owner: string;
  readonly reason: string;
  readonly expires_on: string;
  readonly finding_id: string;
}

interface Policy {
  readonly version: number;
  readonly targets: Record<string, { readonly knownUnstableProjects: Record<string, unknown> }>;
}

function readPolicy(): Policy {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Policy;
}

function entries(): ReadonlyArray<{ target: string; project: string; entry: unknown }> {
  const out: { target: string; project: string; entry: unknown }[] = [];
  for (const [target, config] of Object.entries(readPolicy().targets)) {
    for (const [project, entry] of Object.entries(config.knownUnstableProjects)) {
      out.push({ target, project, entry });
    }
  }
  return out;
}

function isEntry(value: unknown): value is QuarantineEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['owner'] === 'string' &&
    candidate['owner'].trim().length > 0 &&
    typeof candidate['reason'] === 'string' &&
    candidate['reason'].trim().length >= 30 &&
    typeof candidate['expires_on'] === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(candidate['expires_on']) &&
    typeof candidate['finding_id'] === 'string' &&
    /^[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-\d{3}$/.test(candidate['finding_id'])
  );
}

/** Finding ids that still represent open debt: registry rows not RESOLVED, or orphan-store headings. */
function unresolvedFindingIds(): Set<string> {
  const ids = new Set<string>();
  for (const line of readFileSync(REGISTRY_PATH, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { id: string; state: string };
    if (row.state !== 'RESOLVED') ids.add(row.id);
  }
  for (const line of readFileSync(ORPHAN_MD_PATH, 'utf8').split('\n')) {
    const match = ORPHAN_MD_HEADING_REGEX.exec(line);
    if (match?.[1] && !/—\s*RESOLVED\b/.test(line)) ids.add(match[1]);
  }
  return ids;
}

function runWriter(policy: unknown): { status: number; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'affected-policy-'));
  try {
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    const affected = join(dir, 'affected.txt');
    writeFileSync(affected, 'invariants\n');
    const empty = join(dir, 'empty.txt');
    writeFileSync(empty, '');
    try {
      execFileSync(
        'node',
        [
          WRITER_PATH,
          '--target',
          'test',
          '--base',
          'base',
          '--head',
          'head',
          '--policy',
          policyPath,
          '--changed-files',
          empty,
          '--affected-projects',
          affected,
          '--explicit-excludes',
          empty,
          '--strict-projects',
          join(dir, 'strict.txt'),
          '--report',
          join(dir, 'report.json'),
          '--dry-run',
          'true',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      return { status: failure.status ?? 1, stderr: failure.stderr ?? '' };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const validEntry: QuarantineEntry = {
  owner: '@someone',
  reason: 'a reason that is long enough to explain the quarantine',
  expires_on: '2999-01-01',
  finding_id: 'INFRA-LOW-001',
};

function policyWith(entry: unknown): unknown {
  return { version: 2, targets: { test: { knownUnstableProjects: { invariants: entry } } } };
}

describe('affected-lane quarantine is tracked debt', () => {
  it('is on the structured-entry policy version', () => {
    expect(readPolicy().version).toBe(2);
  });

  it('gives every quarantined target an owner, a reason, an expiry and a finding', () => {
    const malformed = entries()
      .filter(({ entry }) => !isEntry(entry))
      .map(({ target, project }) => `${target}/${project}`);
    expect(malformed).toEqual([]);
  });

  it('lets no quarantine outlive its expiry', () => {
    // ISO strings sort lexicographically, so no timezone reasoning is needed:
    // an entry is expired the day after the date it names, everywhere.
    const today = new Date().toISOString().slice(0, 10);
    const expired = entries()
      .filter(({ entry }) => isEntry(entry) && entry.expires_on < today)
      .map(
        ({ target, project, entry }) =>
          `${target}/${project} (${(entry as QuarantineEntry).expires_on})`,
      );
    expect(expired).toEqual([]);
  });

  it('points every entry at a finding that still exists and is not resolved', () => {
    const open = unresolvedFindingIds();
    const dangling = entries()
      .filter(({ entry }) => isEntry(entry) && !open.has(entry.finding_id))
      .map(
        ({ target, project, entry }) =>
          `${target}/${project} -> ${(entry as QuarantineEntry).finding_id}`,
      );
    expect(dangling).toEqual([]);
  });

  it('names only projects that exist in the workspace', () => {
    const workspace = new Set(nxProjects());
    const vanished = entries()
      .filter(({ project }) => !workspace.has(project))
      .map(({ target, project }) => `${target}/${project}`);
    expect(vanished).toEqual([]);
  });

  it('ratchets the test quarantine downward', () => {
    const count = Object.keys(readPolicy().targets['test']?.knownUnstableProjects ?? {}).length;
    expect(count).toBeLessThanOrEqual(MAX_TEST_QUARANTINE);
  });

  describe('the report writer refuses a policy it cannot trust', () => {
    it('accepts a well-formed, unexpired entry', () => {
      expect(runWriter(policyWith(validEntry)).status).toBe(0);
    });

    it('refuses a bare reason string', () => {
      const result = runWriter(policyWith('CI run 26116890061: existing unit-test debt.'));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('entry must be an object');
    });

    it('refuses an expired entry', () => {
      const result = runWriter(policyWith({ ...validEntry, expires_on: '2020-01-01' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('expired 2020-01-01');
    });

    it('refuses an entry without a finding', () => {
      const result = runWriter(policyWith({ ...validEntry, finding_id: 'later' }));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('finding_id');
    });

    it('refuses the previous policy version outright', () => {
      const result = runWriter({ version: 1, targets: {} });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('version 1 is not 2');
    });
  });
});
