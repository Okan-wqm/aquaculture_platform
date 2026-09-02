import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, sha256File } from './canonical.mjs';
import { loadTargetAuthority } from './target-manifest.mjs';

const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactRef = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const allowedPlan = 'docs/plans/2026-09-01-new-aria-autonomous-engineering/';
const allowedFiles = new Set([
  'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
  'tools/quality/format-scope.json',
]);
const protectedPrefixes = [
  'aria-kernel/',
  'tools/aria-poc/',
  'docs/aria/',
  '.claude/agents/aria-',
  '.github/workflows/',
  'apps/aria-service/',
  'web/modules/aria/',
];

function add(errors, code, message) {
  errors.push({ code, message });
}

function git(repositoryRoot, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repositoryRoot,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = encoding === 'utf8' ? result.stderr.trim() : 'binary command failed';
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function resolveCommit(repositoryRoot, value) {
  return git(repositoryRoot, ['rev-parse', '--verify', `${value}^{commit}`]).trim();
}

function committedEntries(raw) {
  const tokens = raw.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    index += 1;
    const oldPath = tokens[index];
    index += 1;
    if (/^[RC]/u.test(status)) {
      entries.push({ status, oldPath, newPath: tokens[index] });
      index += 1;
    } else {
      entries.push({ status, oldPath, newPath: null });
    }
  }
  return entries;
}

function scopePaths(entries) {
  return entries.flatMap((entry) =>
    entry.newPath ? [entry.oldPath, entry.newPath] : [entry.oldPath],
  );
}

function verifyScope(errors, paths) {
  for (const path of paths) {
    if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) {
      add(errors, 'PROTECTED_SCOPE', path);
    } else if (!path.startsWith(allowedPlan) && !allowedFiles.has(path)) {
      add(errors, 'PRODUCT_SCOPE', path);
    }
  }
}

const shaFields = [
  ['baseSha', 'base'],
  ['headSha', 'head'],
  ['baseTree', 'base tree'],
  ['headTree', 'head tree'],
];
const digestFields = [
  ['diffSha256', 'committed diff'],
  ['designSha256', 'design'],
  ['formatScopeSha256', 'format scope'],
];

function validateFields(errors, target, fields, pattern, message) {
  for (const [field, label] of fields) {
    if (!pattern.test(target[field] ?? '')) add(errors, 'TARGET_INPUT', `${label} ${message}`);
  }
}

function validateReviewedRef(errors, target) {
  if (!exactRef.test(target.reviewedRef ?? '') || target.reviewedRef.includes('..')) {
    add(errors, 'TARGET_INPUT', 'reviewed ref must be a canonical heads/remotes ref');
  }
}

function validateTargetInput(errors, target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    add(errors, 'TARGET_INPUT', 'target must be an object');
    return;
  }
  validateFields(errors, target, shaFields, exactSha, 'must be exact SHA');
  validateFields(errors, target, digestFields, exactDigest, 'must be exact SHA-256');
  validateReviewedRef(errors, target);
}

function targetFacts(repositoryRoot, target) {
  const baseSha = resolveCommit(repositoryRoot, target.baseSha);
  const headSha = resolveCommit(repositoryRoot, target.headSha);
  const reviewedRefSha = resolveCommit(repositoryRoot, target.reviewedRef);
  const checkoutSha = resolveCommit(repositoryRoot, 'HEAD');
  const baseTree = git(repositoryRoot, ['rev-parse', '--verify', `${baseSha}^{tree}`]).trim();
  const headTree = git(repositoryRoot, ['rev-parse', '--verify', `${headSha}^{tree}`]).trim();
  const diff = git(
    repositoryRoot,
    [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      '--find-copies',
      `${baseSha}..${headSha}`,
      '--',
    ],
    null,
  );
  return {
    base_sha: baseSha,
    base_tree: baseTree,
    head_sha: headSha,
    head_tree: headTree,
    reviewed_ref: target.reviewedRef,
    reviewed_ref_sha: reviewedRefSha,
    checkout_sha: checkoutSha,
    committed_diff_sha256: sha256(diff),
    committed_entries: committedEntries(diff),
    design_sha256: sha256File(
      join(
        repositoryRoot,
        'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md',
      ),
    ),
    format_scope_sha256: sha256File(join(repositoryRoot, 'tools/quality/format-scope.json')),
  };
}

