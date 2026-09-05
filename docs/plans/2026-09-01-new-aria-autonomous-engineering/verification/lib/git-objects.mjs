import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseBatchOutput } from './git-batch-parser.mjs';
import { runGit } from './hermetic-git.mjs';

export { parseBatchOutput } from './git-batch-parser.mjs';

const digestPattern = /^[a-f0-9]{64}$/u;

function exactObject(value, label) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? '')) throw new Error(`${label} must be an exact SHA`);
}

function repositoryPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.startsWith('-') ||
    posix.normalize(value) !== value ||
    value === '..' ||
    value.startsWith('../')
  ) {
    throw new Error('Git object path must be a normalized repository-relative path');
  }
}

export function listCommitTree(repositoryRoot, revision, prefix, tool) {
  exactObject(revision, 'revision');
  const paths = Array.isArray(prefix) ? prefix : [prefix];
  if (paths.length === 0) throw new Error('Git tree path roster must not be empty');
  paths.forEach(repositoryPath);
  const raw = runGit(
    repositoryRoot,
    ['ls-tree', '-rz', '--full-tree', revision, '--', ...paths],
    tool,
    { encoding: null },
  );
  return new TextDecoder('utf-8', { fatal: true })
    .decode(raw)
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const tab = row.indexOf('\t');
      if (tab < 0) throw new Error('malformed Git tree entry');
      const identity = /^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})$/u.exec(row.slice(0, tab));
      const path = row.slice(tab + 1);
      if (!identity || !path) throw new Error('malformed Git tree entry');
      return { mode: identity[1], type: identity[2], oid: identity[3], path };
    });
}

export function readCommitFile(repositoryRoot, revision, expected, tool) {
  repositoryPath(expected?.path);
  const entries = listCommitTree(repositoryRoot, revision, expected.path, tool);
  const entry = entries.find(({ path }) => path === expected.path);
  assertBlobEntry(entry, entries.length, expected.path);
  assertExpectedOid(entry, expected);
  const bytes = readCommitEntries(repositoryRoot, [entry], tool).get(entry.path).bytes;
  assertExpectedDigest(bytes, expected);
  return { ...entry, bytes };
}

export function readCommitEntries(repositoryRoot, entries, tool) {
  if (!Array.isArray(entries) || new Set(entries.map(({ path }) => path)).size !== entries.length) {
    throw new Error('committed entry roster must be a unique array');
  }
  if (entries.length === 0) return new Map();
  for (const entry of entries) {
    assertBlobEntry(entry, 1, entry.path);
    exactObject(entry.oid, 'blob OID');
  }
  const input = Buffer.from(`${entries.map(({ oid }) => oid).join('\n')}\n`, 'ascii');
  const raw = runGit(repositoryRoot, ['cat-file', '--batch'], tool, {
    encoding: null,
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return parseBatchOutput(raw, entries);
}

function assertBlobEntry(entry, count, path) {
  if (!entry || count !== 1) throw new Error(`${path}: committed blob missing`);
  if (entry.mode !== '100644' || entry.type !== 'blob') {
    throw new Error(`${path}: committed tree mode must be regular non-executable blob`);
  }
}

function assertExpectedOid(entry, expected) {
  if (expected.blob_oid !== undefined && entry.oid !== expected.blob_oid) {
    throw new Error(`${expected.path}: blob OID mismatch`);
  }
}

function assertExpectedDigest(bytes, expected) {
  if (expected.sha256 === undefined) return;
  if (!digestPattern.test(expected.sha256)) {
    throw new Error(`${expected.path}: expected digest must be exact SHA-256`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.sha256) throw new Error(`${expected.path}: raw digest mismatch`);
}
