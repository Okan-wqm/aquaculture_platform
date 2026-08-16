import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SHA_PATTERN = /^[0-9a-f]{40}$/;

interface SourceBranch {
  readonly ref: string;
  readonly tip: string;
  readonly relationToAuditedRange:
    | 'BASELINE_REF'
    | 'ANCESTOR_OF_AUDITED_TIP'
    | 'AUDITED_TIP'
    | 'OUTSIDE_AUDITED_RANGE';
}

interface EvidenceDefinition {
  readonly state: string;
  readonly summary: string;
  readonly locations: readonly string[];
}

interface TestProofDefinition {
  readonly status: string;
  readonly kind: string;
  readonly command: string;
  readonly locations: readonly string[];
}

interface CommitDisposition {
  readonly ordinal: number;
  readonly sha: string;
  readonly phase: string;
  readonly disposition: string;
  readonly subject: string;
  readonly currentEvidence: readonly string[];
  readonly testProof: readonly string[];
}

interface ReconciliationAuthority {
  readonly schemaVersion: string;
  readonly authority: string;
  readonly auditedAt: string;
  readonly sourceBranches: readonly SourceBranch[];
  readonly auditedRange: {
    readonly baselineRef: string;
    readonly auditedRef: string;
    readonly mergeBaseExclusive: string;
    readonly tipInclusive: string;
    readonly commitCount: number;
    readonly orderedCommitSequenceSha256: string;
  };
  readonly vocabularies: {
    readonly phases: readonly string[];
    readonly dispositions: readonly string[];
  };
  readonly dispositionCounts: Readonly<Record<string, number>>;
  readonly currentEvidenceCatalog: Readonly<Record<string, EvidenceDefinition>>;
  readonly testProofCatalog: Readonly<Record<string, TestProofDefinition>>;
  readonly commits: readonly CommitDisposition[];
}

export interface ReconciliationCompilation {
  readonly authority: ReconciliationAuthority;
  readonly orderedCommitSequenceSha256: string;
  readonly dispositionCounts: Readonly<Record<string, number>>;
  readonly unresolvedCommits: readonly CommitDisposition[];
}

export interface ReconciliationCompilerOptions {
  readonly repoRoot: string;
  readonly authorityPath: string;
  readonly requireClosed?: boolean;
}

function fail(path: string, message: string): never {
  throw new Error(`reconciliation authority ${path}: ${message}`);
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    fail(path, `expected exact keys [${canonical.join(', ')}], got [${actual.join(', ')}]`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return fail(path, 'expected a non-empty string');
  }
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    return fail(path, 'expected a non-negative safe integer');
  }
  return Number(value);
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return fail(path, 'expected a non-empty string array');
  }
  const decoded = value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
  if (new Set(decoded).size !== decoded.length) {
    fail(path, 'duplicate values are forbidden');
  }
  return Object.freeze(decoded);
}

function objectEntries(value: unknown, path: string): readonly [string, unknown][] {
  return Object.entries(record(value, path));
}

function decodeSourceBranch(value: unknown, path: string): SourceBranch {
  const source = record(value, path);
  exactKeys(source, ['ref', 'tip', 'relationToAuditedRange'], path);
  const relation = stringValue(source['relationToAuditedRange'], `${path}.relationToAuditedRange`);
  if (
    relation !== 'BASELINE_REF' &&
    relation !== 'ANCESTOR_OF_AUDITED_TIP' &&
    relation !== 'AUDITED_TIP' &&
    relation !== 'OUTSIDE_AUDITED_RANGE'
  ) {
    fail(`${path}.relationToAuditedRange`, `unsupported relation ${relation}`);
  }
  return Object.freeze({
    ref: stringValue(source['ref'], `${path}.ref`),
    tip: fullSha(source['tip'], `${path}.tip`),
    relationToAuditedRange: relation,
  });
}