function verifyDeclaredFacts(errors, facts, target) {
  for (const [code, actual, expected] of [
    ['TARGET_BASE_TREE', facts.base_tree, target.baseTree],
    ['TARGET_HEAD_TREE', facts.head_tree, target.headTree],
    ['TARGET_DIFF', facts.committed_diff_sha256, target.diffSha256],
    ['TARGET_DESIGN', facts.design_sha256, target.designSha256],
    ['TARGET_FORMAT_SCOPE', facts.format_scope_sha256, target.formatScopeSha256],
  ]) {
    if (actual !== expected) add(errors, code, `${actual} != ${expected}`);
  }
}

function verifyManifestBinding(errors, repositoryRoot, target, authority) {
  try {
    const { manifest, target: signed } = loadTargetAuthority(repositoryRoot, authority);
    for (const [field, actual, expected] of [
      ['base SHA', target.baseSha, manifest.base_sha],
      ['head SHA', target.headSha, signed.head_sha],
      ['reviewed ref', target.reviewedRef, signed.reviewed_ref],
      ['base tree', target.baseTree, signed.base_tree],
      ['head tree', target.headTree, signed.head_tree],
      ['diff digest', target.diffSha256, signed.committed_diff_sha256],
      ['design digest', target.designSha256, signed.design_sha256],
      ['format-scope digest', target.formatScopeSha256, signed.format_scope_sha256],
    ]) {
      if (actual !== expected) add(errors, 'TARGET_MANIFEST', `${field} is not canonical`);
    }
    if (resolveCommit(repositoryRoot, manifest.base_ref) !== manifest.base_sha) {
      add(errors, 'TARGET_MANIFEST', 'canonical base ref does not resolve to canonical base SHA');
    }
    const canonicalTree = git(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${manifest.base_sha}^{tree}`,
    ]).trim();
    if (canonicalTree !== manifest.base_tree) {
      add(errors, 'TARGET_MANIFEST', 'canonical base tree does not match canonical base SHA');
    }
  } catch (error) {
    add(errors, 'TARGET_MANIFEST', error instanceof Error ? error.message : String(error));
  }
}

function verifyReachability(errors, repositoryRoot, facts) {
  if (facts.base_sha === facts.head_sha) add(errors, 'TARGET_RANGE', 'base and head must differ');
  if (facts.checkout_sha !== facts.head_sha) add(errors, 'TARGET_HEAD', 'checkout HEAD mismatch');
  if (facts.reviewed_ref_sha !== facts.head_sha)
    add(errors, 'TARGET_REF', 'reviewed ref does not resolve to head');
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', facts.base_sha, facts.head_sha],
    {
      cwd: repositoryRoot,
    },
  );
  if (ancestor.status !== 0) add(errors, 'TARGET_REACHABILITY', 'base is not ancestor of head');
}

export function verifyTarget(repositoryRoot, target, authority = {}) {
  const errors = [];
  validateTargetInput(errors, target);
  if (errors.length > 0) return { errors, facts: null };
  verifyManifestBinding(errors, repositoryRoot, target, authority);
  try {
    const facts = targetFacts(repositoryRoot, target);
    verifyReachability(errors, repositoryRoot, facts);
    verifyDeclaredFacts(errors, facts, target);
    verifyScope(errors, scopePaths(facts.committed_entries));
    const dirty = git(
      repositoryRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      null,
    );
    if (dirty.length > 0)
      add(errors, 'WORKTREE_DIRTY', 'tracked, staged, or untracked bytes present');
    return { errors, facts };
  } catch (error) {
    add(errors, 'TARGET_RESOLUTION', error instanceof Error ? error.message : String(error));
    return { errors, facts: null };
  }
}
