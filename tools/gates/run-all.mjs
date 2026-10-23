#!/usr/bin/env node
/**
 * Run every gate spec in this directory.
 *
 * WHY A SCRIPT AND NOT A SHELL LOOP IN package.json: an npm script whose first
 * token is `for` is not a resolvable binary, and `repo-hygiene-invariants`
 * fails any script whose leading token cannot be found in node_modules/.bin —
 * that rule exists to catch Storybook-class rot, where a script survives long
 * after the tool it calls was uninstalled. It caught this on the first CI run,
 * which is the rule doing its job.
 *
 * WHY A GLOB: `tools/gates` had ten spec files, six with an npm script and TWO
 * invoked by a workflow. A per-spec script has to be remembered twice — once in
 * package.json and once in CI — and it was the second one that got forgotten
 * every time. Globbing the directory means a gate spec written tomorrow is
 * covered the moment the file exists.
 *
 * WHY RECURSIVE: rule owners live in subdirectories (tools/gates/infra-policy/,
 * ARIA-HIGH-012) with their spec next to them. A top-level-only glob left such a
 * spec with no runner. `fixtures/` holds test inputs, never specs to run.
 *
 * WHY THE ONE ENUMERATOR: CI (`npm run gates:test`) and the pre-commit hook both
 * run this script, so the two cannot disagree about which specs exist.
 * `--list` prints the specs without running them; spec-has-a-runner.spec.ts
 * compares that list with what the gates:test runner declares it owns.
 *
 * WHY ./node_modules/.bin/ts-node: the compiler the workspace pins (see the
 * ORPHAN-012 note in .husky/pre-commit), not whatever `npx` resolves.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gatesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(gatesDir, '..', '..');

const SKIP_DIRS = new Set(['fixtures', 'node_modules']);

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
    return entry.name.endsWith('.spec.ts')
      ? [relative(gatesDir, join(dir, entry.name)).split(sep).join('/')]
      : [];
  });
}

const specs = walk(gatesDir).sort();

if (process.argv.includes('--list')) {
  for (const spec of specs) console.log(`tools/gates/${spec}`);
  process.exit(0);
}

if (specs.length === 0) {
  console.error('run-all: no gate specs found — the glob or the directory moved.');
  process.exit(1);
}

const failed = [];
for (const spec of specs) {
  const rel = `tools/gates/${spec}`;
  console.log(`--- ${rel}`);
  const tsNode = join(repoRoot, 'node_modules', '.bin', 'ts-node');
  const result = spawnSync(tsNode, ['--project', 'tools/gates/tsconfig.json', rel], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.status !== 0) failed.push(rel);
}

if (failed.length > 0) {
  console.error(`run-all: ${failed.length} gate suite(s) failed:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
console.log(`run-all: ${specs.length} gate suite(s) passed.`);
