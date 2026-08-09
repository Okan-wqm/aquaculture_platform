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
 * WHY DISCOVERY: `tools/gates` had spec files with ad-hoc npm scripts and only
 * invoked by a workflow. A per-spec script has to be remembered twice — once in
 * package.json and once in CI — and it was the second one that got forgotten
 * every time. Discovering the owned root means a gate spec written tomorrow is
 * covered the moment the file exists. Nested source-control-plane contracts are
 * deliberately owned by tools/test-runners/source-control-plane.mjs so this
 * fast commit-message lane stays inside its five-minute budget.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSpecFiles } from '../test-runners/spec-discovery.mjs';

const gatesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(gatesDir, '..', '..');

const specs = discoverSpecFiles(gatesDir, ['.spec.ts'], { recursive: false });
const listedSpecs = specs.map((spec) => `tools/gates/${spec}`);

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(listedSpecs));
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
