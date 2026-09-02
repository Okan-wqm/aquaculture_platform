import { sha256 } from './canonical.mjs';
import { listCommitTree, readCommitEntries } from './git-objects.mjs';
import { runGit } from './hermetic-git.mjs';

const designFile = 'docs/superpowers/specs/2026-09-01-new-aria-autonomous-engineering-design.md';
const formatFile = 'tools/quality/format-scope.json';
const packageLockFile = 'package-lock.json';

export function resolveCommit(repositoryRoot, value, git) {
  return runGit(repositoryRoot, ['rev-parse', '--verify', `${value}^{commit}`], git).trim();
}

function committedEntries(raw) {
  const tokens = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index];
    const oldPath = tokens[index + 1];
    index += 2;
    if (/^[RC]/u.test(status)) {
      entries.push({ status, oldPath, newPath: tokens[index] });
      index += 1;
    } else {
      entries.push({ status, oldPath, newPath: null });
    }
  }
  return entries;
}

function regularEntry(entries, path) {
  const entry = entries.get(path);
  if (!entry) throw new Error(`${path}: committed blob missing`);
  if (entry.mode !== '100644' || entry.type !== 'blob') {
    throw new Error(`${path}: committed tree mode must be regular non-executable blob`);
  }
  return entry;
}

function inspectEntries(repositoryRoot, headSha, changed, git) {
  const paths = [...new Set([...changed, designFile, formatFile, packageLockFile])];
  const tree = listCommitTree(repositoryRoot, headSha, paths, git);
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  changed.forEach((path) => regularEntry(byPath, path));
  return byPath;
}

export function collectTargetFacts(repositoryRoot, target, git) {
  const baseSha = resolveCommit(repositoryRoot, target.baseSha, git);
  const headSha = resolveCommit(repositoryRoot, target.headSha, git);
  const reviewedRefSha = resolveCommit(repositoryRoot, target.reviewedRef, git);
  const checkoutSha = resolveCommit(repositoryRoot, 'HEAD', git);
  const baseTree = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${baseSha}^{tree}`],
    git,
  ).trim();
  const headTree = runGit(
    repositoryRoot,
    ['rev-parse', '--verify', `${headSha}^{tree}`],
    git,
  ).trim();
  const diff = runGit(
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
    git,
    { encoding: null },
  );
  const entries = committedEntries(diff);
  const changed = entries
    .filter(({ status }) => !status.startsWith('D'))
    .map((entry) => entry.newPath ?? entry.oldPath);
  const inspected = inspectEntries(repositoryRoot, headSha, changed, git);
  const sources = [
    regularEntry(inspected, designFile),
    regularEntry(inspected, formatFile),
    regularEntry(inspected, packageLockFile),
  ];
  const blobs = readCommitEntries(repositoryRoot, sources, git);
  return {
    base_sha: baseSha,
    base_tree: baseTree,
    head_sha: headSha,
    head_tree: headTree,
    reviewed_ref: target.reviewedRef,
    reviewed_ref_sha: reviewedRefSha,
    checkout_sha: checkoutSha,
    committed_diff_sha256: sha256(diff),
    committed_entries: entries,
    design_sha256: sha256(blobs.get(designFile).bytes),
    format_scope_sha256: sha256(blobs.get(formatFile).bytes),
    package_lock_sha256: sha256(blobs.get(packageLockFile).bytes),
    git_tool: git.tool,
  };
}
