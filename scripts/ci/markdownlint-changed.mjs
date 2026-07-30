#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const lintAllDocs = process.argv.slice(2).includes('--all');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function changedDocs(baseRef) {
  const args = ['diff', '--name-only', '--diff-filter=ACMRT', baseRef, '--', 'docs/**/*.md'];
  const result = run('git', args);
  if (result.status !== 0) {
    throw new Error(`markdownlint base ${baseRef} cannot be resolved: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md') && existsSync(resolve(repoRoot, line)));
}

const explicitBase = process.env.MARKDOWNLINT_BASE_REF;
let files = [];
if (!lintAllDocs) {
  files = explicitBase ? changedDocs(explicitBase) : [];
  if (files.length === 0 && !explicitBase) {
    files = changedDocs('HEAD');
  }
}

if (!lintAllDocs && files.length === 0) {
  console.log('markdownlint-changed: no changed docs/**/*.md files');
  process.exit(0);
}

const prettierConfig = JSON.parse(readFileSync(resolve(repoRoot, '.prettierrc'), 'utf8'));
if (
  typeof prettierConfig.printWidth !== 'number' ||
  !Number.isSafeInteger(prettierConfig.printWidth) ||
  prettierConfig.printWidth <= 0
) {
  throw new Error('.prettierrc printWidth must be a positive integer');
}

const markdownlintConfigDirectory = mkdtempSync(join(tmpdir(), 'aqua-markdownlint-'));
const markdownlintConfigPath = join(markdownlintConfigDirectory, 'config.json');
try {
  writeFileSync(
    markdownlintConfigPath,
    `${JSON.stringify({
      MD013: {
        line_length: prettierConfig.printWidth,
        tables: false,
      },
    })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );

  const localMarkdownlintBin = resolve(repoRoot, 'node_modules/.bin/markdownlint');
  const markdownlintBin = existsSync(localMarkdownlintBin) ? localMarkdownlintBin : 'markdownlint';
  const targets = lintAllDocs ? ['docs/**/*.md'] : files;
  const result = run(
    markdownlintBin,
    [...targets, '--config', markdownlintConfigPath, '--ignore', 'node_modules'],
    {
      stdio: 'inherit',
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(markdownlintConfigPath);
  rmdirSync(markdownlintConfigDirectory);
}
