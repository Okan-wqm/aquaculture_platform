import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/ci/verify-farm-feeding-branch-reconciliation.mjs');
const AUTHORITY = resolve(REPO_ROOT, 'tools/quality/farm-feeding-branch-reconciliation.json');

interface VerificationResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runVerifier(authority?: string): VerificationResult {
  const args = authority === undefined ? [SCRIPT] : [SCRIPT, '--stdin'];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    input: authority,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayField(value: Readonly<Record<string, unknown>>, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new TypeError(`${key} must be an array`);
  return field;
}

function numberField(value: Readonly<Record<string, unknown>>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number') throw new TypeError(`${key} must be a number`);
  return field;
}

function booleanField(value: Readonly<Record<string, unknown>>, key: string): boolean {
  const field = value[key];
  if (typeof field !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  return field;
}

function expectRejected(authority: string, message: string): void {
  const result = runVerifier(authority);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(message);
}

interface MutableClaimSetLocation {
  readonly claimSets: unknown[];
  readonly index: number;
  readonly claimSet: Record<string, unknown>;
}

function findClaimSetLocations(
  authority: Readonly<Record<string, unknown>>,
  claimId: string,
): MutableClaimSetLocation[] {
  const locations: MutableClaimSetLocation[] = [];
  const commits = arrayField(authority, 'commits');

  commits.forEach((entry, commitIndex) => {
    const commit = mutableRecord(entry, `commits[${commitIndex}]`);
    const claimSetsValue = commit['claimSets'];
    if (claimSetsValue === undefined) return;
    const claimSets = arrayField(commit, 'claimSets');

    claimSets.forEach((claimSetValue, claimSetIndex) => {
      const claimSet = mutableRecord(
        claimSetValue,
        `commits[${commitIndex}].claimSets[${claimSetIndex}]`,
      );
      const claim = record(
        arrayField(claimSet, 'claims')[0],
        `commits[${commitIndex}].claimSets[${claimSetIndex}].claims[0]`,
      );
      if (claim['id'] === claimId) {
        locations.push({ claimSets, index: claimSetIndex, claimSet });
      }
    });
  });

  return locations;
}

describe('farm feeding source branch reconciliation authority', () => {
  const authority = readFileSync(AUTHORITY, 'utf8');

  it('compiles the exact source/candidate graph and reports honest claim readiness', () => {
    const first = runVerifier();
    expect(first.status).toBe(0);
    const parsed: unknown = JSON.parse(first.stdout);
    const summary = record(parsed, 'summary');
    const counts = record(summary['counts'], 'summary.counts');
    const occurrenceCounts = record(summary['occurrenceCounts'], 'summary.occurrenceCounts');
    const open = numberField(summary, 'open');

    expect(numberField(summary, 'commitCount')).toBe(49);
    expect(summary['historySha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(summary['proofDigest']).toMatch(/^[0-9a-f]{64}$/);
    expect(summary['authoritySha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(numberField(summary, 'evidenceCount')).toBeGreaterThan(0);
    expect(numberField(summary, 'uniqueClaimCount')).toBe(84);
    expect(numberField(counts, 'MERGE_SYNC')).toBe(1);
    expect(numberField(counts, 'EXCLUDED')).toBe(2);
    expect(numberField(occurrenceCounts, 'OPEN')).toBeGreaterThanOrEqual(open);
    expect(numberField(occurrenceCounts, 'MERGE_SYNC')).toBe(1);
    expect(open).toBe(numberField(counts, 'OPEN'));
    expect(booleanField(summary, 'publicationReady')).toBe(open === 0);
  });

  it('emits byte-identical compiled evidence for two runs on the same tree', () => {
    const first = runVerifier();
    const second = runVerifier();

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  it('fails closed on source-ref, source-history, main-ref, and evidence drift', () => {
    expectRejected(
      authority.replace(
        '"ref": "refs/remotes/origin/claude/farm-feeding-protocol-f92y38"',
        '"ref": "refs/remotes/origin/main"',
      ),
      'source.ref drifted',
    );
    expectRejected(
      authority.replace(/("historySha256": ")[0-9a-f]/, '$1z'),
      'source.historySha256 must be SHA-256',
    );
    expectRejected(
      authority.replace(
        '"mainRef": "refs/remotes/origin/main"',
        '"mainRef": "refs/remotes/origin/claude/farm-feeding-protocol-f92y38"',
      ),
      'candidateGraph.mainRef drifted',
    );
    expectRejected(
      authority.replace(/("sha256": ")[0-9a-f]/, '$1z'),
      'evidenceCatalog[0].sha256 is invalid',
    );
  });

  it('rejects an omitted source claim and a disposition without its typed proof profile', () => {
    const decoded: unknown = JSON.parse(authority);
    const parsed = mutableRecord(decoded, 'authority');
    const omittedClaimLocations = findClaimSetLocations(parsed, 'FARM-CRITICAL-242');
    if (omittedClaimLocations.length !== 1) {
      throw new Error('omitted source claim fixture must have exactly one occurrence');
    }
    const omittedClaim = omittedClaimLocations[0];
    if (!omittedClaim) throw new Error('omitted source claim fixture is absent');
    omittedClaim.claimSets.splice(omittedClaim.index, 1);

    expectRejected(JSON.stringify(parsed), 'source claim coverage differs');
    expectRejected(
      authority.replace('"disposition": "OPEN"', '"disposition": "INTEGRATED"'),
      'OPEN_REQUIRED_AUTHORITY cannot prove INTEGRATED',
    );
  });

  it('derives stable evidence identities from unique repository paths', () => {
    expectRejected(
      authority.replace('"id": "E:05B2A5E4CB3763CE"', '"id": "E:05B2A5E4CB3763CF"'),
      'derived from its path',
    );
    expectRejected(
      authority.replace(
        '"path": "libs/backend-common/src/logging/structured-logger.service.ts"',
        '"path": "libs/backend-common/src/middleware/tenant-context.middleware.ts"',
      ),
      'duplicate evidence path libs/backend-common/src/middleware/tenant-context.middleware.ts',
    );
  });

  it('binds every declared claim identity to its immutable source anchor', () => {
    expectRejected(
      authority.replace('"id": "FARM-CRITICAL-242"', '"id": "FARM-HIGH-243.UNRELATED"'),
      'must match source claim FARM-CRITICAL-242 or be its strict subclaim',
    );
    expectRejected(
      authority.replace('"id": "FARM-LOW-308.ENUM-STATUS"', '"id": "FARM-LOW-308"'),
      'is declared as both a base claim and subclaims',
    );
    expectRejected(
      authority.replace('"id": "FARM-MEDIUM-251"', '"id": "FARM-MEDIUM-251.BAND"'),
      'is declared as both a base claim and subclaims across commits',
    );
  });

  it('keeps disposition and proof decisions atomic per source claim', () => {
    const decoded: unknown = JSON.parse(authority);
    const parsed = mutableRecord(decoded, 'authority');
    const firstCommit = mutableRecord(arrayField(parsed, 'commits')[0], 'commits[0]');
    const firstClaimSet = mutableRecord(
      arrayField(firstCommit, 'claimSets')[0],
      'commits[0].claimSets[0]',
    );
    arrayField(firstClaimSet, 'claims').push({
      id: 'FARM-HIGH-243',
      source: 'docs/reviews/claude/2026-07-27-feeding-v2-post-merge-audit.md#FARM-HIGH-243',
    });

    expectRejected(JSON.stringify(parsed), 'claims must contain exactly one atomic claim');
  });

  it('keeps exclusion authorities and commit coordinates canonical', () => {
    expectRejected(
      authority.replace(
        '"1c383b928074af1eb2d3978db69b67f6f073fe06",\n        "e842e286d65646117106f46f11824534be41cae9"',
        '"e842e286d65646117106f46f11824534be41cae9",\n        "1c383b928074af1eb2d3978db69b67f6f073fe06"',
      ),
      'allowedCommits must be unique and sorted',
    );
  });

  it('compiles one non-contradictory current readiness state per repeated claim', () => {
    const decoded: unknown = JSON.parse(authority);
    const parsed = mutableRecord(decoded, 'authority');
    const liveBandClaims = findClaimSetLocations(parsed, 'FARM-MEDIUM-251');
    if (liveBandClaims.length < 2) throw new Error('multi-occurrence live band fixture is absent');
    const contradictoryClaim = liveBandClaims[0];
    if (!contradictoryClaim) throw new Error('multi-occurrence live band fixture is absent');
    contradictoryClaim.claimSet['disposition'] = 'OPEN';
    contradictoryClaim.claimSet['proof'] = {
      profile: 'OPEN_REQUIRED_AUTHORITY',
      requiredAuthority: 'DIVERGENT_LIVE_BAND_AUTHORITY',
      owner: 'farm-feeding-forecast',
      deadline: '2026-08-15',
    };

    expectRejected(JSON.stringify(parsed), 'has contradictory current readiness');
  });

  it('keeps one open authority contract per repeated claim', () => {
    const decoded: unknown = JSON.parse(authority);
    const parsed = mutableRecord(decoded, 'authority');
    const integrationCiClaims = findClaimSetLocations(parsed, 'FARM-MEDIUM-301');
    if (integrationCiClaims.length < 2) {
      throw new Error('multi-occurrence open authority fixture is absent');
    }
    const integrationCiClaim = integrationCiClaims[0];
    if (!integrationCiClaim) throw new Error('multi-occurrence open authority fixture is absent');
    const proof = mutableRecord(integrationCiClaim.claimSet['proof'], 'integrationCiClaim.proof');
    proof['requiredAuthority'] = 'DIVERGENT_LIVE_BAND_AUTHORITY';

    expectRejected(JSON.stringify(parsed), 'has divergent open authority contracts');
  });
});
