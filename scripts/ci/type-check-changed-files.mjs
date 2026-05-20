#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(process.cwd());

/** @type {{ base: string; head: string }} */
const options = {
  base: 'origin/main',
  head: 'HEAD',
};

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--base') {
    options.base = process.argv[++i] ?? '';
  } else if (arg === '--head') {
    options.head = process.argv[++i] ?? '';
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!options.base || !options.head) {
  console.error('type-check-changed-files: --base and --head are required.');
  process.exit(2);
}

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) {
      console.error(
        `type-check-changed-files: failed to run ${command}: ${result.error.message}`,
      );
    }
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const changedFiles = run('git', [
  'diff',
  '--name-only',
  '--diff-filter=ACMR',
  `${options.base}...${options.head}`,
])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const changedTypeScriptFiles = changedFiles.filter((file) =>
  /\.(?:c|m)?tsx?$/.test(file),
);

if (changedTypeScriptFiles.length === 0) {
  console.log('No changed TypeScript files require project type-check.');
  process.exit(0);
}

function isTestFile(file) {
  return /(?:^|\/)__tests__\//.test(file) || /\.(?:spec|test)\.tsx?$/.test(file);
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(join(repoRoot, candidate)));
}

function projectRootFor(file) {
  const parts = file.split('/');
  const [top, second, third] = parts;

  if (top === 'apps' && second) return `${top}/${second}`;
  if (top === 'libs' && second) return `${top}/${second}`;
  if (top === 'platform' && second === 'libs' && third) {
    return `${top}/${second}/${third}`;
  }
  if (top === 'web' && (second === 'modules' || second === 'apps') && third) {
    return `${top}/${second}/${third}`;
  }
  if (top === 'web' && (second === 'shared-ui' || second === 'shell')) {
    return `${top}/${second}`;
  }
  if (top === 'tests' && second === 'invariants') return 'tests/invariants';
  if (top === 'tools' && second) return `${top}/${second}`;

  return null;
}

function tsconfigFor(file) {
  const root = projectRootFor(file);
  if (!root) return null;

  if (root === 'tests/invariants') {
    return firstExisting([
      `${root}/tsconfig.spec.json`,
      `${root}/tsconfig.json`,
    ]);
  }

  if (root.startsWith('tools/')) {
    return firstExisting([`${root}/tsconfig.json`]);
  }

  const testCandidates = [
    `${root}/tsconfig.spec.json`,
    `${root}/tsconfig.test.json`,
    `${root}/tsconfig.json`,
  ];
  const productionCandidates = [
    `${root}/tsconfig.app.json`,
    `${root}/tsconfig.lib.json`,
    `${root}/tsconfig.json`,
    `${root}/tsconfig.spec.json`,
  ];

  return firstExisting(isTestFile(file) ? testCandidates : productionCandidates);
}

/** @type {Map<string, string[]>} */
const tsconfigs = new Map();
const unmapped = [];

for (const file of changedTypeScriptFiles) {
  const tsconfig = tsconfigFor(file);
  if (!tsconfig) {
    unmapped.push(file);
    continue;
  }
  const files = tsconfigs.get(tsconfig) ?? [];
  files.push(file);
  tsconfigs.set(tsconfig, files);
}

if (unmapped.length > 0) {
  console.error(
    'type-check-changed-files: changed TypeScript files have no known tsconfig owner:',
  );
  for (const file of unmapped) console.error(`  - ${file}`);
  process.exit(1);
}

console.log('Changed TypeScript files mapped to project tsconfigs:');
for (const [tsconfig, files] of tsconfigs.entries()) {
  console.log(`  ${tsconfig}`);
  for (const file of files) console.log(`    - ${file}`);
}

const tempRoot = join(repoRoot, '.aria-ci');
mkdirSync(tempRoot, { recursive: true });

for (const tsconfig of tsconfigs.keys()) {
  const tempDir = mkdtempSync(join(tempRoot, 'aqua-changed-tsc-'));
  const tempConfig = join(tempDir, 'tsconfig.json');
  const files = tsconfigs.get(tsconfig) ?? [];
  writeFileSync(
    tempConfig,
    JSON.stringify(
      {
        extends: join(repoRoot, tsconfig),
        compilerOptions: {
          noEmit: true,
        },
        files: files.map((file) => join(repoRoot, file)),
        include: [],
      },
      null,
      2,
    ),
  );
  console.log(
    `type-check-changed-files: tsc --noEmit -p ${tsconfig} ` +
      `(${files.length} changed file(s))`,
  );
  run(process.execPath, [
    resolve(repoRoot, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--pretty',
    'false',
    '-p',
    tempConfig,
  ]);
}

console.log(
  `type-check-changed-files: ${tsconfigs.size} project tsconfig(s) passed.`,
);
