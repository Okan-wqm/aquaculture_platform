/**
 * The comparison blob for one staged file under `format check-staged`.
 *
 * Outside a merge the base is HEAD's blob (null for a new file), which is the
 * rule CI applies with base = PR base: drift is a regression when the file was
 * clean at the base.
 *
 * WHY a merge commit reads BOTH parents: while a merge is being committed the
 * index holds the other branch's files too, and a file that first appears
 * there has no blob at HEAD. Judged against HEAD alone, every Prettier-dirty
 * file the other branch already carried reads as this commit's regression, and
 * the only way past the gate is to reformat the other branch's files inside the
 * merge — a whitespace diff that then conflicts with the next thing that branch
 * lands. A merge inherits debt from either parent; it introduces drift only
 * when the file was clean at both. So the base is whichever parent already
 * carries the drift: HEAD's blob when it is dirty, else MERGE_HEAD's blob when
 * that is dirty, else HEAD's (clean, or absent = new file = regression).
 *
 * Pure: git and Prettier are injected, so tools/gates/format-merge-base.spec.ts
 * can pin every branch of the rule without a repository.
 *
 * @param {string} path
 * @param {{
 *   hasHead: boolean,
 *   hasMergeHead: boolean,
 *   isClean: (source: string) => boolean,
 *   readBlob: (spec: string) => string | null,
 * }} deps
 * @returns {string | null}
 */
export function mergeAwareBaseSource(path, { hasHead, hasMergeHead, isClean, readBlob }) {
  // No HEAD means no comparison point at all: fail closed, every drift is a
  // regression. (Git cannot be mid-merge without HEAD; the guard keeps the
  // rule honest if a caller ever says otherwise.)
  if (!hasHead) return null;
  const head = readBlob(`HEAD:${path}`);
  if (!hasMergeHead) return head;
  if (head !== null && !isClean(head)) return head;
  const other = readBlob(`MERGE_HEAD:${path}`);
  if (other !== null && !isClean(other)) return other;
  return head;
}
