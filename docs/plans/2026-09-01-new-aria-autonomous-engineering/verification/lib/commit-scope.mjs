import { runGit } from './hermetic-git.mjs';

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const rawHeader = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z][0-9]{0,3})$/u;

function objectType(mode) {
  if (mode === '000000') return null;
  if (mode === '040000') return 'tree';
  if (mode === '160000') return 'commit';
  if (/^(?:100|120)[0-7]{3}$/u.test(mode)) return 'blob';
  return 'unknown';
}

function parseEntries(raw, commitSha, parentSha) {
  const tokens = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  if (tokens.at(-1) !== '') throw new Error('commit edge diff lacks terminal NUL');
  tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const match = rawHeader.exec(tokens[index]);
    index += 1;
    if (!match || index >= tokens.length) throw new Error('commit edge diff header is malformed');
    const oldPath = tokens[index];
    index += 1;
    const renamed = /^[RC]/u.test(match[5]);
    const newPath = renamed ? tokens[index] : null;
    if (renamed) index += 1;
    if (!oldPath || (renamed && !newPath)) throw new Error('commit edge diff path is malformed');
    entries.push({
      commitSha,
      parentSha,
      status: match[5],
      oldPath,
      newPath,
      oldMode: match[1],
      newMode: match[2],
      oldType: objectType(match[1]),
      newType: objectType(match[2]),
    });
  }
  return entries;
}

function relevantParents(commit, baseClosure) {
  if (commit.parents.length === 0) return [emptyTree];
  const safe = commit.parents.filter((parent) => baseClosure.has(parent));
  return safe.length > 0 ? safe : commit.parents;
}

function edgeEntries(repositoryRoot, commit, parentSha, git) {
  const raw = runGit(
    repositoryRoot,
    [
      'diff-tree',
      '--raw',
      '-z',
      '--no-commit-id',
      '-r',
      '--find-renames',
      '--find-copies',
      parentSha,
      commit.sha,
      '--',
    ],
    git,
    { encoding: null },
  );
  return parseEntries(raw, commit.sha, parentSha);
}

export function commitScopeEntries(repositoryRoot, range, git) {
  return range.commits.flatMap((commit) =>
    relevantParents(commit, range.baseClosure).flatMap((parent) =>
      edgeEntries(repositoryRoot, commit, parent, git),
    ),
  );
}
