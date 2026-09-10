#!/usr/bin/env node

import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const verificationRoot = fileURLToPath(new URL('.', import.meta.url));
const thirdParty = new Set(['graphql', 'prettier', 'typescript']);
const staticImport =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](?<name>[^'"]+)['"]/gu;

function modulePath(sourcePath, specifier) {
  const candidate = normalize(join(dirname(sourcePath), specifier));
  return candidate.endsWith('.mjs') ? candidate : `${candidate}.mjs`;
}

function staticClosure(entry) {
  const pending = [entry];
  const visited = new Set();
  const packages = new Set();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (visited.has(sourcePath)) continue;
    visited.add(sourcePath);
    const source = readFileSync(sourcePath, 'utf8');
    for (const match of source.matchAll(staticImport)) {
      const specifier = match.groups.name;
      if (specifier.startsWith('.')) pending.push(modulePath(sourcePath, specifier));
      else if (!specifier.startsWith('node:')) packages.add(specifier);
    }
  }
  return {
    modules: [...visited].map((path) => relative(verificationRoot, path)).sort(),
    packages: [...packages].sort(),
  };
}

const closure = staticClosure(join(verificationRoot, 'verify-d0.mjs'));
assert.deepEqual(
  closure.packages.filter((name) => thirdParty.has(name)),
  [],
  `third-party code executes before authority validation: ${JSON.stringify(closure)}`,
);
assert.equal(
  closure.modules.includes('lib/verify.mjs'),
  false,
  'semantic verifier must be entered only from the verified private runtime snapshot',
);

const mutantRoot = mkdtempSync(join(tmpdir(), 'new-aria-bootstrap-import-mutant-'));
try {
  cpSync(verificationRoot, mutantRoot, { recursive: true });
  const mutantEntry = join(mutantRoot, 'verify-d0.mjs');
  appendFileSync(mutantEntry, "\nimport 'graphql';\n");
  assert.deepEqual(
    staticClosure(mutantEntry).packages.filter((name) => thirdParty.has(name)),
    ['graphql'],
    'static third-party import mutant escaped the bootstrap boundary test',
  );
} finally {
  rmSync(mutantRoot, { recursive: true, force: true });
}

process.stdout.write(`PASS bootstrap-import-boundary modules=${closure.modules.length}\n`);
