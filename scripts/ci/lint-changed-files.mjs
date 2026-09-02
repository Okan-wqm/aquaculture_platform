#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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
  console.error('lint-changed-files: --base and --head are required.');
  process.exit(2);
}

function runGit(args, cwd = repoRoot) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`lint-changed-files: git ${args.join(' ')} failed.`);
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

function isLintedTypeScriptFile(file) {
  return (
    /\.(?:ts|tsx)$/.test(file) &&
    !/\.d\.ts$/.test(file) &&
    !/^apps\/[^/]+\/src\/database\/migrations\/[0-9]{13}-Baseline\.ts$/.test(file)
  );
}

function readBaseline() {
  const baselinePath = join(repoRoot, 'scripts/ci/lint-changed-files-baseline.txt');
  if (!existsSync(baselinePath)) return new Set();

  return new Set(
    readFileSync(baselinePath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

function changedTypeScriptFiles() {
  const baseline = readBaseline();
  const statusLines = runGit([
    'diff',
    '--name-status',
    '--diff-filter=ACMR',
    options.base,
    options.head,
    '--',
  ])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  /** @type {{ headPath: string; basePath: string | null }[]} */
  const files = [];

  for (const line of statusLines) {
    const parts = line.split('\t');
    const status = parts[0] ?? '';
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C');
    const basePath = isRenameOrCopy ? (parts[1] ?? null) : (parts[1] ?? null);
    const headPath = isRenameOrCopy ? (parts[2] ?? '') : (parts[1] ?? '');

    if (!headPath || !isLintedTypeScriptFile(headPath)) continue;
    if (baseline.has(headPath)) continue;

    files.push({
      headPath,
      basePath: status.startsWith('A') ? null : basePath,
    });
  }

  return files;
}

function eslintCommand() {
  const override = process.env.ESLINT_BIN;
  if (override) {
    return { command: override, prefixArgs: [] };
  }

  const toolchainRunner = join(repoRoot, 'tools', 'toolchain', 'run.mjs');
  if (existsSync(toolchainRunner)) {
    return { command: process.execPath, prefixArgs: [toolchainRunner, 'eslint'] };
  }

  return { command: 'npx', prefixArgs: ['eslint'] };
}

function runEslintChunk(cwd, files, label) {
  const outputDir = mkdtempSync(join(tmpdir(), 'aqua-eslint-json-'));
  const outputPath = join(outputDir, 'eslint-results.json');
  const { command, prefixArgs } = eslintCommand();
  const pluginResolverArgs = process.env.ESLINT_RESOLVE_PLUGINS_RELATIVE_TO
    ? ['--resolve-plugins-relative-to', process.env.ESLINT_RESOLVE_PLUGINS_RELATIVE_TO]
    : [];
  const result = spawnSync(
    command,
    [
      ...prefixArgs,
      ...pluginResolverArgs,
      '--format',
      'json',
      '--output-file',
      outputPath,
      ...files,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 256 * 1024 * 1024,
    },
  );

  if (result.error) {
    console.error(
      `lint-changed-files: failed to start ESLint for ${label}: ${result.error.message}`,
    );
    rmSync(outputDir, { recursive: true, force: true });
    process.exit(1);
  }

  if ((result.status ?? 0) > 1) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(
      `lint-changed-files: ESLint failed for ${label} with ` +
        `exit code ${result.status} signal ${result.signal ?? 'none'}.`,
    );
    rmSync(outputDir, { recursive: true, force: true });
    process.exit(result.status);
  }

  if (!existsSync(outputPath)) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(
      `lint-changed-files: ESLint produced no JSON for ${label} ` +
        `(exit=${result.status ?? 'null'}, signal=${result.signal ?? 'none'}).`,
    );
    rmSync(outputDir, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }

  const rawJson = readFileSync(outputPath, 'utf8');
  rmSync(outputDir, { recursive: true, force: true });

  try {
    return JSON.parse(rawJson);
  } catch (error) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    const message = error instanceof Error ? error.message : String(error);
    console.error(`lint-changed-files: failed to parse ESLint JSON for ${label}: ${message}`);
    process.exit(result.status ?? 1);
  }
}

function eslintChunkSize() {
  const raw = process.env.ESLINT_CHUNK_SIZE ?? '40';
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`lint-changed-files: invalid ESLINT_CHUNK_SIZE=${raw}`);
    process.exit(2);
  }
  return parsed;
}

