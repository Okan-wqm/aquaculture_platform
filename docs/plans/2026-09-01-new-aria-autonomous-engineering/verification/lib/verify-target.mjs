import { readFileSync, realpathSync } from 'node:fs';
import { canonicalJson, parseStrictJsonBytes, sha256 } from './canonical.mjs';
import { readCommitFile } from './git-objects.mjs';
import { createGitSession, runGit } from './hermetic-git.mjs';
import { verifyRuntimeDependencies } from './runtime-dependencies.mjs';
import { collectTargetFacts, resolveCommit } from './target-git-facts.mjs';
import { loadTargetAuthority, targetManifestPath } from './target-manifest.mjs';
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
function verifyNodeTool(tool) {
  const executable = realpathSync(process.execPath);
  const [major, minor] = tool.version.slice(1).split('.').map(Number);
  if (
    major < 20 ||
    (major === 20 && minor < 11) ||
    tool.version !== process.version ||
    sha256(readFileSync(executable)) !== tool.executable_sha256
  ) {
    throw new Error('Node executable does not match signed target tool facts');
  }
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

function verifyManifestBinding(errors, repositoryRoot, target, loaded, gitTool) {
  try {
    const { manifest, target: signed } = loaded;
    const manifestBytes = readCommitFile(
      repositoryRoot,
      signed.head_sha,
      { path: targetManifestPath },
      gitTool,
    ).bytes;
    if (
      sha256(manifestBytes) !== loaded.manifestSha256 ||
      canonicalJson(parseStrictJsonBytes(manifestBytes, 'committed target manifest')) !==
        canonicalJson(manifest)
    ) {
      add(errors, 'TARGET_MANIFEST', 'signed manifest does not match exact committed bytes');
    }
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
    if (resolveCommit(repositoryRoot, manifest.base_ref, gitTool) !== manifest.base_sha) {
      add(errors, 'TARGET_MANIFEST', 'canonical base ref does not resolve to canonical base SHA');
    }
    const canonicalTree = runGit(
      repositoryRoot,
      ['rev-parse', '--verify', `${manifest.base_sha}^{tree}`],
      gitTool,
    ).trim();
    if (canonicalTree !== manifest.base_tree) {
      add(errors, 'TARGET_MANIFEST', 'canonical base tree does not match canonical base SHA');
    }
  } catch (error) {
    add(errors, 'TARGET_MANIFEST', error instanceof Error ? error.message : String(error));
  }
}

function verifyReachability(errors, repositoryRoot, facts, gitTool) {
  if (facts.base_sha === facts.head_sha) add(errors, 'TARGET_RANGE', 'base and head must differ');
  if (facts.checkout_sha !== facts.head_sha) add(errors, 'TARGET_HEAD', 'checkout HEAD mismatch');
  if (facts.reviewed_ref_sha !== facts.head_sha)
    add(errors, 'TARGET_REF', 'reviewed ref does not resolve to head');
  try {
    runGit(
      repositoryRoot,
      ['merge-base', '--is-ancestor', facts.base_sha, facts.head_sha],
      gitTool,
    );
  } catch {
    add(errors, 'TARGET_REACHABILITY', 'base is not ancestor of head');
  }
}

const signedNames = {
  baseSha: 'base_sha',
  headSha: 'head_sha',
  reviewedRef: 'reviewed_ref',
  baseTree: 'base_tree',
  headTree: 'head_tree',
  diffSha256: 'committed_diff_sha256',
  designSha256: 'design_sha256',
  formatScopeSha256: 'format_scope_sha256',
};
const signedTargetInput = (target) =>
  Object.fromEntries(Object.entries(signedNames).map(([local, signed]) => [local, target[signed]]));

function verifyLoadedTarget(repositoryRoot, target, loaded, errors) {
  try {
    verifyNodeTool(loaded.target.node_tool);
    const git = createGitSession(loaded.target.git_tool);
    verifyManifestBinding(errors, repositoryRoot, target, loaded, git);
    const facts = collectTargetFacts(repositoryRoot, target, git);
    facts.node_tool = loaded.target.node_tool;
    facts.runtime_dependencies = loaded.target.runtime_dependencies;
    if (facts.package_lock_sha256 !== loaded.target.package_lock_sha256) {
      add(errors, 'TARGET_PACKAGE_LOCK', 'committed package-lock digest is not signed exactly');
    }
    verifyRuntimeDependencies(repositoryRoot, loaded.target);
    verifyReachability(errors, repositoryRoot, facts, git);
    verifyDeclaredFacts(errors, facts, target);
    verifyScope(errors, scopePaths(facts.committed_entries));
    const dirty = runGit(
      repositoryRoot,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      git,
      { encoding: null },
    );
    if (dirty.length > 0)
      add(errors, 'WORKTREE_DIRTY', 'repository has tracked, staged, or untracked bytes present');
    return { errors, facts, authority: loaded };
  } catch (error) {
    add(errors, 'TARGET_RESOLUTION', error instanceof Error ? error.message : String(error));
    return { errors, facts: null, authority: loaded };
  }
}

export function verifyTarget(repositoryRoot, target, authority = {}) {
  const errors = [];
  validateTargetInput(errors, target);
  if (errors.length > 0) return { errors, facts: null };
  let loaded;
  try {
    loaded = loadTargetAuthority(repositoryRoot, authority);
  } catch (error) {
    add(errors, 'TARGET_MANIFEST', error instanceof Error ? error.message : String(error));
    if (target.baseSha === target.headSha) add(errors, 'TARGET_RANGE', 'base and head must differ');
    return { errors, facts: null };
  }
  return verifyLoadedTarget(repositoryRoot, target, loaded, errors);
}

export function verifyAuthorizedTarget(repositoryRoot, authority = {}) {
  let loaded;
  try {
    loaded = loadTargetAuthority(repositoryRoot, authority);
  } catch (error) {
    return {
      errors: [
        {
          code: 'TARGET_MANIFEST',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      facts: null,
      authority: null,
    };
  }
  const target = signedTargetInput(loaded.target);
  const errors = [];
  validateTargetInput(errors, target);
  if (errors.length > 0) return { errors, facts: null, authority: loaded };
  return verifyLoadedTarget(repositoryRoot, target, loaded, errors);
}
