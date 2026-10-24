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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';
import { projectRegistry } from '../../tools/gates/finding-registry-projection';
const REPO_ROOT = resolve(__dirname, '..', '..');
const EXCEPTIONS_PATH = join(REPO_ROOT, 'scripts', 'ci', 'npm-audit-exceptions.json');
const GATE = join(REPO_ROOT, 'scripts', 'ci', 'npm-audit-gate.mjs');

/**
 * RATCHET — only ever goes DOWN, except in the same commit as the reviewed
 * entries a raise admits; the dated log below records every change and the
 * count it left. The entry it was born with, GHSA-528h-pc64-c93x
 * (minio@8.0.7 -> stream-json@1.9.1), left with minio when libs/storage moved
 * to @aws-sdk/client-s3 (SUPPLY-MEDIUM-008) — exactly the re-review condition
 * the entry's own reason named.
 */
const MAX_EXCEPTIONS = 2;

// 2026-09-16: 0 → 2, in the same commit as the two entries it admits.
// GHSA-7w5x-hrqm-74c2 (nx toolchain, 15 packages) and GHSA-vwc7-r8mq-g2x9
// (@nx/react, @nx/module-federation) are dev-only root-full advisories whose
// only npm remediation is a SemVer-major workspace-wide nx bump — tracked as
// SUPPLY-HIGH-011/012. The ratchet must return to 0 when that migration lands
// and these entries expire (2026-10-16).
//
// 2026-10-04: 2 → 3, in the same commit as the entry it admits.
// GHSA-vfj7-8cjw-p6xm (braces stack exhaustion, no patched release) after
// SUPPLY-HIGH-016 took every non-breaking upgrade: root-production is clean
// and the entry names only the root-full, aquamobil-full and e2e-full legs,
// where the remaining paths are dev and build tooling whose fixes are
// semver-majors or upstream releases. Tracked as SUPPLY-HIGH-017; the entry
// expires 2026-11-03 and the ratchet drops by one when it goes.
//
// 2026-10-07: 3 → 5, in the same commit as the entries it admits and removes.
// Removed: GHSA-7w5x-hrqm-74c2 and GHSA-vwc7-r8mq-g2x9 — nx 22.7.12 with the
// smol-toml 1.9.0 override no longer reaches them (SUPPLY-HIGH-011/012 fixed).
// Admitted, dev-only, root-full/aquamobil-full only, expiring 2026-11-07:
// GHSA-82fw-gwwq-j7x9, GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr (vitest 3 and
// its tinypool 1.x; the fixes are vitest 4 / tinypool 2, which vitest 3 cannot
// take — SUPPLY-HIGH-019) and GHSA-rj75-hqrm-r3gf (tailwind 3's
// postcss-selector-parser 6; tailwind 4 is the fix — SUPPLY-MEDIUM-020). Every
// production leg is clean. The ratchet returns to 1 when vitest 4 and tailwind
// 4 land.
//
// 2026-10-22: 5 → 2, removing GHSA-82fw-gwwq-j7x9, GHSA-5gmw-xhrv-c9v3 and
// GHSA-85c8-ppgw-ccpr. vitest and every @vitest/* package moved to 4.1.12,
// which also fixes the critical GHSA-qxg6-89mg-rqv8 (@vitest/mocker, no 3.x
// patch) that turned root-full red (SUPPLY-CRITICAL-026), and vitest 4 no
// longer depends on tinypool (SUPPLY-HIGH-019 fixed). The ratchet returns to 1
// when tailwind 4 lands (SUPPLY-MEDIUM-020).

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

/**
 * Each finding's state as every reader sees it: the projection, where a merged
 * `Closes:` trailer makes a finding RESOLVED the moment it merges. The stored
 * `state` is not refreshed by any workflow (MF-1, PROC-HIGH-039), so a gate
 * that read it would keep an exception alive past its closed finding.
 */
function registryFindings(): Map<string, string> {
  return new Map(projectRegistry(REPO_ROOT).map((row) => [row.id, row.state]));
}

/** Run the real CLI against a fixture pair; returns its exit code and output. */
function runGate(
  audit: unknown,
  exceptionDoc: unknown,
  args: { level: string; scope: string },
): { status: number; output: string } {
  return runGateText(audit, JSON.stringify(exceptionDoc), args);
}

