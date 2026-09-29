import type { GitCommandResult } from './git-process';
import { GitProcess } from './git-process';

const sha40 = /^[a-f0-9]{40}$/u;
const MAX_COMMIT_HINTS = 50_000;
const MAX_TREE_HINTS = 40_000;

function exactText(result: GitCommandResult, label: string): string {
  if (result.status !== 0 || result.stderr.length !== 0 || result.stdout.includes('\r')) {
    throw new TypeError(`${label} failed closed`);
  }
  return result.stdout;
}

export function commitObjectHints(
  root: string,
  process: GitProcess,
  baseOid: string,
  headOid: string,
): readonly string[] {
  const output = exactText(
    process.run(root, ['rev-list', `--max-count=${(MAX_COMMIT_HINTS + 1).toString()}`, headOid]),
    'Git commit object hint listing',
  );
  if (output.length === 0 || !output.endsWith('\n')) {
    throw new TypeError('Git commit object hint listing is incomplete');
  }
  const hints = output.slice(0, -1).split('\n');
  if (hints.length > MAX_COMMIT_HINTS || hints.some((oid) => !sha40.test(oid))) {
    throw new TypeError('Git commit object hint listing is invalid or oversized');
  }
  return Object.freeze([...new Set([...hints, baseOid])]);
}

export function treeObjectHints(
  root: string,
  process: GitProcess,
  headOid: string,
  rootTreeOid: string,
): readonly string[] {
  const format = '--format=%(objectmode) %(objecttype) %(objectname) %(objectsize)%x09%(path)';
  const result = process.runBytes(
    root,
    ['ls-tree', '-r', '-t', '-z', '--full-tree', format, headOid],
    { max_output_bytes: 16 * 1024 * 1024 },
  );
  if (result.status !== 0 || result.stderr.byteLength !== 0) {
    throw new TypeError('Git tree object hint listing failed closed');
  }
  if (result.stdout.byteLength > 0 && result.stdout.at(-1) !== 0) {
    throw new TypeError('Git tree object hint listing is not NUL terminated');
  }
  const hints: string[] = [rootTreeOid];
  let start = 0;
  for (let offset = 0; offset < result.stdout.byteLength; offset += 1) {
    if (result.stdout[offset] !== 0) continue;
    const entry = result.stdout.subarray(start, offset);
    const tab = entry.indexOf(0x09);
    const metadata = tab < 0 ? '' : entry.subarray(0, tab).toString('ascii');
    const fields = metadata.split(' ');
    const oid = fields[2];
    if (fields.length !== 4 || oid === undefined || !sha40.test(oid)) {
      throw new TypeError('Git tree object hint entry is invalid');
    }
    hints.push(oid);
    if (hints.length > MAX_TREE_HINTS) {
      throw new TypeError('Git tree object hint listing is oversized');
    }
    start = offset + 1;
  }
  return Object.freeze([...new Set(hints)]);
}
