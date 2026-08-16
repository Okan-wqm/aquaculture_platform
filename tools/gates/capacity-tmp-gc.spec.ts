#!/usr/bin/env ts-node
/**
 * The capacity gate has to be able to reclaim the space that is actually there.
 *
 * On 2026-08-09 the gate blocked with **1.24 GB free against a 37.5 GB floor**
 * while `safe_image_gc` had nothing left to take: all 37 images backed running
 * containers, so `docker system df` honestly reported 0 B reclaimable. The
 * shortfall was in TMPDIR, and one pattern owned half the disk —
 * `nx-native-file-cache-*`, **1,421 directories, 29.3 GB**. Nx's native module
 * resolves its cache through `std::env::temp_dir()` and creates a fresh
 * directory per workspace-process; nothing removes them, so every CI
 * invocation leaks one. A manual sweep reclaimed 12.9 GB on 2026-08-08 and the
 * disk was full again inside a day.
 *
 * These tests run the real function against a decoy TMPDIR. What they pin is
 * mostly what it must NOT do: a sweeper that reclaims space by deleting
 * somebody's checkout would be far worse than the full disk it fixes.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh');

/**
 * Extract just the sweeper into a runnable file.
 *
 * Sourcing the whole capacity script executes its main path, which would talk
 * to Docker and the real filesystem. Slicing the function keeps the subject
 * under test real while the blast radius stays inside a temp directory.
 */
function sweeperHarness(): string {
  const body = readFileSync(SCRIPT, 'utf8');
  const start = body.indexOf('TMP_GC_PATTERNS=');
  const end = body.indexOf('\nrun_gate() {');
  assert.ok(start > 0 && end > start, 'safe_tmp_gc must be present, above run_gate');
  const dir = mkdtempSync(join(tmpdir(), 'tmpgc-harness-'));
  const path = join(dir, 'sweeper.sh');
  writeFileSync(path, `#!/bin/bash\nset -uo pipefail\n${body.slice(start, end)}\nsafe_tmp_gc\n`);
  return path;
}

function decoyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tmpgc-decoy-'));
  for (const name of ['nx-native-file-cache-old', 'jest_7', 'aqua-someones-checkout']) {
    mkdirSync(join(root, name));
    // Three days old: past any sane age floor.
    execFileSync('touch', ['-d', '3 days ago', join(root, name)]);
  }
  // Fresh cache — an in-flight build's, which must survive.
  mkdirSync(join(root, 'nx-native-file-cache-fresh'));
  return root;
}

function sweep(root: string, env: Record<string, string> = {}): string {
  const harness = sweeperHarness();
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: root, ...env },
  });
  return `${result.stdout}${result.stderr}`;
}

void test('reclaims the regenerable caches that filled the disk', () => {
  const root = decoyRoot();
  try {
    sweep(root);
    const left = readdirSync(root).sort();

    assert.ok(!left.includes('nx-native-file-cache-old'), 'the stale Nx cache must go');
    assert.ok(!left.includes('jest_7'), 'the stale jest cache must go');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('never touches anything outside its allowlist', () => {
  // The clause that keeps another session's work alive. A sweeper that reclaims
  // space by deleting a checkout is a worse outage than the one it fixes.
  const root = decoyRoot();
  try {
    sweep(root);

    assert.ok(readdirSync(root).includes('aqua-someones-checkout'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('leaves a cache that is younger than the age floor', () => {
  const root = decoyRoot();
  try {
    sweep(root);

    assert.ok(
      readdirSync(root).includes('nx-native-file-cache-fresh'),
      'an in-flight build must keep its cache',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('skips a directory a process still holds, however old it is', () => {
  const root = mkdtempSync(join(tmpdir(), 'tmpgc-open-'));
  const held = join(root, 'nx-native-file-cache-held');
  mkdirSync(held);
  execFileSync('touch', ['-d', '3 days ago', held]);

  // A live process whose CWD is the directory — exactly the shape of a build
  // still using its cache, and what `fuser` detects. Held across the sweep
  // rather than backgrounded, because a holder that exits first proves
  // nothing about the guard.
  const holder = spawn('sleep', ['30'], { cwd: held, stdio: 'ignore' });
  try {
    const out = sweep(root);

    assert.match(out, /skipped_open=1/);
    assert.ok(readdirSync(root).includes('nx-native-file-cache-held'));
  } finally {
    holder.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

void test('dry run reports without removing', () => {
  const root = decoyRoot();
  try {
    const out = sweep(root, { GC_DRY_RUN: 'true' });

    assert.match(out, /would remove/);
    assert.match(out, /dry_run=true/);
    assert.ok(
      readdirSync(root).includes('nx-native-file-cache-old'),
      'dry run must delete nothing',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('the capacity gate actually calls it when it is short of space', () => {
  // A sweeper nobody invokes is the defect this session has met four times.
  const body = readFileSync(SCRIPT, 'utf8');
  const gcBlock = body.slice(body.indexOf('running one safe image-only GC pass'));

  assert.match(gcBlock.slice(0, 800), /safe_tmp_gc/);
});
