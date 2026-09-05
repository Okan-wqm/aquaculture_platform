/**
 * CI quarantine is governed debt, not prose (ADR-0017).
 *
 * `scripts/ci/affected-target-policy.json` decides which projects the affected
 * lane does NOT lint or test. Until 2026-09-05 every entry was an opaque string
 * ("CI run 26116890061: existing unit-test debt …") with no owner, no expiry
 * and no finding — and the stated reason for quarantining admin-api-service
 * and admin-panel from `test` was false: both passed (920 + 132 tests).
 *
 * The primary gate is the consumer: `write-affected-target-report.mjs` refuses
 * to select a target while any entry is malformed, expired, cites an unknown
 * finding, or cites a RESOLVED one. This spec is the backstop for the case the
 * consumer cannot see — a PR whose affected set does not include the
 * quarantined project — and it pins the contract's negative behaviour so the
 * validator itself cannot silently weaken.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#INFRA-HIGH-141
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const POLICY_PATH = join(REPO_ROOT, 'scripts/ci/affected-target-policy.json');
const LINT_SCRIPT = join(REPO_ROOT, 'scripts/ci/affected-target-policy-lint.mjs');
const REPORT_SCRIPT = join(REPO_ROOT, 'scripts/ci/write-affected-target-report.mjs');

interface QuarantineEntry {
  owner: string;
  expiry: string;
  findingId: string;
  reason: string;
}

interface TargetPolicy {
  knownUnstableProjects: Record<string, QuarantineEntry>;
}

interface Policy {
  metadataExcludes: string[];
  targets: { lint: TargetPolicy; test: TargetPolicy; 'test:contract': TargetPolicy };
}

function readPolicy(): Policy {
  return JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Policy;
}

interface LintResult {
  status: number;
  output: string;
}

function lint(policy: Policy, today = '2026-09-05'): LintResult {
  const dir = mkdtempSync(join(tmpdir(), 'affected-target-policy-'));
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify(policy), 'utf8');
  try {
    const output = execFileSync('node', [LINT_SCRIPT, '--policy', path, '--today', today], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

function withEntry(mutate: (entry: QuarantineEntry) => Partial<QuarantineEntry> | null): Policy {
  const policy = readPolicy();
  const first = Object.entries(policy.targets.lint.knownUnstableProjects)[0];
  if (!first) throw new Error('the lint quarantine is empty; nothing to mutate');
  const [project, entry] = first;
  const patch = mutate({ ...entry });
  if (patch === null) {
    (policy.targets.lint.knownUnstableProjects as Record<string, unknown>)[project] = 'prose only';
  } else {
    policy.targets.lint.knownUnstableProjects[project] = { ...entry, ...patch };
  }
  return policy;
}

describe('CI quarantine policy is governed debt (ADR-0017)', () => {
  it('the committed policy is sound today', () => {
    const result = lint(readPolicy(), new Date().toISOString().slice(0, 10));
    expect(result.output).toContain('is sound');
    expect(result.status).toBe(0);
  });

  it('every entry carries owner, expiry, findingId and reason — no prose values remain', () => {
    const policy = readPolicy();
    for (const [target, config] of Object.entries(policy.targets)) {
      for (const [project, entry] of Object.entries(config.knownUnstableProjects)) {
        expect({ target, project, keys: Object.keys(entry).sort() }).toEqual({
          target,
          project,
          keys: ['expiry', 'findingId', 'owner', 'reason'],
        });
      }
    }
  });

  it('admin-api-service and admin-panel are not test-quarantined: they pass, and a quarantine of a passing project hides nothing but coverage', () => {
    const tested = Object.keys(readPolicy().targets.test.knownUnstableProjects);
    expect(tested).not.toContain('admin-api-service');
    expect(tested).not.toContain('admin-panel');
  });

  it('the list ceilings only decrease (lint ≤ 38, test ≤ 16, test:contract = 0)', () => {
    const policy = readPolicy();
    expect(Object.keys(policy.targets.lint.knownUnstableProjects).length).toBeLessThanOrEqual(38);
    expect(Object.keys(policy.targets.test.knownUnstableProjects).length).toBeLessThanOrEqual(16);
    expect(policy.targets['test:contract'].knownUnstableProjects).toEqual({});
  });

  it('a prose-only entry is refused', () => {
    const result = lint(withEntry(() => null));
    expect(result.status).toBe(1);
    expect(result.output).toContain('must be an object {owner, expiry, findingId, reason}');
  });

  it('an expired entry is refused on its expiry date', () => {
    const result = lint(
      withEntry(() => ({ expiry: '2026-09-05' })),
      '2026-09-05',
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain('quarantine expired on 2026-09-05');
  });

  it('an entry citing a finding nobody registered is refused', () => {
    const result = lint(withEntry(() => ({ findingId: 'INFRA-HIGH-999' })));
    expect(result.status).toBe(1);
    expect(result.output).toContain('INFRA-HIGH-999 is not registered');
  });

  it('an entry citing a RESOLVED finding is refused — paid debt is not a quarantine', () => {
    const registry = readFileSync(join(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; state: string });
    const resolved = registry.find((entry) => entry.state === 'RESOLVED');
    if (!resolved) throw new Error('registry has no RESOLVED finding to test against');
    const result = lint(withEntry(() => ({ findingId: resolved.id })));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${resolved.id} is RESOLVED`);
  });

  it('a reason shorter than 30 characters is refused', () => {
    const result = lint(withEntry(() => ({ reason: 'flaky' })));
    expect(result.status).toBe(1);
    expect(result.output).toContain('reason must be at least 30 characters');
  });

  it('the report writer — the consumer CI actually runs — refuses a broken policy before selecting any target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affected-target-report-'));
    const policyPath = join(dir, 'policy.json');
    writeFileSync(policyPath, JSON.stringify(withEntry(() => ({ expiry: '2000-01-01' }))), 'utf8');
    const empty = (name: string): string => {
      const path = join(dir, name);
      writeFileSync(path, '', 'utf8');
      return path;
    };
    let status = 0;
    let output = '';
    try {
      execFileSync(
        'node',
        [
          REPORT_SCRIPT,
          '--target',
          'lint',
          '--base',
          'origin/main',
          '--head',
          'HEAD',
          '--policy',
          policyPath,
          '--changed-files',
          empty('changed.txt'),
          '--affected-projects',
          empty('affected.txt'),
          '--explicit-excludes',
          empty('excludes.txt'),
          '--strict-projects',
          join(dir, 'strict.txt'),
          '--report',
          join(dir, 'report.json'),
          '--dry-run',
          'true',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(status).toBe(1);
    expect(output).toContain('violates the quarantine contract (ADR-0017)');
  });

  it('every quarantined project still exists in the Nx graph — a vanished project is stale debt', () => {
    const nxProjects = new Set(
      JSON.parse(
        execFileSync('npx', ['nx', 'show', 'projects', '--json'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, NX_DAEMON: 'false' },
        }),
      ) as string[],
    );
    const policy = readPolicy();
    const vanished: string[] = [];
    for (const [target, config] of Object.entries(policy.targets)) {
      for (const project of Object.keys(config.knownUnstableProjects)) {
        if (!nxProjects.has(project)) vanished.push(`${target}:${project}`);
      }
    }
    expect(vanished).toEqual([]);
  });
});
