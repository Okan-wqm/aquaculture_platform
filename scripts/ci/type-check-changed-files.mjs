#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BOOTSTRAP_UNOWNED_BASELINE = join(
  repoRoot,
  'scripts/ci/type-check-bootstrap-unowned-baseline.txt',
);

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
  options.base,
  options.head,
  '--',
])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

// E13-C3 — adapter fixture mini-workspaces are SCAN TARGETS, not
// compilation units: the adapters parse them from disk with
// ts.createSourceFile, and the semantic_regression lane deliberately
// ships them with incomplete decorator/type contexts (that is what the
// cases exercise). Type-checking them as project code fails on exactly
// the shapes the fixtures exist to carry.
const TYPE_CHECK_EXEMPT = [
  /^tools\/aria-adapters\/fixtures\/[^/]+\/workspaces\//,
  // Migration squashes retain the replaced chain under
  // migrations/.archive/<timestamp>/ as forensic evidence. Those snapshots
  // are deliberately absent from runtime registration, build inputs, and
  // migration validation; compiling them as live source can also resolve
  // imports against a directory layout that no longer exists.
  /(?:^|\/)migrations\/\.archive\//,
  // new-aria/ is a SEPARATE PROJECT TREE that lives in this repository only
  // until it moves to its own. It carries its own tsconfigs
  // (new-aria/tools/gates/tsconfig.json for the kernel-side TypeScript,
  // new-aria/ui/{server,web}/tsconfig.json for the console) and its own CI
  // lane runs them, so these files ARE type-checked — just not by this
  // repository's projects, whose module resolution and lib settings are the
  // monorepo's, not the copy's. This is the same treatment new-aria already
  // has in .nxignore, eslint.config.mjs and the banned-phrase/construct
  // gates, and for the same reason: compiling a standalone tree with the
  // host's configuration measures the host, not the tree.
  /^new-aria\//,
];

const changedTypeScriptFiles = changedFiles
  .filter((file) => /\.(?:c|m)?tsx?$/.test(file))
  .filter((file) => !TYPE_CHECK_EXEMPT.some((pattern) => pattern.test(file)));

function isTestFile(file) {
  return (
    /(?:^|\/)__tests__\//.test(file) ||
    /(?:^|\/)test\//.test(file) ||
    /(?:^|\/)test-utils\//.test(file) ||
    /\.(?:spec|test)\.tsx?$/.test(file)
  );
}

function isE2eFile(file) {
  return (
    /(?:^|\/)test\//.test(file) ||
    /(?:^|\/)__tests__\/e2e\//.test(file) ||
    /\.e2e-spec\.tsx?$/.test(file)
  );
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(join(repoRoot, candidate))) ?? null;
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

  if (isE2eFile(file)) {
    const e2eConfig = firstExisting([`${root}/tsconfig.e2e.json`]);
    if (e2eConfig) return e2eConfig;
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

function readBootstrapUnownedBaseline() {
  if (!existsSync(BOOTSTRAP_UNOWNED_BASELINE)) {
    console.error(
      `type-check-changed-files: missing bootstrap ownership baseline: ${BOOTSTRAP_UNOWNED_BASELINE}`,
    );
    process.exit(1);
  }

  const entries = readFileSync(BOOTSTRAP_UNOWNED_BASELINE, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const sorted = [...new Set(entries)].sort();
  const invalid = entries.filter(
    (file) =>
      file.startsWith('/') || file.split('/').includes('..') || !/\.(?:c|m)?tsx?$/u.test(file),
  );
  if (
    invalid.length > 0 ||
    entries.length !== sorted.length ||
    entries.some((v, i) => v !== sorted[i])
  ) {
    console.error(
      'type-check-changed-files: bootstrap ownership baseline must be sorted, unique, relative TypeScript paths.',
    );
    for (const file of invalid) console.error(`  - ${file}`);
    process.exit(1);
  }
  return sorted;
}

function trackedTypeScriptFiles() {
  return run('git', ['ls-files', '--', '*.ts', '*.tsx', '*.mts', '*.cts'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !TYPE_CHECK_EXEMPT.some((pattern) => pattern.test(file)));
}

const bootstrapUnownedBaseline = readBootstrapUnownedBaseline();
const trackedUnowned = trackedTypeScriptFiles().filter((file) => tsconfigFor(file) === null);
const baselineSet = new Set(bootstrapUnownedBaseline);
const trackedUnownedSet = new Set(trackedUnowned);
const staleBaseline = bootstrapUnownedBaseline.filter((file) => !trackedUnownedSet.has(file));
const untrackedDebt = trackedUnowned.filter((file) => !baselineSet.has(file));

if (staleBaseline.length > 0 || untrackedDebt.length > 0) {
  if (staleBaseline.length > 0) {
    console.error(
      'type-check-changed-files: baseline entries are no longer unowned; remove or correct them:',
    );
    for (const file of staleBaseline) console.error(`  - ${file}`);
  }
  if (untrackedDebt.length > 0) {
    console.error(
      'type-check-changed-files: untracked bootstrap ownership debt; add a tsconfig owner:',
    );
    for (const file of untrackedDebt) console.error(`  - ${file}`);
  }
  process.exit(1);
}

if (changedTypeScriptFiles.length === 0) {
  console.log('No changed TypeScript files require project type-check.');
  process.exit(0);
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

if (unmapped.length > 0 && options.base === EMPTY_TREE_SHA) {
  const unexpected = unmapped.filter((file) => !baselineSet.has(file));
  const missing = bootstrapUnownedBaseline.filter((file) => !unmapped.includes(file));
  if (unexpected.length > 0 || missing.length > 0) {
    console.error(
      'type-check-changed-files: bootstrap ownership baseline does not match the range:',
    );
    for (const file of unexpected) console.error(`  + ${file}`);
    for (const file of missing) console.error(`  - ${file}`);
    process.exit(1);
  }
  console.log(
    `type-check-changed-files: bootstrap inherited unowned TypeScript: ${unmapped.length} file(s)`,
  );
} else if (unmapped.length > 0) {
  console.error('type-check-changed-files: changed TypeScript files have no known tsconfig owner:');
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
const tempRunRoot = mkdtempSync(join(tempRoot, 'type-check-'));
const tempConfig = join(tempRunRoot, 'tsconfig.json');
process.on('exit', () => {
  rmSync(tempRunRoot, { recursive: true, force: true });
});

for (const tsconfig of tsconfigs.keys()) {
  const files = tsconfigs.get(tsconfig) ?? [];
  writeFileSync(
    tempConfig,
    JSON.stringify(
      {
        extends: join(repoRoot, tsconfig),
        compilerOptions: {
          noEmit: true,
        },
        files: [...declarationFilesFor(tsconfig), ...files.map((file) => join(repoRoot, file))],
        include: [],
      },
      null,
      2,
    ),
  );
  console.log(
    `type-check-changed-files: tsc --noEmit -p ${tsconfig} ` + `(${files.length} changed file(s))`,
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

console.log(`type-check-changed-files: ${tsconfigs.size} project tsconfig(s) passed.`);
