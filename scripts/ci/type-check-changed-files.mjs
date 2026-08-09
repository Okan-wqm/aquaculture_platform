#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const repoRoot = resolve(process.cwd());
const canonicalRepoRoot = realpathSync(repoRoot);

const isWithin = (root, candidate) => {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
};

const canonicalTempRoot = realpathSync(tmpdir());
if (isWithin(canonicalRepoRoot, canonicalTempRoot)) {
  console.error(
    `type-check-changed-files: refusing scratch root inside repository: ${canonicalTempRoot}`,
  );
  process.exit(1);
}

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
      console.error(`type-check-changed-files: failed to run ${command}: ${result.error.message}`);
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

const changedTypeScriptFiles = changedFiles.filter((file) => /\.(?:c|m)?tsx?$/.test(file));

if (changedTypeScriptFiles.length === 0) {
  console.log('No changed TypeScript files require project type-check.');
  process.exit(0);
}

function isTestFile(file) {
  return (
    /(?:^|\/)__tests__\//.test(file) ||
    /(?:^|\/)test\//.test(file) ||
    /(?:^|\/)test-utils\//.test(file) ||
    /\.(?:spec|test)\.tsx?$/.test(file)
  );
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(join(repoRoot, candidate)));
}

// WHY: tools/ projects nest to varying depths — `tools/gates/` carries its
// tsconfig.json one level under `tools/`, but `tools/executors/cargo/` is two
// levels down. A fixed `${projectRoot}/tsconfig.json` lookup misses the deeper
// case and reports nested sources (e.g. executors/cargo/src/run/executor.ts) as
// unmapped. WHAT: walk up from the file's own directory to the project root and
// return the first tsconfig.json found, so any tool nesting depth resolves to
// its owning project config automatically.
function nearestTsconfig(file, projectRoot) {
  let dir = dirname(file);
  while (dir === projectRoot || dir.startsWith(`${projectRoot}/`)) {
    const candidate = `${dir}/tsconfig.json`;
    if (existsSync(join(repoRoot, candidate))) return candidate;
    if (dir === projectRoot) break;
    dir = dirname(dir);
  }
  return null;
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
  if (top === 'e2e') return 'e2e';
  if (top === 'mcp' && second) return `${top}/${second}`;
  if (top === 'scripts' && second) return 'scripts';
  if (top === 'tests' && second === 'invariants') return 'tests/invariants';
  if (top === 'tests' && second === 'e2e' && third) {
    return `${top}/${second}/${third}`;
  }
  if (top === 'tools' && second) return `${top}/${second}`;

  return null;
}

function tsconfigFor(file) {
  if (file === 'codegen.ts') {
    return firstExisting(['tsconfig.base.json']);
  }

  const root = projectRootFor(file);
  if (!root) return null;

  if (root === 'tests/invariants') {
    return firstExisting([`${root}/tsconfig.spec.json`, `${root}/tsconfig.json`]);
  }

  if (root === 'tools/scripts') {
    return firstExisting(['tools/scripts/tsconfig.json', 'tsconfig.base.json']);
  }

  if (root === 'scripts') {
    return nearestTsconfig(file, root) ?? firstExisting(['tools/gates/tsconfig.json']);
  }

  if (root.startsWith('tools/')) {
    return nearestTsconfig(file, root);
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

function declarationFilesFor(tsconfig) {
  const projectRoot = dirname(tsconfig);
  if (projectRoot === '.') return [];

  const declarations = [];
  const root = join(repoRoot, projectRoot);
  const ignoredDirectories = new Set(['.git', '.nx', 'coverage', 'dist', 'node_modules', 'tmp']);

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(join(dir, entry.name));
        }
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        declarations.push(join(dir, entry.name));
      }
    }
  }

  if (existsSync(root)) {
    walk(root);
  }

  return declarations;
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
  console.error('type-check-changed-files: changed TypeScript files have no known tsconfig owner:');
  for (const file of unmapped) console.error(`  - ${file}`);
  process.exit(1);
}

console.log('Changed TypeScript files mapped to project tsconfigs:');
for (const [tsconfig, files] of tsconfigs.entries()) {
  console.log(`  ${tsconfig}`);
  for (const file of files) console.log(`    - ${file}`);
}

const ownedTempDirectories = new Set();
const removeOwnedTempDirectory = (directory) => {
  if (!ownedTempDirectories.delete(directory)) return;
  rmSync(directory, { recursive: true, force: true });
};
process.once('exit', () => {
  for (const directory of [...ownedTempDirectories]) removeOwnedTempDirectory(directory);
});

for (const tsconfig of tsconfigs.keys()) {
  const createdTempDir = mkdtempSync(join(canonicalTempRoot, 'aqua-changed-tsc-'));
  const tempDir = realpathSync(createdTempDir);
  if (dirname(tempDir) !== canonicalTempRoot || isWithin(canonicalRepoRoot, tempDir)) {
    rmSync(createdTempDir, { recursive: true, force: true });
    throw new Error(
      `type-check-changed-files: scratch directory escaped its external authority: ${tempDir}`,
    );
  }
  ownedTempDirectories.add(tempDir);
  const tempConfig = join(tempDir, 'tsconfig.json');
  const files = tsconfigs.get(tsconfig) ?? [];
  try {
    writeFileSync(
      tempConfig,
      JSON.stringify(
        {
          extends: join(repoRoot, tsconfig),
          compilerOptions: {
            noEmit: true,
            typeRoots: [join(repoRoot, 'node_modules', '@types')],
          },
          files: [...declarationFilesFor(tsconfig), ...files.map((file) => join(repoRoot, file))],
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
  } finally {
    removeOwnedTempDirectory(tempDir);
  }
}

console.log(`type-check-changed-files: ${tsconfigs.size} project tsconfig(s) passed.`);
