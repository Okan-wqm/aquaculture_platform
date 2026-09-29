import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import type {
  RepositoryExecutionSnapshot,
  RepositorySnapshotFile,
} from '../../application/repository-execution-snapshot';
import { REPOSITORY_SNAPSHOT_POLICY } from '../../application/repository-execution-snapshot';
import { compareCodePoints } from '../../kernel/canonical-json';

import type { VerifiedGitObject } from './git-raw-object';

const MAX_TREE_COUNT = 20_000;
const MAX_TREE_DEPTH = 128;

interface TreeEntry {
  readonly mode: '100644' | '100755' | '40000';
  readonly name: string;
  readonly oid: string;
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4_096 &&
    !path.includes('\\') &&
    posix.normalize(path) === path &&
    Array.from(path).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return (
        point >= 0x20 &&
        (point < 0x7f || point > 0x9f) &&
        point !== 0x061c &&
        point !== 0x200e &&
        point !== 0x200f &&
        (point < 0x202a || point > 0x202e) &&
        (point < 0x2066 || point > 0x2069)
      );
    })
  );
}

function parseTree(object: VerifiedGitObject): readonly TreeEntry[] {
  if (object.type !== 'tree') throw new TypeError('raw Git tree closure contains a non-tree');
  const entries: TreeEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  while (offset < object.bytes.byteLength) {
    const space = object.bytes.indexOf(0x20, offset);
    const nul = space < 0 ? -1 : object.bytes.indexOf(0, space + 1);
    if (space <= offset || nul <= space + 1 || nul + 21 > object.bytes.byteLength) {
      throw new TypeError('raw Git tree entry is truncated');
    }
    const mode = object.bytes.subarray(offset, space).toString('ascii');
    if (mode !== '40000' && mode !== '100644' && mode !== '100755') {
      throw new TypeError('raw Git tree entry has a forbidden mode');
    }
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        object.bytes.subarray(space + 1, nul),
      );
    } catch {
      throw new TypeError('raw Git tree entry name is not canonical UTF-8');
    }
    if (!safePath(name) || name.includes('/') || name === '.' || name === '..' || names.has(name)) {
      throw new TypeError('raw Git tree entry name is unsafe or duplicated');
    }
    names.add(name);
    entries.push({
      mode,
      name,
      oid: object.bytes.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

export function snapshotVerifiedGitTree(
  objects: ReadonlyMap<string, VerifiedGitObject>,
  headOid: string,
  rootTreeOid: string,
): RepositoryExecutionSnapshot {
  const files: RepositorySnapshotFile[] = [];
  const paths = new Set<string>();
  let totalBytes = 0;
  let treeCount = 0;
  const visit = (treeOid: string, prefix: string, depth: number, ancestors: Set<string>): void => {
    if (depth > MAX_TREE_DEPTH || ancestors.has(treeOid)) {
      throw new TypeError('raw Git tree closure is cyclic or too deep');
    }
    treeCount += 1;
    if (treeCount > MAX_TREE_COUNT) throw new TypeError('raw Git tree closure has too many trees');
    const tree = objects.get(treeOid);
    if (tree === undefined) throw new TypeError('raw Git tree closure is incomplete');
    const nextAncestors = new Set(ancestors).add(treeOid);
    for (const entry of parseTree(tree)) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (!safePath(path) || paths.has(path)) {
        throw new TypeError('raw Git tree closure path is unsafe or duplicated');
      }
      paths.add(path);
      const child = objects.get(entry.oid);
      if (child === undefined) throw new TypeError('raw Git tree closure is incomplete');
      if (entry.mode === '40000') {
        if (child.type !== 'tree') throw new TypeError('raw Git tree mode and type disagree');
        visit(entry.oid, path, depth + 1, nextAncestors);
        continue;
      }
      if (child.type !== 'blob') throw new TypeError('raw Git blob mode and type disagree');
      totalBytes += child.bytes.byteLength;
      if (
        files.length >= REPOSITORY_SNAPSHOT_POLICY.max_files ||
        child.bytes.byteLength > REPOSITORY_SNAPSHOT_POLICY.max_file_bytes ||
        totalBytes > REPOSITORY_SNAPSHOT_POLICY.max_total_bytes
      ) {
        throw new TypeError('raw Git tree snapshot exceeds its file or byte bound');
      }
      const bytes = Buffer.from(child.bytes);
      files.push(
        Object.freeze({
          path,
          mode: entry.mode,
          blob_sha: entry.oid,
          content_sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes,
        }),
      );
    }
  };
  visit(rootTreeOid, '', 0, new Set());
  files.sort((left, right) => compareCodePoints(left.path, right.path));
  return Object.freeze({ head_sha: headOid, tree_sha: rootTreeOid, files: Object.freeze(files) });
}
