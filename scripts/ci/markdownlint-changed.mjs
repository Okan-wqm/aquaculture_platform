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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const lintAllDocs = process.argv.slice(2).includes('--all');
const docsPathspecs = [':(glob)docs/*.md', ':(glob)docs/**/*.md'];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
}

function resolveCommit(ref, role) {
  const result = run('git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(`markdownlint ${role} ${ref} cannot be resolved: ${result.stderr.trim()}`);
  }

  const oid = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new Error(`markdownlint ${role} ${ref} resolved to an invalid object id`);
  }
  return oid;
}

function parseChangedDocs(stdout) {
  const files = new Set();
  for (const file of stdout.split('\0')) {
    if (file.length === 0 || !file.endsWith('.md')) continue;
    const absolutePath = resolve(repoRoot, file);
    const relativePath = relative(repoRoot, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`markdownlint changed path escapes the repository: ${JSON.stringify(file)}`);
    }
    if (existsSync(absolutePath)) files.add(file);
  }
  return [...files].sort();
}

function changedDocs(baseRef, headRef) {
  const baseOid = resolveCommit(baseRef, 'base');
  const headOid = resolveCommit(headRef, 'head');
  const args = [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACMRT',
    `${baseOid}...${headOid}`,
    '--',
    ...docsPathspecs,
  ];
  const result = run('git', args);
  if (result.status !== 0) {
    throw new Error(
      `markdownlint range ${baseOid}...${headOid} cannot be inspected: ${result.stderr.trim()}`,
    );
  }
  return parseChangedDocs(result.stdout);
}

function changedWorkingTreeDocs() {
  const result = run('git', [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACMRT',
    'HEAD',
    '--',
    ...docsPathspecs,
  ]);
  if (result.status !== 0) {
    throw new Error(`markdownlint working tree cannot be inspected: ${result.stderr.trim()}`);
  }
  return parseChangedDocs(result.stdout);
}

const explicitBase = process.env.MARKDOWNLINT_BASE_REF;
const explicitHead = process.env.MARKDOWNLINT_HEAD_REF;
let files = [];
if (!lintAllDocs) {
  if (Boolean(explicitBase) !== Boolean(explicitHead)) {
    throw new Error(
      'MARKDOWNLINT_BASE_REF and MARKDOWNLINT_HEAD_REF must be supplied together as one immutable range',
    );
  }
  files = explicitBase ? changedDocs(explicitBase, explicitHead) : changedWorkingTreeDocs();
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
