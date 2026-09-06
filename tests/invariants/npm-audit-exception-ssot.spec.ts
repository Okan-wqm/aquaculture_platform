/**
 * INVARIANT (SUPPLY-CRITICAL-002): an npm advisory is fixed, or it is a
 * reviewed exception with an owner, an argument, a registry finding and a DATE.
 *
 * The `security-audit` job used to gate on npm's own exit code. That is
 * all-or-nothing, so a single advisory with no safe remediation turns a
 * REQUIRED check red forever — and a permanently red required check stops being
 * read, at which point it protects nothing. `scripts/ci/npm-audit-gate.mjs`
 * replaces that verdict with one that can say "this one, in this scope, until
 * this date, because …".
 *
 * The danger of an exception mechanism is that it becomes the default. This
 * spec is what stops that:
 *
 *   - every entry carries the four fields (shared with the affected-target
 *     quarantine and the dormant-invariant registry via
 *     `scripts/ci/lib/reviewed-exception.mjs`);
 *   - `finding_id` names a finding the registry actually carries and has not
 *     already marked RESOLVED — an exception whose finding is closed is an
 *     exception nobody is working on;
 *   - `MAX_EXCEPTIONS` is a RATCHET. It only ever goes down. Raising it is the
 *     conversation this spec exists to force.
 *
 * The behavioural half runs the real CLI against fixtures, because a gate that
 * is only asserted to exist is exactly the shape of gate this programme keeps
 * finding to be inert.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXCEPTIONS_PATH = join(REPO_ROOT, 'scripts', 'ci', 'npm-audit-exceptions.json');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'npm-audit-gate.mjs');
const REGISTRY = join(REPO_ROOT, 'docs', 'reviews', '_registry', 'findings.jsonl');

/**
 * RATCHET — only ever goes DOWN. Zero entries today. The one it was born with,
 * GHSA-528h-pc64-c93x (minio@8.0.7 -> stream-json@1.9.1), left with minio when
 * libs/storage moved to @aws-sdk/client-s3 (SUPPLY-MEDIUM-008) — exactly the
 * re-review condition the entry's own reason named. The mechanism stays: the
 * next advisory with no safe remediation gets a dated, reviewed entry and the
 * ratchet moves to 1 in the same commit, never silently.
 */
const MAX_EXCEPTIONS = 0;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ADVISORY_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const MIN_REASON_LENGTH = 30;

interface ExceptionEntry {
  owner?: unknown;
  reason?: unknown;
  expires_on?: unknown;
  finding_id?: unknown;
  packages?: unknown;
  scopes?: unknown;
}

function exceptions(): Record<string, ExceptionEntry> {
  const doc = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8')) as {
    version: number;
    advisories?: Record<string, ExceptionEntry>;
  };
  expect(doc.version).toBe(1);
  return doc.advisories ?? {};
}

