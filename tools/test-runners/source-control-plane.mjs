#!/usr/bin/env node
/**
 * Canonical runner for nested finding-authority and automation-publication
 * executable contracts. The owned directory roots are discovered
 * recursively; adding a spec cannot require another package script or CI
 * workflow line.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { discoverSpecFiles } from './spec-discovery.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');
const localTsNode = join(repoRoot, 'node_modules', '.bin', 'ts-node');

const groups = [
  {
    root: 'tools/gates/lib',
    suffixes: ['.spec.ts'],
    command: (path) => [localTsNode, ['--project', 'tools/gates/tsconfig.json', path]],
  },
  {
    root: 'tools/scripts/automation',
    suffixes: ['.spec.ts', '.spec.mjs'],
    command: (path) =>
      path.endsWith('.spec.ts')
        ? [localTsNode, ['--project', 'tools/scripts/automation/tsconfig.json', path]]
        : [process.execPath, [path]],
  },
];

const specs = groups
  .flatMap((group) =>
    discoverSpecFiles(join(repoRoot, group.root), group.suffixes).map((path) => ({
      command: group.command,
      path: `${group.root}/${path}`,
    })),
  )
  .sort((left, right) => left.path.localeCompare(right.path, 'en'));

if (process.argv.includes('--list')) {
  console.log(JSON.stringify(specs.map(({ path }) => path)));
  process.exit(0);
}

if (specs.length === 0) {
  console.error('source-control-plane runner: no specs found; the ownership roots moved.');
  process.exit(1);
}

const failed = [];
for (const spec of specs) {
  const [executable, args] = spec.command(spec.path);
  console.log(`--- ${spec.path}`);
  const result = spawnSync(executable, args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) failed.push(spec.path);
}

if (failed.length > 0) {
  console.error(
    `source-control-plane runner: ${failed.length} suite(s) failed:\n  ${failed.join('\n  ')}`,
  );
  process.exit(1);
}

console.log(`source-control-plane runner: ${specs.length} suite(s) passed.`);
