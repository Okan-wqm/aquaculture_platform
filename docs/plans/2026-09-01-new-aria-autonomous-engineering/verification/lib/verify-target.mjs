import { readFileSync, realpathSync } from 'node:fs';
import { canonicalJson, parseStrictJsonBytes, sha256 } from './canonical.mjs';
import { commitScopeEntries } from './commit-scope.mjs';
import { verifyIntroducedCommitSignatures } from './commit-signatures.mjs';
import { readCommitFile } from './git-objects.mjs';
import { createGitSession, runGit } from './hermetic-git.mjs';
import { verifyRuntimeDependencies } from './runtime-dependencies.mjs';
import { rawCommitRange, repositoryMetadataViolation } from './repository-integrity.mjs';
import { collectTargetFacts, resolveCommit } from './target-git-facts.mjs';
import { loadTargetAuthority, targetManifestPath } from './target-manifest.mjs';
import { verifyTargetArtifacts } from './target-artifacts.mjs';
const exactSha = /^[a-f0-9]{40}$/u;
const exactDigest = /^[a-f0-9]{64}$/u;
const exactRef = /^refs\/(?:heads|remotes)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

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

function verifyReachability(errors, facts) {
  if (facts.base_sha === facts.head_sha) add(errors, 'TARGET_RANGE', 'base and head must differ');
  if (facts.checkout_sha !== facts.head_sha) add(errors, 'TARGET_HEAD', 'checkout HEAD mismatch');
  if (facts.reviewed_ref_sha !== facts.head_sha)
    add(errors, 'TARGET_REF', 'reviewed ref does not resolve to head');
}

function verifyCommitSignatures(errors, commits, facts, loaded) {
  try {
    const verified = verifyIntroducedCommitSignatures(commits, loaded.commitSignaturePolicy);
    facts.introduced_commit_signatures = verified.records;
    facts.introduced_commit_signatures_sha256 = verified.digest;
    if (verified.digest !== loaded.target.introduced_commit_signatures_sha256) {
      add(errors, 'COMMIT_SIGNATURE', 'introduced commit signature digest mismatch');
    }
  } catch (error) {
    add(errors, 'COMMIT_SIGNATURE', error instanceof Error ? error.message : String(error));
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
    const metadataViolation = repositoryMetadataViolation(repositoryRoot, git);
    if (metadataViolation) {
      add(errors, metadataViolation.code, metadataViolation.message);
      return { errors, facts: null, authority: loaded };
    }
    verifyManifestBinding(errors, repositoryRoot, target, loaded, git);
    if (target.baseSha === target.headSha) {
      add(errors, 'TARGET_RANGE', 'base and head must differ');
      return { errors, facts: null, authority: loaded };
    }
    let commits;
    try {
      commits = rawCommitRange(repositoryRoot, target.baseSha, target.headSha, git);
    } catch (error) {
      add(errors, 'TARGET_GRAPH', error instanceof Error ? error.message : String(error));
      return { errors, facts: null, authority: loaded };
    }
    const facts = collectTargetFacts(repositoryRoot, target, git);
    facts.introduced_commits = commits.commits.map(({ sha }) => sha);
    facts.commit_scope_entries = commitScopeEntries(repositoryRoot, commits, git);
    facts.node_tool = loaded.target.node_tool;
    facts.runtime_dependencies = loaded.target.runtime_dependencies;
    if (facts.package_lock_sha256 !== loaded.target.package_lock_sha256) {
      add(errors, 'TARGET_PACKAGE_LOCK', 'committed package-lock digest is not signed exactly');
    }
    verifyRuntimeDependencies(repositoryRoot, loaded.target);
    verifyReachability(errors, facts);
    verifyDeclaredFacts(errors, facts, target);
    errors.push(...verifyTargetArtifacts(facts));
    verifyCommitSignatures(errors, commits.commits, facts, loaded);
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
