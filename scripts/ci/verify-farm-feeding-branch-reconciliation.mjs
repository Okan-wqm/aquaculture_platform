import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const AUTHORITY_PATH = join(REPO_ROOT, 'tools/quality/farm-feeding-branch-reconciliation.json');
const HASH_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SOURCE_FINDING_PATTERN =
  /^docs\/reviews\/[A-Za-z0-9._/-]+\.md#[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-[0-9]+$/;
const SYNTHETIC_CLAIM_PATTERN = /^SOURCE-COMMIT:[0-9a-f]{40}$/;
const EVIDENCE_KINDS = new Set(['AUTHORITY', 'GOVERNANCE', 'TEST']);
const SELF_EVIDENCE_PATHS = new Set([
  'scripts/ci/verify-farm-feeding-branch-reconciliation.mjs',
  'tests/invariants/farm-feeding-branch-reconciliation.spec.ts',
  'tools/quality/farm-feeding-branch-reconciliation.json',
]);
const CLAIM_PROFILES = new Map([
  ['IMPLEMENTATION_TEST', 'INTEGRATED'],
  ['REPLACEMENT_TEST', 'SUPERSEDED'],
  ['BOUNDARY_EXCLUSION', 'EXCLUDED'],
  ['OPEN_REQUIRED_AUTHORITY', 'OPEN'],
]);

function fail(message) {
  throw new Error(`farm feeding branch reconciliation: ${message}`);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function evidenceIdForPath(path) {
  return `E:${sha256(path).slice(0, 16).toUpperCase()}`;
}

function sourceClaimId(source) {
  if (SYNTHETIC_CLAIM_PATTERN.test(source)) return source;
  return source.slice(source.lastIndexOf('#') + 1);
}

function gitText(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitBuffer(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has ordered keys [${actual.join(', ')}], expected [${expected.join(', ')}]`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail(`${label} must be a non-empty, trim-stable string`);
  }
}

function fullCommit(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be an immutable full commit SHA`);
  }
  gitText(['cat-file', '-e', `${value}^{commit}`]);
}

function safeRepoPath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('..') ||
    value.includes('\\')
  ) {
    fail(`${label} is not a safe repository-relative path`);
  }
  const resolved = resolve(REPO_ROOT, value);
  if (!resolved.startsWith(`${REPO_ROOT}/`)) {
    fail(`${label} escapes the repository root`);
  }
  return resolved;
}

function assertExactRef(ref, expected, label) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
    fail(`${label} must use an exact refs/... coordinate`);
  }
  const actual = gitText(['show-ref', '--verify', '--hash', ref]);
  if (actual !== expected) {
    fail(`${label} drifted: ${ref} resolves to ${actual}, expected ${expected}`);
  }
}

function isAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.status === 1) return false;
    throw error;
  }
}