/**
 * The workspace a file belongs to, as a grouping key.
 *
 * Nested workspace roots (`web/modules/<name>`, `platform/libs/<name>`) take
 * three segments; everything else takes two (`apps/<name>`, `libs/<name>`,
 * `web/<name>`, `mcp/<name>`, …). Files outside any workspace (`tools/…`,
 * `tests/…`, `scripts/…`) fall back to their first segment, which is a single
 * group and therefore a single program.
 */
function workspaceKey(filePath) {
  const segments = filePath.split('/').filter(Boolean);
  if (segments.length <= 1) return '.';
  const nestedRoots = new Set(['web/modules', 'platform/libs']);
  const twoSegment = `${segments[0]}/${segments[1]}`;
  if (nestedRoots.has(twoSegment) && segments.length > 2) {
    return `${twoSegment}/${segments[2]}`;
  }
  return twoSegment;
}

function runEslint(cwd, files, label) {
  if (files.length === 0) return [];

  // Group by workspace BEFORE chunking by count.
  //
  // The chunk size bounds how many FILES one ESLint process sees, but the
  // memory an ESLint process actually costs is driven by how many distinct
  // TypeScript PROGRAMS it has to build — type-aware rules load the whole
  // program behind each file's tsconfig. Thirty files inside one project is
  // cheap; thirty files spread across twenty projects makes a single process
  // hold twenty programs at once, which is how this job reached the 6 GB heap
  // ceiling and died with "ESLint produced no JSON" (INFRA-HIGH-101). The
  // count-based chunk never engaged because thirty is below the default of
  // forty — the unit was simply the wrong one.
  //
  // Grouping first makes peak memory a function of the LARGEST SINGLE project,
  // not of how many projects a pull request happens to touch. Worst case this
  // spawns more ESLint processes; that costs wall-clock, not correctness.
  const groups = new Map();
  for (const file of files) {
    const key = workspaceKey(toRelativeFilePath(file, cwd));
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }

  const chunkSize = eslintChunkSize();
  const results = [];
  for (const [key, groupFiles] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (let index = 0; index < groupFiles.length; index += chunkSize) {
      const chunk = groupFiles.slice(index, index + chunkSize);
      const chunkLabel =
        groupFiles.length > chunkSize
          ? `${label} ${key} files ${index + 1}-${index + chunk.length}/${groupFiles.length}`
          : `${label} ${key}`;
      results.push(...runEslintChunk(cwd, chunk, chunkLabel));
    }
  }

  return results;
}

function toRelativeFilePath(filePath, cwd) {
  const normalized = relative(cwd, filePath).split('\\').join('/');
  return normalized.startsWith('..') ? filePath.split('\\').join('/') : normalized;
}

function severityLabel(severity) {
  return severity === 2 ? 'error' : 'warning';
}

function problemKey(problem) {
  return [problem.comparePath, String(problem.severity), problem.ruleId, problem.message].join(
    '\0',
  );
}

function countProblems(results, cwd, comparePathFor) {
  /** @type {Map<string, { count: number; problem: LintProblem }>} */
  const counts = new Map();

  for (const result of results) {
    const relativePath = toRelativeFilePath(String(result.filePath), cwd);
    const comparePath = comparePathFor(relativePath);

    for (const message of result.messages ?? []) {
      const problem = {
        path: relativePath,
        comparePath,
        line: Number(message.line ?? 0),
        column: Number(message.column ?? 0),
        severity: Number(message.severity ?? 2),
        ruleId: String(message.ruleId ?? 'eslint-fatal'),
        message: String(message.message ?? 'Unknown ESLint finding'),
      };
      const key = problemKey(problem);
      const current = counts.get(key);
      counts.set(key, {
        count: (current?.count ?? 0) + 1,
        problem: current?.problem ?? problem,
      });
    }
  }

  return counts;
}

