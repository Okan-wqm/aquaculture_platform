#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryRoot, targetArguments } from './test-support.mjs';

const verificationRoot = join(
  repositoryRoot,
  'docs/plans/2026-09-01-new-aria-autonomous-engineering/verification',
);

function gitStatus() {
  return execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repositoryRoot,
    encoding: null,
  });
}

function targetFlags(target) {
  return [
    '--base',
    target.baseSha,
    '--head',
    target.headSha,
    '--reviewed-ref',
    target.reviewedRef,
    '--base-tree',
    target.baseTree,
    '--head-tree',
    target.headTree,
    '--diff-sha256',
    target.diffSha256,
    '--design-sha256',
    target.designSha256,
    '--format-scope-sha256',
    target.formatScopeSha256,
  ];
}

function run(label, script, args, ownerRoot) {
  const childRoot = mkdtempSync(join(ownerRoot, `${label}-`));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(verificationRoot, script), ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, TMPDIR: childRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status, signal) => {
      rmSync(childRoot, { recursive: true, force: true });
      resolve({
        label,
        signal,
        status,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

const target = targetArguments();
const flags = targetFlags(target);
const before = gitStatus();
const ownerRoot = mkdtempSync(join(tmpdir(), 'new-aria-parallel-owner-'));
const sentinel = join(ownerRoot, 'controller-sentinel');
writeFileSync(sentinel, 'owned-by-parallel-controller\n');

try {
  const results = await Promise.all([
    run('negative', 'test-negative-controls.mjs', ['--repo-root', '.', ...flags], ownerRoot),
    run('integrity', 'test-integrity-regressions.mjs', [], ownerRoot),
    run('full', 'verify-d0.mjs', ['--repo-root', '.', '--mode', 'full', ...flags], ownerRoot),
  ]);
  for (const result of results) {
    assert.equal(
      result.status,
      0,
      `${result.label} failed signal=${result.signal}\n${result.stdout}${result.stderr}`,
    );
  }
  assert.match(results[0].stdout, /PASS negative-controls=/u);
  assert.match(results[1].stdout, /PASS integrity-regressions/u);
  assert.match(results[2].stdout, /PASS D0 verifier/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'owned-by-parallel-controller\n');
  assert.deepEqual(readdirSync(ownerRoot), ['controller-sentinel']);
  assert(before.equals(gitStatus()), 'parallel verification changed repository status');
} finally {
  rmSync(ownerRoot, { recursive: true, force: true });
}

process.stdout.write('PASS parallel-isolation suites=2 verifier=1 sibling-cleanup=exact-owner\n');