function registryFindings(): Map<string, string> {
  const states = new Map<string, string>();
  for (const line of readFileSync(REGISTRY, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    const row = JSON.parse(line) as { id?: string; state?: string };
    if (typeof row.id === 'string') states.set(row.id, row.state ?? 'OPEN');
  }
  return states;
}

/** Run the real CLI against a fixture pair; returns its exit code and output. */
function runGate(
  audit: unknown,
  exceptionDoc: unknown,
  args: { level: string; scope: string },
): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'));
  try {
    const auditPath = join(dir, 'audit.json');
    const exceptionsPath = join(dir, 'exceptions.json');
    writeFileSync(auditPath, JSON.stringify(audit), 'utf8');
    writeFileSync(exceptionsPath, JSON.stringify(exceptionDoc), 'utf8');
    try {
      const output = execFileSync(
        process.execPath,
        [
          GATE,
          '--audit',
          auditPath,
          '--level',
          args.level,
          '--scope',
          args.scope,
          '--exceptions',
          exceptionsPath,
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return {
        status: failure.status ?? -1,
        output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ADVISORY = {
  source: 1,
  name: 'stream-json',
  title: 'O(depth^2) filters',
  url: 'https://github.com/advisories/GHSA-528h-pc64-c93x',
  severity: 'moderate',
  range: '<=3.4.0',
};

const AUDIT_FIXTURE = {
  vulnerabilities: {
    'stream-json': {
      name: 'stream-json',
      severity: 'moderate',
      via: [ADVISORY],
      fixAvailable: false,
    },
    minio: { name: 'minio', severity: 'moderate', via: ['stream-json'], fixAvailable: false },
  },
};

function exceptionFixture(overrides: Partial<ExceptionEntry> = {}): unknown {
  return {
    version: 1,
    advisories: {
      'GHSA-528h-pc64-c93x': {
        owner: 'supply-chain-auditor',
        reason: 'no remediation keeps minio working; the vulnerable filters are unreachable here',
        expires_on: '2099-01-01',
        finding_id: 'SUPPLY-CRITICAL-002',
        packages: ['minio', 'stream-json'],
        scopes: ['root-production'],
        ...overrides,
      },
    },
  };
}

describe('INVARIANT (SUPPLY-CRITICAL-002): npm audit exceptions are reviewed, tracked and dated', () => {
  it('never carries more exceptions than the ratchet allows', () => {
    expect(Object.keys(exceptions()).length).toBeLessThanOrEqual(MAX_EXCEPTIONS);
  });

  it('keys every exception by a real GHSA advisory id', () => {
    const malformed = Object.keys(exceptions()).filter((id) => !ADVISORY_ID.test(id));
    expect(malformed).toEqual([]);
  });

  it('carries owner, a substantive reason, an unexpired date, packages and scopes', () => {
    const today = new Date().toISOString().slice(0, 10);
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(exceptions())) {
      if (typeof entry.owner !== 'string' || entry.owner.trim().length === 0) {
        problems.push(`${id}: owner is required`);
      }
      if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(`${id}: reason must be at least ${MIN_REASON_LENGTH} characters`);
      }
      if (typeof entry.expires_on !== 'string' || !ISO_DATE.test(entry.expires_on)) {
        problems.push(`${id}: expires_on must be YYYY-MM-DD`);
      } else if (entry.expires_on < today) {
        problems.push(`${id}: expired ${entry.expires_on} — fix the advisory or re-argue the case`);
      }
      if (!Array.isArray(entry.packages) || entry.packages.length === 0) {
        problems.push(`${id}: packages must name what this was reviewed against`);
      }
      if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
        problems.push(`${id}: scopes must name the audit legs this applies to`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('points every exception at a registry finding that is still open', () => {
    const findings = registryFindings();
    const problems: string[] = [];
    for (const [id, entry] of Object.entries(exceptions())) {
      const findingId = entry.finding_id;
      if (typeof findingId !== 'string') {
        problems.push(`${id}: finding_id is required`);
        continue;
      }
      const state = findings.get(findingId);
      if (state === undefined) {
        problems.push(`${id}: ${findingId} is not in docs/reviews/_registry/findings.jsonl`);
      } else if (state === 'RESOLVED') {
        problems.push(`${id}: ${findingId} is RESOLVED — an exception nobody is working on`);
      }
    }
    expect(problems).toEqual([]);
  });

  describe('the gate itself', () => {
    it('passes an advisory that a live exception covers in that scope', () => {
      const { status, output } = runGate(AUDIT_FIXTURE, exceptionFixture(), {
        level: 'moderate',
        scope: 'root-production',
      });
      expect(output).toContain('EXCEPTED');
      expect(status).toBe(0);
    });

    it('blocks the same advisory in a scope the exception does not name', () => {
      const { status, output } = runGate(AUDIT_FIXTURE, exceptionFixture(), {
        level: 'moderate',
        scope: 'aquamobil-production',
      });
      expect(status).toBe(1);
      expect(output).toContain('GHSA-528h-pc64-c93x');
    });

    it('blocks when the exception has expired', () => {
      const { status, output } = runGate(
        AUDIT_FIXTURE,
        exceptionFixture({ expires_on: '2000-01-01' }),
        { level: 'moderate', scope: 'root-production' },
      );
      expect(status).toBe(1);
      expect(output).toContain('expired 2000-01-01');
    });

    it('blocks when the advisory has reached a package the exception never named', () => {
      const { status, output } = runGate(
        AUDIT_FIXTURE,
        exceptionFixture({ packages: ['stream-json'] }),
        { level: 'moderate', scope: 'root-production' },
      );
      expect(status).toBe(1);
      expect(output).toContain('minio');
    });

    it('blocks an entry missing the four fields rather than treating it as absent', () => {
      const { status, output } = runGate(
        AUDIT_FIXTURE,
        { version: 1, advisories: { 'GHSA-528h-pc64-c93x': { reason: 'because' } } },
        { level: 'moderate', scope: 'root-production' },
      );
      expect(status).toBe(1);
      expect(output).toContain('owner is required');
    });

    it('blocks an unexcepted advisory and names the remedy npm offers', () => {
      const { status, output } = runGate(
        {
          vulnerabilities: {
            'left-pad': {
              name: 'left-pad',
              severity: 'high',
              via: [{ ...ADVISORY, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }],
              fixAvailable: true,
            },
          },
        },
        exceptionFixture(),
        { level: 'high', scope: 'root-production' },
      );
      expect(status).toBe(1);
      expect(output).toContain('a non-breaking fix is available');
    });

    it('ignores advisories below the requested level', () => {
      const { status } = runGate(
        {
          vulnerabilities: {
            'left-pad': { name: 'left-pad', severity: 'low', via: [ADVISORY], fixAvailable: true },
          },
        },
        exceptionFixture(),
        { level: 'high', scope: 'root-production' },
      );
      expect(status).toBe(0);
    });
  });
});