function decodeEvidence(value: unknown, path: string): EvidenceDefinition {
  const evidence = record(value, path);
  exactKeys(evidence, ['state', 'summary', 'locations'], path);
  return Object.freeze({
    state: stringValue(evidence['state'], `${path}.state`),
    summary: stringValue(evidence['summary'], `${path}.summary`),
    locations: stringArray(evidence['locations'], `${path}.locations`),
  });
}

function decodeProof(value: unknown, path: string): TestProofDefinition {
  const proof = record(value, path);
  exactKeys(proof, ['status', 'kind', 'command', 'locations'], path);
  return Object.freeze({
    status: stringValue(proof['status'], `${path}.status`),
    kind: stringValue(proof['kind'], `${path}.kind`),
    command: stringValue(proof['command'], `${path}.command`),
    locations: stringArray(proof['locations'], `${path}.locations`),
  });
}

function decodeCommit(value: unknown, path: string): CommitDisposition {
  const commit = record(value, path);
  exactKeys(
    commit,
    ['ordinal', 'sha', 'phase', 'disposition', 'subject', 'currentEvidence', 'testProof'],
    path,
  );
  return Object.freeze({
    ordinal: integerValue(commit['ordinal'], `${path}.ordinal`),
    sha: fullSha(commit['sha'], `${path}.sha`),
    phase: stringValue(commit['phase'], `${path}.phase`),
    disposition: stringValue(commit['disposition'], `${path}.disposition`),
    subject: stringValue(commit['subject'], `${path}.subject`),
    currentEvidence: stringArray(commit['currentEvidence'], `${path}.currentEvidence`),
    testProof: stringArray(commit['testProof'], `${path}.testProof`),
  });
}

function fullSha(value: unknown, path: string): string {
  const sha = stringValue(value, path);
  if (!SHA_PATTERN.test(sha)) return fail(path, 'expected a full lowercase 40-character OID');
  return sha;
}

function decodeNamedCatalog<T>(
  value: unknown,
  path: string,
  decoder: (entry: unknown, entryPath: string) => T,
): Readonly<Record<string, T>> {
  const entries = objectEntries(value, path);
  if (entries.length === 0) fail(path, 'catalog must not be empty');
  const decoded: Record<string, T> = Object.create(null);
  for (const [id, entry] of entries) {
    if (!/^[A-Z][A-Z0-9-]+$/.test(id)) fail(`${path}.${id}`, 'invalid catalog identifier');
    decoded[id] = decoder(entry, `${path}.${id}`);
  }
  return Object.freeze(decoded);
}

