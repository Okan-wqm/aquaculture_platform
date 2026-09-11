#!/usr/bin/env ts-node
/**
 * finding-registry-merge-driver — the git merge driver for
 * `docs/reviews/_registry/findings.jsonl`.
 *
 * Registered by `tools/gates/install-git-merge-drivers.mjs` (run from the
 * `prepare` script) and selected by the `merge=findings-registry` attribute
 * in `.gitattributes`. Git invokes it as:
 *
 *     finding-registry-merge-driver %O %A %B %L %P
 *
 *   %O  merge base version      (read)
 *   %A  our version             (read, then OVERWRITTEN with the result)
 *   %B  their version           (read)
 *   %L  conflict marker size    (optional)
 *   %P  the real pathname       (optional, for messages)
 *
 * All three are scratch files git materialises for the merge; the driver
 * never touches the registry in the worktree. Exit 0 means resolved, and
 * git takes %A; exit 1 means conflicted, and git takes %A as the
 * half-merged result — so a refusal writes real conflict markers rather
 * than leaving `ours` in place and calling it a conflict, which would put
 * a clean-looking file on disk under a red merge state.
 *
 * The decision rules and the cases this refuses are documented in
 * `finding-registry-merge.ts`. This file is the I/O shell around them.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { mergeRegistryText } from './finding-registry-merge';

const DEFAULT_MARKER_SIZE = 7;

function markerSize(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return DEFAULT_MARKER_SIZE;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= DEFAULT_MARKER_SIZE
    ? parsed
    : DEFAULT_MARKER_SIZE;
}

function conflictText(oursRaw: string, theirsRaw: string, size: number, label: string): string {
  const open = '<'.repeat(size);
  const divide = '='.repeat(size);
  const close = '>'.repeat(size);
  const body = (raw: string): string => (raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`);
  return (
    `${open} ours (${label})\n` +
    body(oursRaw) +
    `${divide}\n` +
    body(theirsRaw) +
    `${close} theirs (${label})\n`
  );
}

function main(): number {
  const [basePath, oursPath, theirsPath, markerRaw, pathname] = process.argv.slice(2);
  if (!basePath || !oursPath || !theirsPath) {
    process.stderr.write(
      'finding-registry-merge-driver requires %O %A %B (merge base, ours, theirs).\n',
    );
    return 2;
  }
  const label = pathname ?? 'docs/reviews/_registry/findings.jsonl';

  let baseRaw: string;
  let oursRaw: string;
  let theirsRaw: string;
  try {
    baseRaw = readFileSync(basePath, 'utf8');
    oursRaw = readFileSync(oursPath, 'utf8');
    theirsRaw = readFileSync(theirsPath, 'utf8');
  } catch (error) {
    process.stderr.write(
      `finding-registry-merge-driver could not read a merge input: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }

  const merged = mergeRegistryText(baseRaw, oursRaw, theirsRaw);
  if (!merged.ok) {
    process.stderr.write(
      `finding-registry: refusing to auto-merge ${label} — ${merged.reason}\n` +
        'Resolve it by hand, then run ' +
        '`./node_modules/.bin/ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry.ts verify`.\n',
    );
    writeFileSync(oursPath, conflictText(oursRaw, theirsRaw, markerSize(markerRaw), label), 'utf8');
    return 1;
  }

  writeFileSync(oursPath, merged.text, 'utf8');
  const { sharedRowsFrom, addedFrom, entries } = merged.result;
  process.stdout.write(
    `finding-registry: merged ${label} — ${entries.length} rows ` +
      `(upstream changed ${sharedRowsFrom.theirs}, local changed ${sharedRowsFrom.ours}, ` +
      `appended ${addedFrom.theirs} upstream + ${addedFrom.ours} local), chain verified.\n`,
  );
  return 0;
}

if (require.main === module) process.exit(main());
