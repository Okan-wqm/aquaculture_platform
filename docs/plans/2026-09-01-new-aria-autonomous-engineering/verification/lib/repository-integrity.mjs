import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { runGit } from './hermetic-git.mjs';

const exactSha = /^[a-f0-9]{40}$/u;
const maxCommits = 50_000;
const maxCommitBytes = 16 * 1024 * 1024;
const batchSize = 1_024;

function metadataFile(gitRoot, relativePath, nonemptyOnly = false) {
  const path = join(gitRoot, relativePath);
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return true;
  return !nonemptyOnly || stat.size > 0;
}

function canonicalGitDirectory(repositoryRoot, args, git) {
  const path = runGit(repositoryRoot, ['rev-parse', '--path-format=absolute', ...args], git).trim();
  if (!isAbsolute(path) || path.includes('\n') || realpathSync(path) !== path) {
    throw new Error('Git metadata directory is not canonical');
  }
  if (!lstatSync(path).isDirectory()) throw new Error('Git metadata path is not a directory');
  return path;
}

function repositoryLayout(repositoryRoot, git) {
  const control = lstatSync(join(repositoryRoot, '.git'));
  if (control.isSymbolicLink() || (!control.isDirectory() && !control.isFile())) {
    throw new Error('repository .git control path is invalid');
  }
  const gitDir = canonicalGitDirectory(repositoryRoot, ['--absolute-git-dir'], git);
  const commonDir = canonicalGitDirectory(repositoryRoot, ['--git-common-dir'], git);
  const nested = relative(commonDir, gitDir);
  if (
    basename(commonDir) !== '.git' ||
    (gitDir !== commonDir &&
      (!nested.startsWith(`worktrees${sep}`) || nested.split(sep).length !== 2))
  ) {
    throw new Error('Git directory/common-directory containment policy mismatch');
  }
  return { commonDir, gitDir };
}

function partialCloneConfig(repositoryRoot, git) {
  const raw = runGit(repositoryRoot, ['config', '--local', '--null', '--list'], git, {
    encoding: null,
  });
  return raw
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(0, entry.indexOf('\n')).toLowerCase())
    .some(
      (key) =>
        key === 'extensions.partialclone' ||
        /^remote\..+\.(?:promisor|partialclonefilter)$/u.test(key),
    );
}

function promisorPack(commonDir) {
  const packRoot = join(commonDir, 'objects/pack');
  return existsSync(packRoot) && readdirSync(packRoot).some((name) => name.endsWith('.promisor'));
}

export function repositoryMetadataViolation(repositoryRoot, git) {
  const { commonDir } = repositoryLayout(repositoryRoot, git);
  if (runGit(repositoryRoot, ['rev-parse', '--show-object-format'], git).trim() !== 'sha1') {
    return { code: 'TARGET_OBJECT_FORMAT', message: 'repository object format must be sha1' };
  }
  const shallow = runGit(repositoryRoot, ['rev-parse', '--is-shallow-repository'], git).trim();
  if (shallow !== 'false') return { code: 'TARGET_SHALLOW', message: 'shallow repository denied' };
  if (metadataFile(commonDir, 'info/grafts', true)) {
    return { code: 'TARGET_GRAFTS', message: 'Git graft metadata denied' };
  }
  if (
    partialCloneConfig(repositoryRoot, git) ||
    promisorPack(commonDir) ||
    metadataFile(commonDir, 'objects/info/alternates') ||
    metadataFile(commonDir, 'objects/info/http-alternates')
  ) {
    return {
      code: 'TARGET_OBJECT_STORE',
      message: 'partial, promisor, or alternate object store denied',
    };
  }
  return null;
}

function objectDigest(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`commit ${bytes.length}\0`, 'ascii'))
    .update(bytes)
    .digest('hex');
}

function batchHeader(raw, state, expected) {
  const newline = raw.indexOf(0x0a, state.offset);
  if (newline < 0) throw new Error('commit batch header is truncated');
  const header = raw.subarray(state.offset, newline).toString('ascii');
  state.offset = newline + 1;
  const match = /^([a-f0-9]{40}) commit ([1-9]\d*)$/u.exec(header);
  if (!match || match[1] !== expected)
    throw new Error(`${expected}: commit object missing or wrong type`);
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size > maxCommitBytes) {
    throw new Error(`${expected}: commit object exceeds size policy`);
  }
  return size;
}

