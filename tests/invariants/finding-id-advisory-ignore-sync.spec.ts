/**
 * REG-ID (ARIA-LOW-1003) — scripts/ci/check-advisory-ignore-sync.ts reads a
 * tracked finding id as the grammar owner does.
 *
 * The gate requires the comment block above every ignored advisory to name "a
 * tracked finding id". It spelled that id itself, with a fixed three-digit
 * sequence for the `CI` and `CVE` classifiers
 * (`(?:CI|CVE)-\d{3}\b|\bRUST-CVE-\d{3}\b`): a sibling of the grammar the
 * registry issues, outside the three roots the restatement invariant scans
 * (tests/invariants/finding-id-grammar.spec.ts), so the widening to four digits
 * that REG-ID made for every other reader left it refusing `EDGE-CI-1000` and
 * accepting nothing the owner would. The owner is
 * tools/gates/finding-id-grammar.ts (`parseFindingIdShape` reads any
 * `DOMAIN-CLASSIFIER-SEQUENCE`, the shape a legacy `RUST-CVE-002` has).
 *
 * The gate is a script, not a library: it runs its checks at import and exits.
 * It is therefore RUN, as CI runs it (`node scripts/ci/check-advisory-ignore-sync.ts`),
 * on a throwaway tree that holds a copy of the script, of the gates directory it
 * may import the owner from, and the minimal surfaces it reads. Only the finding
 * id in the comment block changes between runs.
 *
 * What is pinned:
 *   - every id the owner reads, with the classifiers the surfaces use (`CI`,
 *     `CVE`) and the severity classifiers the registry issues, three digits or
 *     four, is a tracked finding id;
 *   - an id the owner refuses (a leading zero past three digits, two digits, a
 *     fifth digit) is not one, and neither is an advisory id that has the same
 *     shape (`RUSTSEC-2026-1234`: domain, a year, four digits), which a reader
 *     that took every `A-B-NNNN` for a finding id would count as tracked.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { removeFixtureTree } from '../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = 'scripts/ci/check-advisory-ignore-sync.ts';
const NO_ID_REASON = 'no tracked finding id in the preceding comment block';
const IN_LOCK_STEP = 'advisory-ignore-sync: all surfaces in lock-step';

const ROOT_ADVISORY = 'RUSTSEC-2099-0001';
const EDGE_ADVISORY = 'RUSTSEC-2099-0002';
const REQUIRED_GHSAS = 'GHSA-h395-gr6q-cpjc,GHSA-9q82-xgwf-vj6h';

/** The surfaces the gate reads, as small as it accepts them, one advisory per workspace. */
function surfaces(trackedBy: string): ReadonlyMap<string, string> {
  const ignores = (advisory: string): string =>
    `[advisories]\nignore = [\n    # ${trackedBy}\n    # Owner: platform-team\n    # Deadline: RE-EVAL QUARTERLY\n    "${advisory}",\n]\n`;
  const audit = (advisory: string): string => `run: cargo audit --ignore ${advisory}\n`;
  return new Map([
    ['deny.toml', ignores(ROOT_ADVISORY)],
    ['.cargo/audit.toml', ignores(ROOT_ADVISORY)],
    ['sens-api-gateway/deny.toml', ignores(EDGE_ADVISORY)],
    ['sens-api-gateway/.cargo/audit.toml', ignores(EDGE_ADVISORY)],
    ['.github/workflows/rust-ci.yml', audit(ROOT_ADVISORY)],
    ['.github/workflows/sens-api-gateway-ci.yml', audit(EDGE_ADVISORY)],
    ['.github/workflows/edge-agent-release.yml', audit(EDGE_ADVISORY)],
    ['.github/workflows/ci-affected.yml', audit(EDGE_ADVISORY)],
    ['.github/workflows/dependency-review.yml', `        allow-ghsas: ${REQUIRED_GHSAS}\n`],
  ]);
}

interface GateRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe('REG-ID — the advisory ignore gate reads a tracked finding id as the grammar owner does', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reg-id-advisory-sync-'));
    cpSync(join(REPO_ROOT, 'scripts', 'ci'), join(root, 'scripts', 'ci'), { recursive: true });
    cpSync(join(REPO_ROOT, 'tools', 'gates'), join(root, 'tools', 'gates'), { recursive: true });
  });

  afterAll(() => removeFixtureTree(root));

  /** Run the gate on a tree whose every ignored advisory is tracked by `trackedBy`. */
  function run(trackedBy: string): GateRun {
    for (const [relative, text] of surfaces(trackedBy)) {
      mkdirSync(dirname(join(root, relative)), { recursive: true });
      writeFileSync(join(root, relative), text, 'utf8');
    }
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('accepts the tree it builds when the id is one the gate has always read (the control)', () => {
    const control = run('Finding: EDGE-CI-010 (registry: SUPPLY-HIGH-025)');
    expect({ status: control.status, stderr: control.status === 0 ? '' : control.stderr }).toEqual({
      status: 0,
      stderr: '',
    });
    expect(control.stdout).toContain(IN_LOCK_STEP);
  });

  it('takes every id the owner reads as tracked', () => {
    const accepted = [
      'RUST-CVE-002',
      'EDGE-CI-010',
      'EDGE-CI-1000',
      'RUST-CVE-9999',
      'SUPPLY-HIGH-025',
      'ARIA-HIGH-1000',
    ];
    const refused = accepted
      .map((id) => ({ id, run: run(`Finding: ${id}`) }))
      .filter(({ run: result }) => result.status !== 0 || !result.stdout.includes(IN_LOCK_STEP))
      .map(({ id, run: result }) => ({
        id,
        status: result.status,
        stderr: result.stderr.slice(0, 240),
      }));
    expect(refused).toEqual([]);
  });

  it('does not take an id the owner refuses, or an advisory id, as tracked', () => {
    const notTracked = [
      'Finding: EDGE-CI-0999',
      'Finding: EDGE-CI-12',
      'Finding: EDGE-CI-10000',
      'Finding: ARIA-HIGH-0999',
      'RUSTSEC-2026-1234 unmaintained, and tracked nowhere',
      'Why: tracked nowhere',
    ];
    const taken = notTracked
      .map((text) => ({ text, run: run(text) }))
      .filter(({ run: result }) => result.status !== 1 || !result.stderr.includes(NO_ID_REASON))
      .map(({ text, run: result }) => ({
        text,
        status: result.status,
        stderr: result.stderr.slice(0, 240),
      }));
    expect(taken).toEqual([]);
  });
});