/** The gate over exceptions-file TEXT, so a fixture can carry a duplicated key. */
function runGateText(
  audit: unknown,
  exceptionsText: string,
  args: { level: string; scope: string },
): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'npm-audit-gate-'));
  try {
    const auditPath = join(dir, 'audit.json');
    const exceptionsPath = join(dir, 'exceptions.json');
    writeFileSync(auditPath, JSON.stringify(audit), 'utf8');
    writeFileSync(exceptionsPath, exceptionsText, 'utf8');
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
    removeFixtureTree(dir);
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

const FIXTURE_ENTRY: ExceptionEntry = {
  owner: 'supply-chain-auditor',
  reason: 'no remediation keeps minio working; the vulnerable filters are unreachable here',
  expires_on: '2099-01-01',
  finding_id: 'SUPPLY-CRITICAL-002',
  packages: ['minio', 'stream-json'],
  scopes: ['root-production'],
};

function exceptionFixture(overrides: Partial<ExceptionEntry> = {}): unknown {
  return {
    version: 1,
    advisories: { 'GHSA-528h-pc64-c93x': { ...FIXTURE_ENTRY, ...overrides } },
  };
}

describe('INVARIANT (SUPPLY-CRITICAL-002): npm audit exceptions are reviewed, tracked and dated', () => {
  it('never carries more exceptions than the ratchet allows', () => {
    expect(Object.keys(exceptions()).length).toBeLessThanOrEqual(MAX_EXCEPTIONS);
  });

  it('the gate accepts the committed exceptions file', () => {
    // The gate validates every entry before it reads the audit — GHSA key,
    // owner, reason, an unexpired date and a registry-shaped finding id
    // through scripts/ci/lib/reviewed-exception.mjs, packages and scopes
    // itself — and refuses the file on any problem, including a repeated
    // key. An empty audit therefore exits 0 only when every committed entry
    // is well formed and live, judged by the code CI runs rather than by a
    // copy of its rules (INFRA-LOW-229).
    const { status, output } = runGateText(
      { vulnerabilities: {} },
      readFileSync(EXCEPTIONS_PATH, 'utf8'),
      { level: 'low', scope: 'root-production' },
    );
    expect(output).not.toContain('exceptions are invalid');
    expect(status).toBe(0);
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

    // The committed file passing the gate proves only that the gate is no
    // stricter than the data; these pin the refusals the spec's deleted copies
    // used to restate (INFRA-LOW-229). A string `packages` would excuse every
    // package named inside it, and a date that is not ISO never lapses.
    it.each<[string, unknown, string]>([
      [
        'a key that is not a GHSA id',
        { version: 1, advisories: { 'GHSA-bad': FIXTURE_ENTRY } },
        'GHSA-bad: key must be a GHSA advisory id',
      ],
      [
        'packages given as one string',
        exceptionFixture({ packages: 'minio stream-json' }),
        'packages must list the package names',
      ],
      ['an empty scopes list', exceptionFixture({ scopes: [] }), 'scopes must list the audit legs'],
      [
        'a missing scopes list',
        exceptionFixture({ scopes: undefined }),
        'scopes must list the audit legs',
      ],
      [
        'an expiry that is not an ISO date',
        exceptionFixture({ expires_on: '2099-12-31T00:00' }),
        'expires_on must be YYYY-MM-DD',
      ],
    ])('blocks an exceptions file with %s', (_label, exceptionDoc, message) => {
      const { status, output } = runGate(AUDIT_FIXTURE, exceptionDoc, {
        level: 'moderate',
        scope: 'root-production',
      });
      expect(status).toBe(1);
      expect(output).toContain('npm audit exceptions are invalid');
      expect(output).toContain(message);
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

    it('blocks an exceptions file with a duplicated advisory key instead of keeping the last entry', () => {
      // JSON.parse keeps the last of two equal keys, so the entry a reviewer
      // read first would not be the one the gate applied (INFRA-MEDIUM-228).
      const entry = JSON.stringify(FIXTURE_ENTRY);
      const text =
        `{"version":1,"advisories":{"GHSA-528h-pc64-c93x":${entry},` +
        `"GHSA-528h-pc64-c93x":${entry}}}`;
      const { status, output } = runGateText(AUDIT_FIXTURE, text, {
        level: 'moderate',
        scope: 'root-production',
      });
      expect(status).toBe(1);
      expect(output).toContain('duplicate key(s) $.advisories.GHSA-528h-pc64-c93x');
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