function parseBatch(raw, requested) {
  const state = { offset: 0 };
  const objects = new Map();
  for (const expected of requested) {
    const size = batchHeader(raw, state, expected);
    if (size > raw.length - state.offset || raw[state.offset + size] !== 0x0a) {
      throw new Error(`${expected}: commit batch body is truncated`);
    }
    const bytes = raw.subarray(state.offset, state.offset + size);
    state.offset += size + 1;
    if (objectDigest(bytes) !== expected)
      throw new Error(`${expected}: raw commit digest mismatch`);
    objects.set(expected, Buffer.from(bytes));
  }
  if (state.offset !== raw.length) throw new Error('commit batch has trailing bytes');
  return objects;
}

function readRawCommits(repositoryRoot, commits, git) {
  const result = new Map();
  for (let index = 0; index < commits.length; index += batchSize) {
    const requested = commits.slice(index, index + batchSize);
    const input = Buffer.from(`${requested.join('\n')}\n`, 'ascii');
    const raw = runGit(repositoryRoot, ['cat-file', '--batch'], git, {
      encoding: null,
      input,
      maxBuffer: 32 * 1024 * 1024,
    });
    for (const [sha, bytes] of parseBatch(raw, requested)) result.set(sha, bytes);
  }
  return result;
}

function identityTimestamp(line, label) {
  const match = new RegExp(`^${label} .+ ([0-9]{1,12}) [+-](?:0\\d|1[0-4])[0-5]\\d$`, 'u').exec(
    line,
  );
  const value = Number(match?.[1]);
  if (!match || !Number.isSafeInteger(value))
    throw new Error(`commit ${label} header is malformed`);
  return value;
}

function parseParents(lines, sha) {
  const parents = [];
  let index = 1;
  while (/^parent [a-f0-9]{40}$/u.test(lines[index] ?? '')) {
    parents.push(lines[index].slice('parent '.length));
    index += 1;
  }
  if (parents.length > 128 || lines.slice(index).some((line) => /^parent(?: |$)/u.test(line))) {
    throw new Error(`${sha}: parent header malformed or non-contiguous`);
  }
  return { index, parents };
}

function parseCommit(sha, raw) {
  const separator = raw.indexOf('\n\n');
  if (separator < 0) throw new Error(`${sha}: commit header terminator missing`);
  const header = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, separator));
  const lines = header.split('\n');
  if (!/^tree [a-f0-9]{40}$/u.test(lines[0] ?? ''))
    throw new Error(`${sha}: tree header malformed`);
  const { index, parents } = parseParents(lines, sha);
  identityTimestamp(lines[index] ?? '', 'author');
  const committerTimestamp = identityTimestamp(lines[index + 1] ?? '', 'committer');
  if (
    lines.slice(index + 2).some((line) => /^(?:tree|parent|author|committer)(?: |$)/u.test(line))
  ) {
    throw new Error(`${sha}: duplicate or noncanonical identity/tree/parent header`);
  }
  return { sha, raw, parents, committerTimestamp };
}

function hints(repositoryRoot, baseSha, headSha, git) {
  const output = runGit(repositoryRoot, ['rev-list', baseSha, headSha], git).trim();
  const commits = output ? output.split('\n') : [];
  if (commits.length > maxCommits || commits.some((value) => !exactSha.test(value))) {
    throw new Error('commit graph hint roster is malformed or exceeds policy');
  }
  return [...new Set([baseSha, headSha, ...commits])];
}

function closure(repositoryRoot, start, objects, git) {
  const reached = new Set();
  const pending = [start];
  while (pending.length > 0) {
    const sha = pending.pop();
    if (reached.has(sha)) continue;
    if (reached.size >= maxCommits) throw new Error('commit graph exceeds traversal policy');
    if (!objects.has(sha)) {
      for (const [key, bytes] of readRawCommits(repositoryRoot, [sha], git))
        objects.set(key, bytes);
    }
    const stored = objects.get(sha);
    const commit = Buffer.isBuffer(stored) ? parseCommit(sha, stored) : stored;
    objects.set(sha, commit);
    reached.add(sha);
    pending.push(...commit.parents);
  }
  return reached;
}

export function rawCommitRange(repositoryRoot, baseSha, headSha, git) {
  if (!exactSha.test(baseSha) || !exactSha.test(headSha) || baseSha === headSha) {
    throw new Error('raw commit range endpoints are invalid');
  }
  const objects = readRawCommits(repositoryRoot, hints(repositoryRoot, baseSha, headSha, git), git);
  const base = closure(repositoryRoot, baseSha, objects, git);
  const head = closure(repositoryRoot, headSha, objects, git);
  if (!head.has(baseSha)) throw new Error('base is not raw-parent reachable from head');
  const introduced = [...head].filter((sha) => !base.has(sha)).sort();
  if (introduced.length === 0) throw new Error('raw introduced commit range is empty');
  return { baseClosure: base, commits: introduced.map((sha) => objects.get(sha)) };
}
