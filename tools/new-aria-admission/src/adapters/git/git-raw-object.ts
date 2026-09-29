import { createHash } from 'node:crypto';

import { GitProcess } from './git-process';

export type GitObjectType = 'blob' | 'commit' | 'tree';

export interface VerifiedGitObject {
  readonly oid: string;
  readonly type: GitObjectType;
  readonly bytes: Buffer;
}

const sha40 = /^[a-f0-9]{40}$/u;
const headerPattern = /^([a-f0-9]{40}) (blob|commit|tree) (0|[1-9][0-9]*)$/u;
const ascii = new TextDecoder('utf-8', { fatal: true });

function objectDigest(type: GitObjectType, bytes: Buffer): string {
  return createHash('sha1')
    .update(Buffer.from(`${type} ${bytes.byteLength}\0`))
    .update(bytes)
    .digest('hex');
}

function uniqueObjectIds(objectIds: readonly string[]): readonly string[] {
  if (
    objectIds.length === 0 ||
    objectIds.some((oid) => !sha40.test(oid)) ||
    new Set(objectIds).size !== objectIds.length
  ) {
    throw new TypeError('raw Git object request roster is invalid');
  }
  return objectIds;
}

export function readVerifiedGitObjects(
  root: string,
  process: GitProcess,
  objectIds: readonly string[],
  maximumOutputBytes: number,
): ReadonlyMap<string, VerifiedGitObject> {
  const requested = uniqueObjectIds(objectIds);
  const input = Buffer.from(`${requested.join('\n')}\n`);
  const result = process.runBytes(root, ['cat-file', '--batch'], {
    input,
    max_output_bytes: maximumOutputBytes,
  });
  if (result.status !== 0 || result.stderr.byteLength !== 0) {
    throw new TypeError('raw Git object transport failed closed');
  }
  const objects = new Map<string, VerifiedGitObject>();
  let offset = 0;
  for (const requestedOid of requested) {
    const lineEnd = result.stdout.indexOf(0x0a, offset);
    if (lineEnd < 0) throw new TypeError('raw Git object header is incomplete');
    let header: string;
    try {
      header = ascii.decode(result.stdout.subarray(offset, lineEnd));
    } catch {
      throw new TypeError('raw Git object header is not canonical UTF-8');
    }
    const match = headerPattern.exec(header);
    const returnedOid = match?.[1];
    const type = match?.[2] as GitObjectType | undefined;
    const sizeText = match?.[3];
    const size = sizeText === undefined ? Number.NaN : Number(sizeText);
    if (
      returnedOid !== requestedOid ||
      type === undefined ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new TypeError('raw Git object header identity is invalid');
    }
    const bodyStart = lineEnd + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= result.stdout.byteLength || result.stdout[bodyEnd] !== 0x0a) {
      throw new TypeError('raw Git object body is incomplete');
    }
    const bytes = result.stdout.subarray(bodyStart, bodyEnd);
    if (objectDigest(type, bytes) !== requestedOid) {
      throw new TypeError(`raw Git object identity digest mismatch for ${requestedOid}`);
    }
    objects.set(requestedOid, Object.freeze({ oid: requestedOid, type, bytes }));
    offset = bodyEnd + 1;
  }
  if (offset !== result.stdout.byteLength || objects.size !== requested.length) {
    throw new TypeError('raw Git object transport returned extra or missing bytes');
  }
  return objects;
}
