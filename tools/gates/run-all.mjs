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
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gatesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(gatesDir, '..', '..');

const specs = readdirSync(gatesDir)
  .filter((entry) => entry.endsWith('.spec.ts'))
  .sort();

if (specs.length === 0) {
  console.error('run-all: no gate specs found — the glob or the directory moved.');
  process.exit(1);
}

const failed = [];
for (const spec of specs) {
  const rel = `tools/gates/${spec}`;
  console.log(`--- ${rel}`);
  const result = spawnSync('npx', ['ts-node', '--project', 'tools/gates/tsconfig.json', rel], {
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
