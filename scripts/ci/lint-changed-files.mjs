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
import { join, relative, resolve } from 'node:path';

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
    !/^apps\/[^/]+\/src\/database\/migrations\/[0-9]{13}-Baseline\.ts$/.test(
      file,
    )
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
    `${options.base}...${options.head}`,
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

  const binary = join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
  );
  if (existsSync(binary)) {
    return { command: binary, prefixArgs: [] };
  }
  return { command: 'npx', prefixArgs: ['eslint'] };
}

function runEslintChunk(cwd, files, label) {
  const outputDir = mkdtempSync(join(tmpdir(), 'aqua-eslint-json-'));
  const outputPath = join(outputDir, 'eslint-results.json');
  const { command, prefixArgs } = eslintCommand();
  const pluginResolverArgs = process.env.ESLINT_RESOLVE_PLUGINS_RELATIVE_TO
    ? [
        '--resolve-plugins-relative-to',
        process.env.ESLINT_RESOLVE_PLUGINS_RELATIVE_TO,
      ]
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
      env: {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
      },
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
    console.error(
      `lint-changed-files: failed to parse ESLint JSON for ${label}: ${message}`,
    );
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

function runEslint(cwd, files, label) {
  if (files.length === 0) return [];

  const chunkSize = eslintChunkSize();
  const results = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunk = files.slice(index, index + chunkSize);
    const chunkLabel =
      files.length > chunkSize
        ? `${label} files ${index + 1}-${index + chunk.length}/${files.length}`
        : label;
    results.push(...runEslintChunk(cwd, chunk, chunkLabel));
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
  return [
    problem.comparePath,
    String(problem.severity),
    problem.ruleId,
    problem.message,
  ].join('\0');
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

function prepareBaseWorktree() {
  const parent = mkdtempSync(join(tmpdir(), 'aqua-lint-base-'));
  const worktree = join(parent, 'repo');
  runGit(['worktree', 'add', '--quiet', '--detach', worktree, options.base]);

  const rootNodeModules = join(repoRoot, 'node_modules');
  const baseNodeModules = join(worktree, 'node_modules');
  if (existsSync(rootNodeModules) && !existsSync(baseNodeModules)) {
    symlinkSync(rootNodeModules, baseNodeModules, 'dir');
  }

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
  const headCounts = countProblems(
    headResults,
    repoRoot,
    (path) => headToBase.get(path) ?? path,
  );

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
    currentFindingCount: [...headCounts.values()].reduce(
      (sum, item) => sum + item.count,
      0,
    ),
    baseFindingCount: [...baseCounts.values()].reduce(
      (sum, item) => sum + item.count,
      0,
    ),
    regressionCount: regressions.reduce(
      (sum, item) => sum + item.addedCount,
      0,
    ),
    regressions,
  });

  if (regressions.length > 0) {
    console.error(
      `New file-level lint findings relative to ${options.base}: ` +
        `${regressions.reduce((sum, item) => sum + item.addedCount, 0)}`,
    );
    for (const regression of regressions.slice(0, 100)) {
      console.error(
        `  ${regression.path}:${regression.line}:${regression.column} ` +
          `${severityLabel(regression.severity)} ${regression.ruleId} ` +
          `(base=${regression.baseCount}, head=${regression.headCount}) ` +
          `${regression.message}`,
      );
    }
    if (regressions.length > 100) {
      console.error(
        `  ... ${regressions.length - 100} more finding groups; see ` +
          `artifacts/ci-lint/changed-files-lint-delta.json`,
      );
    }
    process.exit(1);
  }

  console.log(
    `No new file-level lint findings relative to ${options.base}. ` +
      `Existing lint debt stays owned by project quarantine policy.`,
  );
} finally {
  removeBaseWorktree(parent, worktree);
}