function decodeAuthority(value: unknown): ReconciliationAuthority {
  const root = record(value, '$');
  exactKeys(
    root,
    [
      'schemaVersion',
      'authority',
      'auditedAt',
      'sourceBranches',
      'auditedRange',
      'vocabularies',
      'dispositionCounts',
      'currentEvidenceCatalog',
      'testProofCatalog',
      'commits',
    ],
    '$',
  );
  const sourceBranchesRaw = root['sourceBranches'];
  if (!Array.isArray(sourceBranchesRaw) || sourceBranchesRaw.length === 0) {
    fail('$.sourceBranches', 'expected a non-empty array');
  }
  const auditedRange = record(root['auditedRange'], '$.auditedRange');
  exactKeys(
    auditedRange,
    [
      'baselineRef',
      'auditedRef',
      'mergeBaseExclusive',
      'tipInclusive',
      'commitCount',
      'orderedCommitSequenceSha256',
    ],
    '$.auditedRange',
  );
  const vocabularies = record(root['vocabularies'], '$.vocabularies');
  exactKeys(vocabularies, ['phases', 'dispositions'], '$.vocabularies');
  const dispositionCounts: Record<string, number> = Object.create(null);
  for (const [disposition, count] of objectEntries(
    root['dispositionCounts'],
    '$.dispositionCounts',
  )) {
    dispositionCounts[disposition] = integerValue(count, `$.dispositionCounts.${disposition}`);
  }
  const commitsRaw = root['commits'];
  if (!Array.isArray(commitsRaw) || commitsRaw.length === 0) {
    fail('$.commits', 'expected a non-empty array');
  }
  const sequenceDigest = stringValue(
    auditedRange['orderedCommitSequenceSha256'],
    '$.auditedRange.orderedCommitSequenceSha256',
  );
  if (!/^[0-9a-f]{64}$/.test(sequenceDigest)) {
    fail('$.auditedRange.orderedCommitSequenceSha256', 'expected a lowercase SHA-256 digest');
  }
  return Object.freeze({
    schemaVersion: stringValue(root['schemaVersion'], '$.schemaVersion'),
    authority: stringValue(root['authority'], '$.authority'),
    auditedAt: stringValue(root['auditedAt'], '$.auditedAt'),
    sourceBranches: Object.freeze(
      sourceBranchesRaw.map((entry, index) =>
        decodeSourceBranch(entry, `$.sourceBranches[${index}]`),
      ),
    ),
    auditedRange: Object.freeze({
      baselineRef: stringValue(auditedRange['baselineRef'], '$.auditedRange.baselineRef'),
      auditedRef: stringValue(auditedRange['auditedRef'], '$.auditedRange.auditedRef'),
      mergeBaseExclusive: fullSha(
        auditedRange['mergeBaseExclusive'],
        '$.auditedRange.mergeBaseExclusive',
      ),
      tipInclusive: fullSha(auditedRange['tipInclusive'], '$.auditedRange.tipInclusive'),
      commitCount: integerValue(auditedRange['commitCount'], '$.auditedRange.commitCount'),
      orderedCommitSequenceSha256: sequenceDigest,
    }),
    vocabularies: Object.freeze({
      phases: stringArray(vocabularies['phases'], '$.vocabularies.phases'),
      dispositions: stringArray(vocabularies['dispositions'], '$.vocabularies.dispositions'),
    }),
    dispositionCounts: Object.freeze(dispositionCounts),
    currentEvidenceCatalog: decodeNamedCatalog(
      root['currentEvidenceCatalog'],
      '$.currentEvidenceCatalog',
      decodeEvidence,
    ),
    testProofCatalog: decodeNamedCatalog(
      root['testProofCatalog'],
      '$.testProofCatalog',
      decodeProof,
    ),
    commits: Object.freeze(
      commitsRaw.map((entry, index) => decodeCommit(entry, `$.commits[${index}]`)),
    ),
  });
}

function git(repoRoot: string, args: readonly string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

function isAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `git merge-base --is-ancestor failed with status ${String(result.status)}: ${result.stderr}`,
  );
}

function orderedCommitSequenceDigest(commits: readonly CommitDisposition[]): string {
  const payload = commits
    .map((commit) => [commit.ordinal, commit.sha, commit.subject].join('\0'))
    .join('\n');
  return createHash('sha256')
    .update(`admin-panel-branch-commit-sequence.v1\0${payload}`)
    .digest('hex');
}

function assertLocationsExist(repoRoot: string, locations: readonly string[], path: string): void {
  for (const [index, location] of locations.entries()) {
    if (!existsSync(resolve(repoRoot, location))) {
      fail(`${path}.locations[${index}]`, `repository location does not exist: ${location}`);
    }
  }
}