/**
 * Overlay HEAD's lint configuration onto the base worktree.
 *
 * The gate measures whether a CHANGE introduces new lint errors. If the base is
 * linted with the base commit's eslint/tsconfig but head with head's, a lint
 * CONFIG refactor on the branch (a stricter rule, a new override glob, a deleted
 * per-project config) makes every newly-linted pre-existing issue look like a
 * NEW regression — base lints them with the old, looser config and reports 0,
 * head with the new config and reports N.
 *
 * Syncing head's config files into the base worktree makes BOTH sides lint with
 * the SAME ruleset, so the base-vs-head delta isolates CODE changes from CONFIG
 * changes — the gate then flags only errors the diff actually introduced.
 */
function syncLintConfigFromHead(worktree) {
  const headSha = runGit(['rev-parse', options.head]).trim();
  // Config files that determine the ruleset: eslint configs + the tsconfigs its
  // type-aware rules resolve. `:(glob)` makes `**` match at any depth (incl.
  // root); `--no-renames` reduces every rename to a delete + add so the loop
  // stays a simple per-path apply.
  const configPathspecs = [
    ':(glob)**/.eslintrc*',
    ':(glob)**/eslint.config.*',
    // The flat config is split: eslint.config.mjs `import`s eslint.project-overrides.mjs
    // (the translated per-project .eslintrc.cjs overrides). Without this pathspec the
    // base worktree gets eslint.config.mjs but not the module it imports, so ESLint 9
    // aborts with ERR_MODULE_NOT_FOUND before any rule runs. Match every eslint*.mjs
    // sibling so future config splits stay covered automatically.
    ':(glob)**/eslint.*.mjs',
    // eslint.config.mjs imports the root toolchain runtime before loading Nx's
    // plugin. That runtime owner is part of the lint ruleset, so the base
    // comparison worktree must receive HEAD's copy together with the config.
    ':(glob)tools/toolchain/**/*.mjs',
    ':(glob)**/tsconfig*.json',
    ':(glob)**/.eslintignore',
  ];
  // Two-dot (base..head), NOT three-dot: the worktree is checked out at
  // `options.base` itself (not the merge-base), so we must overlay every config
  // that differs between base and head — including a config the branch did NOT
  // touch but that advanced on base after the branch's merge-base (a three-dot
  // diff would miss it, leaving the base worktree on a different ruleset).
  const nameStatus = runGit([
    'diff',
    '--no-renames',
    '--name-status',
    '--diff-filter=ACMD',
    `${options.base}..${headSha}`,
    '--',
    ...configPathspecs,
  ]);
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    if (!path) continue;
    const dest = join(worktree, path);
    if (status.startsWith('D')) {
      // Deleted at head — remove it so the base lints without it too.
      rmSync(dest, { force: true });
    } else {
      // Added/modified at head — bring head's version into the worktree.
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, runGit(['show', `${headSha}:${path}`]));
    }
  }
}

function prepareBaseWorktree() {
  const parent = mkdtempSync(join(tmpdir(), 'aqua-lint-base-'));
  const worktree = join(parent, 'repo');
  runGit(['worktree', 'add', '--quiet', '--detach', worktree, options.base]);

  const rootNodeModules = join(repoRoot, 'node_modules');
  const baseNodeModules = join(worktree, 'node_modules');
  if (existsSync(rootNodeModules) && !existsSync(baseNodeModules)) {
    symlinkSync(rootNodeModules, baseNodeModules, 'dir');
  }

  // Lint the base CONTENT with HEAD's CONFIG (see syncLintConfigFromHead) so the
  // base-vs-head delta reflects code changes, not lint-config changes.
  syncLintConfigFromHead(worktree);

  return { parent, worktree };
}

function removeBaseWorktree(parent, worktree) {
  rmSync(join(worktree, 'node_modules'), { force: true });

  const result = spawnSync('git', ['worktree', 'remove', '--force', worktree], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0 && result.stderr) {
    process.stderr.write(result.stderr);
  }

  rmSync(parent, { recursive: true, force: true });
}

function writeReport(report) {
  const artifactDir = join(repoRoot, 'artifacts', 'ci-lint');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, 'changed-files-lint-delta.json'),
    JSON.stringify(report, null, 2),
  );
}

/**
 * @typedef {{
 *   path: string;
 *   comparePath: string;
 *   line: number;
 *   column: number;
 *   severity: number;
 *   ruleId: string;
 *   message: string;
 * }} LintProblem
 */

