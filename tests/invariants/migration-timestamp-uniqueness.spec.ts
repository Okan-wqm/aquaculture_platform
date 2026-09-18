/**
 * Platform-wide invariant — FARM-AI integration (2026-09-18):
 *
 * Migration FILE timestamps must be UNIQUE PER SERVICE migration directory.
 * The runners key the ledger by migration CLASS NAME, so two files sharing a
 * leading timestamp in the same directory boot and run happily — until a
 * renumber/rename or a cross-branch merge has to reason about ordering, and
 * then the collision is discovered by a human at deploy time. Concretely:
 * ai-service carries TWO 1803100000000 files (AddZaiApiKey +
 * HealAiProposedActionsUnqualified) and the messaging fan-out migration
 * collided at 1802200000000 across lineages. This guard fails the suite at
 * the moment a second file with an existing timestamp is introduced.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

interface Collision {
  directory: string;
  timestamp: string;
  files: string[];
}

function migrationFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '*migrations*'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(
      (f) =>
        f.length > 0 &&
        !f.includes('__tests__') &&
        !f.includes('.archive') &&
        !f.endsWith('.spec.ts') &&
        /^\d{13}-/.test(f.split('/').pop() ?? ''),
    );
}

describe('INVARIANT: migration file timestamps are unique per directory', () => {
  it('no two migration files in the same directory share a leading timestamp', () => {
    const byDirectory = new Map<string, Map<string, string[]>>();
    for (const file of migrationFiles()) {
      const parts = file.split('/');
      const directory = parts.slice(0, -1).join('/');
      const timestamp = (parts.pop() ?? '').split('-')[0];
      if (!/^\d{13}$/.test(timestamp)) continue;
      const inner = byDirectory.get(directory) ?? new Map<string, string[]>();
      const existing = inner.get(timestamp) ?? [];
      existing.push(file);
      inner.set(timestamp, existing);
      byDirectory.set(directory, inner);
    }

    const collisions: Collision[] = [];
    for (const [directory, stamps] of byDirectory) {
      for (const [timestamp, files] of stamps) {
        if (files.length > 1) {
          collisions.push({ directory, timestamp, files });
        }
      }
    }

    if (collisions.length > 0) {
      const detail = collisions
        .map(
          (c) =>
            `  ${c.directory} @ ${c.timestamp}:\n` +
            c.files.map((f) => `    - ${f}`).join('\n'),
        )
        .join('\n');
      throw new Error(
        `Migration timestamp collisions (same directory, same leading timestamp).\n` +
          `Renumber the NEWER file (bump its timestamp past every neighbor) in the\n` +
          `same commit — runners key by class name so the ledger needs a manual eye.\n` +
          detail,
      );
    }

    // Sanity: the scan actually found migrations (a broken glob must not
    // pass silently as "zero files, zero collisions").
    let total = 0;
    for (const stamps of byDirectory.values()) total += stamps.size;
    expect(total).toBeGreaterThan(100);
  });

  // NOTE: repo-WIDE file-name uniqueness is deliberately NOT asserted — every
  // service owning its own `1800000000000-Baseline.ts` is the platform's
  // convention and each ledger is a separate migrations table.
});