export function compileReconciliationAuthority(
  options: ReconciliationCompilerOptions,
): ReconciliationCompilation {
  const raw: unknown = JSON.parse(readFileSync(options.authorityPath, 'utf8'));
  const authority = decodeAuthority(raw);
  if (authority.schemaVersion !== 'admin-panel-branch-reconciliation.v1') {
    fail('$.schemaVersion', `unsupported version ${authority.schemaVersion}`);
  }
  if (authority.authority !== 'admin-panel-branch-commit-disposition') {
    fail('$.authority', `unsupported authority ${authority.authority}`);
  }

  const phases = new Set(authority.vocabularies.phases);
  const dispositions = new Set(authority.vocabularies.dispositions);
  if (Object.keys(authority.dispositionCounts).length !== dispositions.size) {
    fail('$.dispositionCounts', 'must declare exactly every disposition vocabulary member');
  }
  for (const disposition of dispositions) {
    if (authority.dispositionCounts[disposition] === undefined) {
      fail('$.dispositionCounts', `missing ${disposition}`);
    }
  }

  const commitShas = new Set<string>();
  const actualCounts: Record<string, number> = Object.fromEntries(
    [...dispositions].map((disposition) => [disposition, 0]),
  );
  for (const [index, commit] of authority.commits.entries()) {
    const path = `$.commits[${index}]`;
    if (commit.ordinal !== index + 1) fail(`${path}.ordinal`, `expected ${index + 1}`);
    if (commitShas.has(commit.sha)) fail(`${path}.sha`, 'duplicate commit OID');
    commitShas.add(commit.sha);
    if (!phases.has(commit.phase)) fail(`${path}.phase`, `unknown phase ${commit.phase}`);
    if (!dispositions.has(commit.disposition)) {
      fail(`${path}.disposition`, `unknown disposition ${commit.disposition}`);
    }
    actualCounts[commit.disposition] = (actualCounts[commit.disposition] ?? 0) + 1;
    for (const id of commit.currentEvidence) {
      if (authority.currentEvidenceCatalog[id] === undefined) {
        fail(`${path}.currentEvidence`, `unknown evidence ${id}`);
      }
    }
    for (const id of commit.testProof) {
      if (authority.testProofCatalog[id] === undefined) {
        fail(`${path}.testProof`, `unknown test proof ${id}`);
      }
    }
  }
  if (authority.commits.length !== authority.auditedRange.commitCount) {
    fail('$.auditedRange.commitCount', `expected ${authority.commits.length}`);
  }
  for (const disposition of dispositions) {
    if (authority.dispositionCounts[disposition] !== actualCounts[disposition]) {
      fail(`$.dispositionCounts.${disposition}`, `expected ${String(actualCounts[disposition])}`);
    }
  }

  for (const [id, evidence] of Object.entries(authority.currentEvidenceCatalog)) {
    assertLocationsExist(options.repoRoot, evidence.locations, `$.currentEvidenceCatalog.${id}`);
  }
  for (const [id, proof] of Object.entries(authority.testProofCatalog)) {
    assertLocationsExist(options.repoRoot, proof.locations, `$.testProofCatalog.${id}`);
  }

  const allPinnedOids = new Set([
    authority.auditedRange.mergeBaseExclusive,
    authority.auditedRange.tipInclusive,
    ...authority.sourceBranches.map((source) => source.tip),
    ...authority.commits.map((commit) => commit.sha),
  ]);
  for (const oid of allPinnedOids) {
    const type = git(options.repoRoot, ['cat-file', '-t', oid]);
    if (type !== 'commit') fail('$', `pinned OID ${oid} resolves to ${type}, not commit`);
    const resolved = git(options.repoRoot, ['rev-parse', '--verify', `${oid}^{commit}`]);
    if (resolved !== oid)
      fail('$', `pinned OID ${oid} resolved to mutable/different object ${resolved}`);
  }
  if (
    !isAncestor(
      options.repoRoot,
      authority.auditedRange.mergeBaseExclusive,
      authority.auditedRange.tipInclusive,
    )
  ) {
    fail('$.auditedRange', 'mergeBaseExclusive is not an ancestor of tipInclusive');
  }
  const gitSequence = git(options.repoRoot, [
    'rev-list',
    '--reverse',
    '--no-merges',
    `${authority.auditedRange.mergeBaseExclusive}..${authority.auditedRange.tipInclusive}`,
  ])
    .split('\n')
    .filter((entry) => entry.length > 0);
  const declaredSequence = authority.commits.map((commit) => commit.sha);
  if (
    gitSequence.length !== declaredSequence.length ||
    gitSequence.some((sha, index) => sha !== declaredSequence[index])
  ) {
    fail('$.commits', 'does not exactly equal pinned git rev-list --reverse --no-merges sequence');
  }
  for (const [index, commit] of authority.commits.entries()) {
    const subject = git(options.repoRoot, ['show', '-s', '--format=%s', commit.sha]);
    if (subject !== commit.subject) {
      fail(`$.commits[${index}].subject`, `git object subject is ${JSON.stringify(subject)}`);
    }
  }

  for (const [index, source] of authority.sourceBranches.entries()) {
    const path = `$.sourceBranches[${index}]`;
    const inAuditedSequence = commitShas.has(source.tip);
    switch (source.relationToAuditedRange) {
      case 'BASELINE_REF':
        if (inAuditedSequence) fail(path, 'baseline tip must not be inside the audited sequence');
        break;
      case 'ANCESTOR_OF_AUDITED_TIP':
        if (
          !inAuditedSequence ||
          !isAncestor(options.repoRoot, source.tip, authority.auditedRange.tipInclusive)
        ) {
          fail(path, 'declared ancestor tip is not an audited-sequence ancestor');
        }
        break;
      case 'AUDITED_TIP':
        if (source.tip !== authority.auditedRange.tipInclusive) {
          fail(path, 'audited tip does not equal tipInclusive');
        }
        break;
      case 'OUTSIDE_AUDITED_RANGE':
        if (
          inAuditedSequence ||
          isAncestor(options.repoRoot, source.tip, authority.auditedRange.tipInclusive)
        ) {
          fail(path, 'outside tip is inside or ancestral to the audited range');
        }
        break;
    }
  }

  const sequenceDigest = orderedCommitSequenceDigest(authority.commits);
  if (sequenceDigest !== authority.auditedRange.orderedCommitSequenceSha256) {
    fail('$.auditedRange.orderedCommitSequenceSha256', `expected ${sequenceDigest}`);
  }

  const unresolvedCommits = authority.commits.filter((commit) => {
    const evidenceOpen = commit.currentEvidence.some(
      (id) => authority.currentEvidenceCatalog[id]?.state === 'OPEN',
    );
    const proofUnsatisfied = commit.testProof.some(
      (id) => authority.testProofCatalog[id]?.status === 'NOT_SATISFIED',
    );
    if (commit.disposition === 'STILL_OPEN' && (!evidenceOpen || !proofUnsatisfied)) {
      fail(
        `$.commits[${commit.ordinal - 1}]`,
        'STILL_OPEN requires both OPEN evidence and NOT_SATISFIED proof',
      );
    }
    if (commit.disposition !== 'STILL_OPEN' && (evidenceOpen || proofUnsatisfied)) {
      fail(
        `$.commits[${commit.ordinal - 1}]`,
        'closed disposition may not cite OPEN evidence or NOT_SATISFIED proof',
      );
    }
    return commit.disposition === 'STILL_OPEN';
  });
  if (options.requireClosed === true && unresolvedCommits.length > 0) {
    fail(
      '$.commits',
      `${unresolvedCommits.length} commits remain STILL_OPEN: ${unresolvedCommits
        .map((commit) => `${commit.ordinal}:${commit.sha}`)
        .join(', ')}`,
    );
  }

  return Object.freeze({
    authority,
    orderedCommitSequenceSha256: sequenceDigest,
    dispositionCounts: Object.freeze(actualCounts),
    unresolvedCommits: Object.freeze(unresolvedCommits),
  });
}

export const DEFAULT_RECONCILIATION_AUTHORITY_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs/evidence/admin-panel-branch-reconciliation/reconciliation-authority.v1.json',
);
