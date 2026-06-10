#!/usr/bin/env ts-node
/**
 * git-diff-ranges — SSOT for unified-diff added-line parsing across the
 * tools/gates/ suite (Round-2 cluster-0 train infrastructure).
 *
 * WHY this module exists: before it, THREE gates carried private copies
 * of the same `-U0` post-image line parser —
 *
 *   - tools/gates/banned-phrase.ts        (addedLinesInRange → Set<number>)
 *   - tools/gates/farm-service-enterprise-guardrails.ts (parseDiff → AddedLine[])
 *   - tools/gates/banned-construct.ts     (would have been the fourth copy)
 *
 * Divergent copies of a diff parser are a correctness hazard: a hunk-header
 * edge case fixed in one gate silently stays broken in the others, and the
 * gates disagree about WHICH lines a PR "added". One parser, every gate.
 *
 * WHAT it exports: the AddedLine-based parser (the most general of the
 * three shapes — path + post-image line number + text), thin collectors
 * for range / staged invocations, and a grouping helper for gates that
 * key their scan on per-file line sets.
 *
 * No top-level execution — this module is import-safe for node:test specs.
 */

import { execFileSync } from 'node:child_process';

export interface AddedLine {
  readonly path: string;
  readonly lineNumber: number;
  readonly text: string;
}

/**
 * Run git with args against the given repo root. 64MB buffer because a
 * repo-wide `-U0` diff on a large PR (e.g. a 4900-file format pass)
 * overflows the 1MB default and execFileSync then throws ENOBUFS —
 * which a gate would misreport as "no diff, gate green" if swallowed.
 */
export function runGit(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Parse a `--unified=0` diff into the post-image lines it ADDS.
 *
 * Parser contract (shared by every consumer):
 *   - `+++ b/<path>` headers set the current file; `/dev/null` (deletion)
 *     clears it so removed-file hunks contribute nothing.
 *   - `@@ -a,b +c,d @@` headers reset the post-image counter to `c`.
 *   - Lines starting with `+` (except `+++`) are recorded and advance
 *     the counter; `-` lines do not advance it; any other line (only
 *     possible outside `-U0`, kept for safety) advances it.
 */
export function parseAddedLines(diff: string): readonly AddedLine[] {
  const added: AddedLine[] = [];
  let currentPath = '';
  let newLineNumber = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      currentPath = rawPath === '/dev/null' ? '' : rawPath.replace(/^b\//, '');
      continue;
    }

    if (line.startsWith('@@')) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      newLineNumber = match?.[1] ? Number(match[1]) : 0;
      continue;
    }

    if (!currentPath || newLineNumber === 0) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ path: currentPath, lineNumber: newLineNumber, text: line.slice(1) });
      newLineNumber += 1;
      continue;
    }
    if (!line.startsWith('-')) {
      newLineNumber += 1;
    }
  }

  return added;
}

/** Added lines between two refs (PR range scan). */
export function collectRangeAddedLines(
  repoRoot: string,
  base: string,
  head: string,
): readonly AddedLine[] {
  return parseAddedLines(
    runGit(repoRoot, ['diff', '--unified=0', '--no-ext-diff', `${base}..${head}`, '--']),
  );
}

/** Added lines currently staged (pre-commit hook scan). */
export function collectStagedAddedLines(repoRoot: string): readonly AddedLine[] {
  return parseAddedLines(runGit(repoRoot, ['diff', '--cached', '--unified=0', '--no-ext-diff', '--']));
}

/** Names of files changed (Added/Copied/Modified) in a range. */
export function rangeChangedFiles(repoRoot: string, base: string, head: string): string[] {
  return runGit(repoRoot, ['diff', `${base}..${head}`, '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .filter(Boolean);
}

/** Names of files currently staged (Added/Copied/Modified). */
export function stagedChangedFiles(repoRoot: string): string[] {
  return runGit(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .filter(Boolean);
}

/**
 * Group added lines into per-file 1-based line-number sets — the shape
 * banned-phrase.ts keys its allowIf-windowed scan on.
 */
export function addedLinesByFile(
  lines: readonly AddedLine[],
): ReadonlyMap<string, ReadonlySet<number>> {
  const map = new Map<string, Set<number>>();
  for (const line of lines) {
    const set = map.get(line.path) ?? new Set<number>();
    set.add(line.lineNumber);
    map.set(line.path, set);
  }
  return map;
}
