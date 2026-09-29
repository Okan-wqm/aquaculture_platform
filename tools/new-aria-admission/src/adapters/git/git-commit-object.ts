import type { VerifiedGitObject } from './git-raw-object';

const sha40 = /^[a-f0-9]{40}$/u;
const canonicalIdentity =
  /^(?:author|committer) ([^<>]+) <([^<>]*)> (?:0|-?[1-9][0-9]*) [+-](?:0[0-9]|1[0-4])[0-5][0-9]$/u;
const MAX_PARENT_COUNT = 256;
const MAX_COMMIT_COUNT = 50_000;
const MAX_COMMIT_BYTES = 64 * 1024 * 1024;

export interface ParsedGitCommit {
  readonly tree_oid: string;
  readonly parent_oids: readonly string[];
}

function isCanonicalIdentity(line: string): boolean {
  const match = canonicalIdentity.exec(line);
  if (match === null) return false;
  return [match[1] ?? '', match[2] ?? ''].every((field) =>
    Array.from(field).every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 0x20 && point !== 0x7f && (point < 0x80 || point > 0x9f);
    }),
  );
}

export function parseVerifiedGitCommit(object: VerifiedGitObject): ParsedGitCommit {
  if (object.type !== 'commit') throw new TypeError('raw Git object is not a commit');
  const headerEnd = object.bytes.indexOf(Buffer.from('\n\n'));
  const headerBytes = headerEnd < 0 ? object.bytes : object.bytes.subarray(0, headerEnd);
  if (headerEnd < 0 || headerBytes.includes(0) || headerBytes.includes(0x0d)) {
    throw new TypeError('raw Git commit header is malformed');
  }
  let header: string;
  try {
    header = new TextDecoder('utf-8', { fatal: true }).decode(headerBytes);
  } catch {
    throw new TypeError('raw Git commit header is not canonical UTF-8');
  }
  const lines = header.split('\n');
  const tree = lines[0]?.match(/^tree ([a-f0-9]{40})$/u)?.[1];
  if (tree === undefined || !sha40.test(tree)) {
    throw new TypeError('raw Git commit tree header is invalid');
  }
  const parents: string[] = [];
  const seenParents = new Set<string>();
  let index = 1;
  while (index < lines.length) {
    const parent = lines[index]?.match(/^parent ([a-f0-9]{40})$/u)?.[1];
    if (parent === undefined) break;
    if (parents.length >= MAX_PARENT_COUNT) {
      throw new TypeError('raw Git commit parent count limit exceeded');
    }
    if (seenParents.has(parent)) throw new TypeError('raw Git commit repeats a parent');
    seenParents.add(parent);
    parents.push(parent);
    index += 1;
  }
  const author = lines[index];
  const committer = lines[index + 1];
  if (!author?.startsWith('author ')) {
    throw new TypeError('raw Git commit header order is invalid');
  }
  if (!committer?.startsWith('committer ')) {
    if (committer?.startsWith('author ')) {
      throw new TypeError('raw Git commit author or committer header is invalid');
    }
    throw new TypeError('raw Git commit header order is invalid');
  }
  if (!isCanonicalIdentity(author) || !isCanonicalIdentity(committer)) {
    throw new TypeError('raw Git commit author or committer header is invalid');
  }
  index += 2;
  let previousKey = '';
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith(' ')) {
      if (previousKey !== 'gpgsig' && previousKey !== 'mergetag') {
        throw new TypeError('raw Git commit has a noncanonical continuation header');
      }
      continue;
    }
    const match = /^([a-z][a-z0-9-]*) (.+)$/u.exec(line);
    const key = match?.[1];
    if (key === undefined || key === 'tree' || key === 'parent') {
      throw new TypeError('raw Git commit header order is invalid');
    }
    if (key === 'author' || key === 'committer') {
      throw new TypeError('raw Git commit author or committer header is invalid');
    }
    previousKey = key;
  }
  return Object.freeze({ tree_oid: tree, parent_oids: Object.freeze(parents) });
}

export function rawBaseIsAncestor(
  objects: ReadonlyMap<string, VerifiedGitObject>,
  baseOid: string,
  headOid: string,
): { readonly is_ancestor: boolean; readonly head_tree_oid: string } {
  const pending = [headOid];
  const visited = new Set<string>();
  let totalBytes = 0;
  let headTreeOid = '';
  while (pending.length > 0) {
    const oid = pending.pop();
    if (oid === undefined || visited.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) throw new TypeError('raw Git commit closure is incomplete');
    visited.add(oid);
    totalBytes += object.bytes.byteLength;
    if (visited.size > MAX_COMMIT_COUNT || totalBytes > MAX_COMMIT_BYTES) {
      throw new TypeError('raw Git commit closure is oversized');
    }
    const commit = parseVerifiedGitCommit(object);
    if (oid === headOid) headTreeOid = commit.tree_oid;
    pending.push(...commit.parent_oids);
  }
  const base = objects.get(baseOid);
  if (base === undefined || base.type !== 'commit' || headTreeOid.length === 0) {
    throw new TypeError('raw Git target commit closure is incomplete');
  }
  return Object.freeze({ is_ancestor: visited.has(baseOid), head_tree_oid: headTreeOid });
}
