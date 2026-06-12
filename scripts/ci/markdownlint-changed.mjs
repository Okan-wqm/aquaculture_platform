#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

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
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.md') && existsSync(resolve(repoRoot, line)));
}

const explicitBase = process.env.MARKDOWNLINT_BASE_REF;
let files = explicitBase ? changedDocs(explicitBase) : [];
if (files.length === 0 && !explicitBase) {
  files = changedDocs('HEAD');
}

if (files.length === 0) {
  console.log('markdownlint-changed: no changed docs/**/*.md files');
  process.exit(0);
}

const markdownlintBin = resolve(repoRoot, 'node_modules/.bin/markdownlint');
const result = run(markdownlintBin, [...files, '--ignore', 'node_modules'], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