const changedFiles = changedTypeScriptFiles();

if (changedFiles.length === 0) {
  console.log('No changed TypeScript files require file-level lint.');
  process.exit(0);
}

if (options.base === EMPTY_TREE_SHA) {
  console.log(
    'File-level lint delta has no parent snapshot during bootstrap; full project lint owns validation.',
  );
  process.exit(0);
}

console.log('File-level lint changed TypeScript files:');
for (const file of changedFiles) {
  const baseLabel = file.basePath ? ` (base: ${file.basePath})` : ' (new file)';
  console.log(`  ${file.headPath}${baseLabel}`);
}

const headFiles = changedFiles.map((file) => file.headPath);
const headToBase = new Map(
  changedFiles.map((file) => [file.headPath, file.basePath ?? file.headPath]),
);

const headResults = runEslint(repoRoot, headFiles, options.head);

const { parent, worktree } = prepareBaseWorktree();

try {
  const baseFiles = changedFiles
    .filter((file) => file.basePath && existsSync(join(worktree, file.basePath)))
    .map((file) => file.basePath);

  const baseResults = runEslint(worktree, baseFiles, options.base);
  const baseCounts = countProblems(baseResults, worktree, (path) => path);
  const headCounts = countProblems(headResults, repoRoot, (path) => headToBase.get(path) ?? path);

  const regressions = [];

  for (const [key, head] of headCounts.entries()) {
    const baseCount = baseCounts.get(key)?.count ?? 0;
    if (head.count > baseCount) {
      regressions.push({
        ...head.problem,
        baseCount,
        headCount: head.count,
        addedCount: head.count - baseCount,
      });
    }
  }

  regressions.sort((left, right) =>
    `${left.path}:${left.line}:${left.column}:${left.ruleId}`.localeCompare(
      `${right.path}:${right.line}:${right.column}:${right.ruleId}`,
    ),
  );

  writeReport({
    base: options.base,
    head: options.head,
    changedFileCount: changedFiles.length,
    currentFindingCount: [...headCounts.values()].reduce((sum, item) => sum + item.count, 0),
    baseFindingCount: [...baseCounts.values()].reduce((sum, item) => sum + item.count, 0),
    regressionCount: regressions.reduce((sum, item) => sum + item.addedCount, 0),
    regressions,
  });

  // Severity is the SSoT for contract-vs-advisory: rules the platform
  // treats as architectural contracts are configured at error level;
  // warning-level rules (e.g. aquaculture/no-direct-event-publish,
  // tracked as DATA-HIGH-004) are deliberate advisories. The gate
  // therefore BLOCKS only on error-level regressions and reports
  // warning-level regressions loudly without re-judging their severity.
  //
  // The full list is always printed (the previous 100-line cap masked
  // an entire second regression batch on this very branch); the JSON
  // report additionally persists everything for artifacts.
  const errorRegressions = regressions.filter((item) => item.severity === 2);
  const warningRegressions = regressions.filter((item) => item.severity !== 2);

  const printRegression = (regression) =>
    console.error(
      `  ${regression.path}:${regression.line}:${regression.column} ` +
        `${severityLabel(regression.severity)} ${regression.ruleId} ` +
        `(base=${regression.baseCount}, head=${regression.headCount}) ` +
        `${regression.message}`,
    );

  if (warningRegressions.length > 0) {
    console.error(
      `Warning-level lint regressions relative to ${options.base} ` +
        `(report-only, NOT blocking — severity is owned by the rule config): ` +
        `${warningRegressions.reduce((sum, item) => sum + item.addedCount, 0)}`,
    );
    for (const regression of warningRegressions) {
      printRegression(regression);
    }
  }

  if (errorRegressions.length > 0) {
    console.error(
      `New error-level lint findings relative to ${options.base}: ` +
        `${errorRegressions.reduce((sum, item) => sum + item.addedCount, 0)}`,
    );
    for (const regression of errorRegressions) {
      printRegression(regression);
    }
    process.exit(1);
  }

  console.log(
    `No new error-level lint findings relative to ${options.base}. ` +
      `Existing lint debt stays owned by project quarantine policy.`,
  );
} finally {
  removeBaseWorktree(parent, worktree);
}