function canonicalSourceHistory(source) {
  const sequence = gitText([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${source.synchronizationBase}..${source.tip}`,
  ])
    .split('\n')
    .filter(Boolean);
  const rows = sequence.map((commit) => {
    const parents = gitText(['show', '-s', '--format=%P', commit]).split(' ').filter(Boolean);
    const firstParent = parents[0];
    if (firstParent === undefined) fail(`source commit ${commit} has no first parent`);
    return {
      sha: commit,
      parents,
      patchSha256: sha256(
        gitBuffer([
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-renames',
          firstParent,
          commit,
        ]),
      ),
      changeSetSha256: sha256(
        gitBuffer(['diff', '--name-status', '-z', '--no-renames', firstParent, commit]),
      ),
    };
  });
  return {
    sequence,
    rows,
    digest: sha256(`${JSON.stringify(rows)}\n`),
  };
}

function sourceClaims(commit) {
  const body = gitText(['show', '-s', '--format=%B', commit]);
  const claims = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('Closes:')) continue;
    const match =
      /^Closes: (docs\/reviews\/[A-Za-z0-9._/-]+\.md#[A-Z]+-(?:CRITICAL|HIGH|MEDIUM|LOW)-[0-9]+)$/.exec(
        line,
      );
    if (match === null) fail(`source commit ${commit} has malformed Closes trailer: ${line}`);
    claims.push(match[1]);
  }
  return claims.length === 0 ? [`SOURCE-COMMIT:${commit}`] : [...new Set(claims)].sort();
}

function readAuthority() {
  if (process.argv.length === 3 && process.argv[2] === '--stdin') {
    const authority = JSON.parse(readFileSync(0, 'utf8'));
    return { authority, authoritySha256: sha256(canonicalJson(authority)) };
  }
  if (process.argv.length !== 2)
    fail('usage: verify-farm-feeding-branch-reconciliation.mjs [--stdin]');
  const raw = readFileSync(AUTHORITY_PATH, 'utf8');
  const authority = JSON.parse(raw);
  return { authority, authoritySha256: sha256(canonicalJson(authority)) };
}

function validateSource(authority) {
  exactKeys(
    authority.source,
    ['ref', 'forkParent', 'synchronizationBase', 'tip', 'commitCount', 'historySha256'],
    'source',
  );
  fullCommit(authority.source.forkParent, 'source.forkParent');
  fullCommit(authority.source.synchronizationBase, 'source.synchronizationBase');
  fullCommit(authority.source.tip, 'source.tip');
  assertExactRef(authority.source.ref, authority.source.tip, 'source.ref');
  if (!Number.isSafeInteger(authority.source.commitCount) || authority.source.commitCount < 1) {
    fail('source.commitCount must be a positive safe integer');
  }
  if (!SHA256_PATTERN.test(authority.source.historySha256)) {
    fail('source.historySha256 must be SHA-256');
  }
  const history = canonicalSourceHistory(authority.source);
  if (history.sequence.length !== authority.source.commitCount) {
    fail(
      `source commit count is ${history.sequence.length}, expected ${authority.source.commitCount}`,
    );
  }
  if (history.digest !== authority.source.historySha256) {
    fail(
      `source canonical history digest is ${history.digest}, expected ${authority.source.historySha256}`,
    );
  }
  if (history.rows[0].parents[0] !== authority.source.forkParent) {
    fail('source first commit does not continue forkParent');
  }
  if (history.sequence[history.sequence.length - 1] !== authority.source.tip) {
    fail('source first-parent sequence does not terminate at source.tip');
  }
  for (const [index, row] of history.rows.entries()) {
    const expectedFirstParent =
      index === 0 ? authority.source.forkParent : history.rows[index - 1].sha;
    if (row.parents[0] !== expectedFirstParent) {
      fail(`source commit ${row.sha} breaks the declared first-parent chain`);
    }
    const isMerge = row.sha === authority.mergePolicy.commit;
    if ((!isMerge && row.parents.length !== 1) || (isMerge && row.parents.length !== 2)) {
      fail(`source commit ${row.sha} has an undeclared parent topology`);
    }
  }
  if (
    gitText(['merge-base', authority.source.tip, authority.candidateGraph.baseline]) !==
    authority.source.synchronizationBase
  ) {
    fail('source/candidate merge-base differs from synchronizationBase');
  }
  return history;
}

function validateCandidateGraph(candidateGraph) {
  exactKeys(
    candidateGraph,
    ['baseline', 'mainRef', 'mainSnapshot', 'mainAdvanceSha256', 'headPolicy'],
    'candidateGraph',
  );
  fullCommit(candidateGraph.baseline, 'candidateGraph.baseline');
  fullCommit(candidateGraph.mainSnapshot, 'candidateGraph.mainSnapshot');
  assertExactRef(candidateGraph.mainRef, candidateGraph.mainSnapshot, 'candidateGraph.mainRef');
  if (candidateGraph.headPolicy !== 'BASELINE_OR_MAIN_SNAPSHOT_MERGED') {
    fail('candidateGraph.headPolicy must be BASELINE_OR_MAIN_SNAPSHOT_MERGED');
  }
  if (!isAncestor(candidateGraph.baseline, candidateGraph.mainSnapshot)) {
    fail('candidate baseline is not an ancestor of the pinned main snapshot');
  }
  const advanceDigest = sha256(
    gitBuffer([
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-renames',
      candidateGraph.baseline,
      candidateGraph.mainSnapshot,
    ]),
  );
  if (advanceDigest !== candidateGraph.mainAdvanceSha256) {
    fail(
      `candidate main-advance digest is ${advanceDigest}, expected ${candidateGraph.mainAdvanceSha256}`,
    );
  }
  const head = gitText(['rev-parse', 'HEAD']);
  const headIsBaseline = head === candidateGraph.baseline;
  const headContainsBoth =
    isAncestor(candidateGraph.baseline, head) && isAncestor(candidateGraph.mainSnapshot, head);
  if (!headIsBaseline && !headContainsBoth) {
    fail(
      'HEAD is neither the exact candidate baseline nor a merge containing baseline + mainSnapshot',
    );
  }
  return { head, headState: headIsBaseline ? 'BASELINE' : 'MAIN_SNAPSHOT_MERGED' };
}

function validateMergePolicy(authority, history) {
  exactKeys(
    authority.mergePolicy,
    [
      'commit',
      'requiredParentCount',
      'secondParentAuthority',
      'evidenceAuthority',
      'feedingScopePrefixes',
    ],
    'mergePolicy',
  );
  fullCommit(authority.mergePolicy.commit, 'mergePolicy.commit');
  if (
    authority.mergePolicy.requiredParentCount !== 2 ||
    authority.mergePolicy.secondParentAuthority !== 'source.synchronizationBase' ||
    authority.mergePolicy.evidenceAuthority !== 'commit-conflict-list'
  ) {
    fail('mergePolicy does not declare the exact two-parent synchronization contract');
  }
  const prefixes = authority.mergePolicy.feedingScopePrefixes;
  if (
    !Array.isArray(prefixes) ||
    prefixes.length === 0 ||
    prefixes.some((prefix) => {
      if (typeof prefix !== 'string') return true;
      return isAbsolute(prefix) || prefix.includes('..') || prefix.startsWith('/');
    })
  ) {
    fail('mergePolicy.feedingScopePrefixes is unsafe or empty');
  }
  const row = history.rows.find((candidate) => candidate.sha === authority.mergePolicy.commit);
  if (row === undefined) fail('mergePolicy.commit is not in the source history');
  if (
    row.parents.length !== authority.mergePolicy.requiredParentCount ||
    row.parents[1] !== authority.source.synchronizationBase
  ) {
    fail('mergePolicy.commit parents violate the synchronization contract');
  }
}

function validateEvidenceCatalog(authority) {
  if (!Array.isArray(authority.evidenceCatalog) || authority.evidenceCatalog.length === 0) {
    fail('evidenceCatalog must be a non-empty array');
  }
  const catalog = new Map();
  const catalogPaths = new Set();
  let previousId = '';
  for (const [index, entry] of authority.evidenceCatalog.entries()) {
    exactKeys(entry, ['id', 'path', 'kind', 'sha256'], `evidenceCatalog[${index}]`);
    if (typeof entry.id !== 'string' || !SAFE_ID_PATTERN.test(entry.id)) {
      fail(`evidenceCatalog[${index}].id is invalid`);
    }
    const resolved = safeRepoPath(entry.path, `evidenceCatalog[${index}].path`);
    if (catalogPaths.has(entry.path)) {
      fail(`duplicate evidence path ${entry.path}`);
    }
    catalogPaths.add(entry.path);
    if (entry.id <= previousId) fail('evidenceCatalog must be sorted by unique id');
    previousId = entry.id;
    const expectedId = evidenceIdForPath(entry.path);
    if (entry.id !== expectedId) {
      fail(`evidenceCatalog[${index}].id must be ${expectedId}, derived from its path`);
    }
    if (!EVIDENCE_KINDS.has(entry.kind)) {
      fail(`evidenceCatalog[${index}].kind is invalid`);
    }
    if (!SHA256_PATTERN.test(entry.sha256)) {
      fail(`evidenceCatalog[${index}].sha256 is invalid`);
    }
    if (SELF_EVIDENCE_PATHS.has(entry.path)) {
      fail(
        `evidenceCatalog[${index}] attempts to use the reconciliation authority as its own proof`,
      );
    }
    const metadata = lstatSync(resolved);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail(`evidenceCatalog[${index}] must resolve to a regular non-symlink file`);
    }
    if (realpathSync(resolved) !== resolved) {
      fail(`evidenceCatalog[${index}] resolves through a symbolic-link ancestor`);
    }
    const actualHash = sha256(readFileSync(resolved));
    if (actualHash !== entry.sha256) {
      fail(`evidence ${entry.id} hash is ${actualHash}, expected ${entry.sha256}`);
    }
    if (catalog.has(entry.id)) fail(`duplicate evidence id ${entry.id}`);
    catalog.set(entry.id, entry);
  }
  return catalog;
}

function validateBoundaries(authority) {
  if (!Array.isArray(authority.exclusionBoundaries) || authority.exclusionBoundaries.length === 0) {
    fail('exclusionBoundaries must explicitly declare the bounded exclusions');
  }
  const boundaries = new Map();
  let previousBoundaryId = '';
  for (const [index, boundary] of authority.exclusionBoundaries.entries()) {
    exactKeys(boundary, ['id', 'allowedCommits', 'rationale'], `exclusionBoundaries[${index}]`);
    if (typeof boundary.id !== 'string' || !SAFE_ID_PATTERN.test(boundary.id)) {
      fail(`exclusionBoundaries[${index}].id is invalid`);
    }
    if (boundary.id <= previousBoundaryId) {
      fail('exclusionBoundaries must be sorted by unique id');
    }
    previousBoundaryId = boundary.id;
    if (!Array.isArray(boundary.allowedCommits) || boundary.allowedCommits.length === 0) {
      fail(`exclusionBoundaries[${index}] has no allowed commits`);
    }
    const sortedCommits = [...new Set(boundary.allowedCommits)].sort();
    if (
      sortedCommits.length !== boundary.allowedCommits.length ||
      sortedCommits.some((commit, commitIndex) => commit !== boundary.allowedCommits[commitIndex])
    ) {
      fail(`${boundary.id}.allowedCommits must be unique and sorted`);
    }
    for (const commit of boundary.allowedCommits)
      fullCommit(commit, `${boundary.id}.allowedCommits`);
    nonEmptyString(boundary.rationale, `${boundary.id}.rationale`);
    if (boundaries.has(boundary.id)) fail(`duplicate exclusion boundary ${boundary.id}`);
    boundaries.set(boundary.id, boundary);
  }
  return boundaries;
}

function validateProof(proof, disposition, label, evidenceCatalog, boundaries, commit) {
  const expectedDisposition = CLAIM_PROFILES.get(proof.profile);
  if (expectedDisposition === undefined || expectedDisposition !== disposition) {
    fail(`${label}.profile ${String(proof.profile)} cannot prove ${disposition}`);
  }
  if (proof.profile === 'OPEN_REQUIRED_AUTHORITY') {
    exactKeys(proof, ['profile', 'requiredAuthority', 'owner', 'deadline'], label);
    nonEmptyString(proof.requiredAuthority, `${label}.requiredAuthority`);
    if (!SAFE_ID_PATTERN.test(proof.requiredAuthority)) {
      fail(`${label}.requiredAuthority must be a stable authority id`);
    }
    nonEmptyString(proof.owner, `${label}.owner`);
    if (
      typeof proof.deadline !== 'string' ||
      !/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(proof.deadline)
    ) {
      fail(`${label}.deadline must be an ISO calendar date`);
    }
    return [];
  }
  if (proof.profile === 'BOUNDARY_EXCLUSION') {
    exactKeys(proof, ['profile', 'boundary', 'evidence'], label);
    const boundary = boundaries.get(proof.boundary);
    if (boundary === undefined || !boundary.allowedCommits.includes(commit)) {
      fail(`${label} uses an unapproved exclusion boundary for ${commit}`);
    }
  } else {
    exactKeys(proof, ['profile', 'evidence'], label);
  }
  if (!Array.isArray(proof.evidence) || proof.evidence.length === 0) {
    fail(`${label}.evidence must be non-empty`);
  }
  const ids = [...new Set(proof.evidence)];
  if (ids.length !== proof.evidence.length || [...ids].sort().some((id, i) => id !== ids[i])) {
    fail(`${label}.evidence must be unique and sorted`);
  }
  const entries = ids.map((id) => {
    const entry = evidenceCatalog.get(id);
    if (entry === undefined) fail(`${label} references unknown evidence ${String(id)}`);
    return entry;
  });
  if (proof.profile === 'IMPLEMENTATION_TEST' || proof.profile === 'REPLACEMENT_TEST') {
    if (!entries.some((entry) => entry.kind === 'AUTHORITY')) {
      fail(`${label} has no content-addressed AUTHORITY coordinate`);
    }
    if (!entries.some((entry) => entry.kind === 'TEST')) {
      fail(`${label} has no content-addressed TEST coordinate`);
    }
  }
  if (
    proof.profile === 'BOUNDARY_EXCLUSION' &&
    !entries.some((entry) => entry.kind === 'GOVERNANCE')
  ) {
    fail(`${label} has no content-addressed GOVERNANCE coordinate`);
  }
  return ids;
}

function validateCommits(authority, history, evidenceCatalog, boundaries) {
  if (!Array.isArray(authority.commits) || authority.commits.length !== history.sequence.length) {
    fail('commits must contain the complete source first-parent sequence');
  }
  const declaredSequence = authority.commits.map((entry) => entry.sha);
  if (declaredSequence.some((sha, index) => sha !== history.sequence[index])) {
    fail('commits differ from the immutable source first-parent sequence');
  }
  const occurrenceCounts = {
    EXCLUDED: 0,
    INTEGRATED: 0,
    MERGE_SYNC: 0,
    OPEN: 0,
    SUPERSEDED: 0,
  };
  const claimStates = new Map();
  const claimIdsBySource = new Map();
  const proofWitnesses = [];
  const usedEvidence = new Set();
  const usedBoundaries = new Set();
  for (const [index, entry] of authority.commits.entries()) {
    if (entry.sha === authority.mergePolicy.commit) {
      exactKeys(entry, ['sha', 'kind', 'intent', 'conflictPaths'], `commits[${index}]`);
      if (entry.kind !== 'MERGE_SYNC') fail(`commits[${index}] must be MERGE_SYNC`);
      nonEmptyString(entry.intent, `commits[${index}].intent`);
      if (!Array.isArray(entry.conflictPaths) || entry.conflictPaths.length === 0) {
        fail(`commits[${index}] has no conflictPaths`);
      }
      const body = gitText(['show', '-s', '--format=%B', entry.sha]);
      for (const conflictPath of entry.conflictPaths) {
        safeRepoPath(conflictPath, `commits[${index}].conflictPaths`);
        if (!body.includes(conflictPath)) {
          fail(`commits[${index}] conflict path is absent from the merge body: ${conflictPath}`);
        }
      }
      const row = history.rows[index];
      const changedPaths = gitBuffer(['diff', '--name-only', '-z', row.parents[0], entry.sha])
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      const feedingChanges = changedPaths.filter((path) =>
        authority.mergePolicy.feedingScopePrefixes.some((prefix) => path.startsWith(prefix)),
      );
      if (feedingChanges.length > 0) {
        fail(`merge sync publishes feeding paths: ${feedingChanges.join(', ')}`);
      }
      occurrenceCounts.MERGE_SYNC += 1;
      proofWitnesses.push(`${entry.sha}\0MERGE_SYNC\0${entry.conflictPaths.join('\0')}`);
      continue;
    }

    exactKeys(entry, ['sha', 'kind', 'intent', 'claimSets'], `commits[${index}]`);
    if (entry.kind !== 'CHANGE') fail(`commits[${index}] must be CHANGE`);
    nonEmptyString(entry.intent, `commits[${index}].intent`);
    if (!Array.isArray(entry.claimSets) || entry.claimSets.length === 0) {
      fail(`commits[${index}] has no typed claimSets`);
    }
    const actualSources = sourceClaims(entry.sha);
    const declaredSourceSet = new Set();
    const declaredClaimsBySource = new Map();
    const claimIds = new Set();
    for (const [claimSetIndex, claimSet] of entry.claimSets.entries()) {
      const claimLabel = `commits[${index}].claimSets[${claimSetIndex}]`;
      exactKeys(claimSet, ['claims', 'disposition', 'proof', 'rationale'], claimLabel);
      if (!Array.isArray(claimSet.claims) || claimSet.claims.length !== 1) {
        fail(`${claimLabel}.claims must contain exactly one atomic claim`);
      }
      nonEmptyString(claimSet.rationale, `${claimLabel}.rationale`);
      for (const [claimIndex, claim] of claimSet.claims.entries()) {
        exactKeys(claim, ['id', 'source'], `${claimLabel}.claims[${claimIndex}]`);
        if (typeof claim.id !== 'string' || !SAFE_ID_PATTERN.test(claim.id)) {
          fail(`${claimLabel}.claims[${claimIndex}].id is invalid`);
        }
        if (claimIds.has(claim.id)) fail(`duplicate claim id ${claim.id} in ${entry.sha}`);
        claimIds.add(claim.id);
        if (
          typeof claim.source !== 'string' ||
          (!SOURCE_FINDING_PATTERN.test(claim.source) &&
            !SYNTHETIC_CLAIM_PATTERN.test(claim.source))
        ) {
          fail(`${claimLabel}.claims[${claimIndex}].source is invalid`);
        }
        const sourceId = sourceClaimId(claim.source);
        if (claim.id !== sourceId && !claim.id.startsWith(`${sourceId}.`)) {
          fail(
            `${claimLabel}.claims[${claimIndex}].id must match source claim ${sourceId} or be its strict subclaim`,
          );
        }
        const globalIdsForSource = claimIdsBySource.get(claim.source) ?? new Set();
        globalIdsForSource.add(claim.id);
        claimIdsBySource.set(claim.source, globalIdsForSource);
        const claimsForSource = declaredClaimsBySource.get(claim.source) ?? [];
        claimsForSource.push(claim.id);
        declaredClaimsBySource.set(claim.source, claimsForSource);
        const readiness =
          claimSet.disposition === 'OPEN'
            ? 'OPEN'
            : claimSet.disposition === 'EXCLUDED'
              ? 'EXCLUDED'
              : 'CLOSED';
        const openContract = readiness === 'OPEN' ? canonicalJson(claimSet.proof) : null;
        const prior = claimStates.get(claim.id);
        if (prior !== undefined) {
          if (prior.source !== claim.source) {
            fail(
              `claim ${claim.id} maps to multiple source authorities: ${prior.source} and ${claim.source}`,
            );
          }
          if (prior.readiness !== readiness) {
            fail(
              `claim ${claim.id} has contradictory current readiness: ${prior.readiness} and ${readiness}`,
            );
          }
          if (prior.openContract !== openContract) {
            fail(`claim ${claim.id} has divergent open authority contracts`);
          }
          prior.dispositions.add(claimSet.disposition);
        } else {
          claimStates.set(claim.id, {
            source: claim.source,
            readiness,
            openContract,
            dispositions: new Set([claimSet.disposition]),
          });
        }
        declaredSourceSet.add(claim.source);
      }
      const evidenceIds = validateProof(
        claimSet.proof,
        claimSet.disposition,
        `${claimLabel}.proof`,
        evidenceCatalog,
        boundaries,
        entry.sha,
      );
      for (const evidenceId of evidenceIds) usedEvidence.add(evidenceId);
      if (claimSet.proof.profile === 'BOUNDARY_EXCLUSION') {
        usedBoundaries.add(claimSet.proof.boundary);
      }
      occurrenceCounts[claimSet.disposition] += claimSet.claims.length;
      proofWitnesses.push(
        `${entry.sha}\0${claimSet.disposition}\0${claimSet.claims
          .map((claim) => `${claim.id}:${claim.source}`)
          .join('\0')}\0${evidenceIds.join('\0')}`,
      );
    }
    for (const [source, ids] of declaredClaimsBySource) {
      if (ids.length <= 1) continue;
      const sourceId = sourceClaimId(source);
      if (ids.some((id) => id === sourceId)) {
        fail(
          `source claim ${source} is declared as both a base claim and subclaims in ${entry.sha}`,
        );
      }
    }
    if (
      declaredSourceSet.size !== actualSources.length ||
      actualSources.some((claim) => !declaredSourceSet.has(claim))
    ) {
      fail(
        `commits[${index}] source claim coverage differs: declared [${[...declaredSourceSet]
          .sort()
          .join(', ')}], actual [${actualSources.join(', ')}]`,
      );
    }
  }
  for (const [source, ids] of claimIdsBySource) {
    const sourceId = sourceClaimId(source);
    if (ids.size > 1 && ids.has(sourceId)) {
      fail(`source claim ${source} is declared as both a base claim and subclaims across commits`);
    }
  }
  const counts = {
    EXCLUDED: 0,
    INTEGRATED: 0,
    MERGE_SYNC: occurrenceCounts.MERGE_SYNC,
    OPEN: 0,
    SUPERSEDED: 0,
  };
  for (const claim of claimStates.values()) {
    if (claim.readiness === 'OPEN') {
      counts.OPEN += 1;
    } else if (claim.readiness === 'EXCLUDED') {
      counts.EXCLUDED += 1;
    } else if (claim.dispositions.has('INTEGRATED')) {
      counts.INTEGRATED += 1;
    } else {
      counts.SUPERSEDED += 1;
    }
  }
  return {
    counts,
    occurrenceCounts,
    uniqueClaimCount: claimStates.size,
    proofDigest: sha256(`${proofWitnesses.join('\n')}\n`),
    usedEvidence,
    usedBoundaries,
  };
}

const { authority, authoritySha256 } = readAuthority();
exactKeys(
  authority,
  [
    'schemaVersion',
    'source',
    'candidateGraph',
    'mergePolicy',
    'exclusionBoundaries',
    'evidenceCatalog',
    'commits',
  ],
  'authority',
);
if (authority.schemaVersion !== 'farm-feeding-branch-reconciliation/v3') {
  fail(`unsupported schemaVersion ${String(authority.schemaVersion)}`);
}
const candidate = validateCandidateGraph(authority.candidateGraph);
const history = validateSource(authority);
validateMergePolicy(authority, history);
const boundaries = validateBoundaries(authority);
const evidenceCatalog = validateEvidenceCatalog(authority);
const result = validateCommits(authority, history, evidenceCatalog, boundaries);
const unusedEvidence = [...evidenceCatalog.keys()].filter((id) => !result.usedEvidence.has(id));
if (unusedEvidence.length > 0) {
  fail(`evidenceCatalog contains orphan coordinates: ${unusedEvidence.join(', ')}`);
}
const unusedBoundaries = [...boundaries.keys()].filter((id) => !result.usedBoundaries.has(id));
if (unusedBoundaries.length > 0) {
  fail(`exclusionBoundaries contains unused authorities: ${unusedBoundaries.join(', ')}`);
}
const open = result.counts.OPEN;
const summary = {
  schemaVersion: authority.schemaVersion,
  sourceRef: authority.source.ref,
  pinnedTip: authority.source.tip,
  commitCount: history.sequence.length,
  historySha256: history.digest,
  candidateHead: candidate.head,
  candidateHeadState: candidate.headState,
  mainSnapshot: authority.candidateGraph.mainSnapshot,
  evidenceCount: evidenceCatalog.size,
  uniqueClaimCount: result.uniqueClaimCount,
  proofDigest: result.proofDigest,
  authoritySha256,
  counts: result.counts,
  occurrenceCounts: result.occurrenceCounts,
  open,
  publicationReady: open === 0,
  authority: relative(REPO_ROOT, AUTHORITY_PATH),
};
process.stdout.write(`${JSON.stringify(summary)}\n`);
