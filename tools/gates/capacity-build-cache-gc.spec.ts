#!/usr/bin/env ts-node
/**
 * The capacity gate must be able to reclaim Docker's build cache
 * (INFRA-HIGH-189).
 *
 * From 2026-09-21 every development deploy was refused by the capacity gate:
 * free space 13% against a 20% floor, the image pass reclaiming 0 bytes because
 * all 77 images were protected, and the temp pass finding little. The space was
 * in Docker's build cache — 34.64 GB, 19.36 GB of it reclaimable — a store
 * neither pass may touch, so no image reached the development server for six
 * days.
 *
 * These tests run the real `safe_build_cache_gc` against a `docker` stub that
 * records its arguments. What they pin is what the pass does, and just as much
 * what it must never do: prune a volume, an image, a container or a network.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { removeFixtureTree } from './fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh');

interface Run {
  output: string;
  dockerCalls: string[];
}

/**
 * Slice the pass out of the capacity script and run it with stubbed helpers.
 *
 * Sourcing the whole script executes its main path, which talks to the real
 * Docker daemon. The slice keeps the subject under test real while `docker`,
 * `docker_root`, `df_bytes_row` and `capacity_gc_target_met` are fixtures.
 */
function runPass(env: Record<string, string> = {}): Run {
  const body = readFileSync(SCRIPT, 'utf8');
  const start = body.indexOf('BUILD_CACHE_GC_MIN_AGE=');
  const end = body.indexOf('# safe_tmp_gc — reclaim REGENERABLE build caches');
  assert.ok(start > 0 && end > start, 'safe_build_cache_gc must sit above safe_tmp_gc');
  const pass = body.slice(start, body.lastIndexOf('\n# ====', end));

  const dir = mkdtempSync(join(tmpdir(), 'buildcache-gc-'));
  try {
    const log = join(dir, 'docker-calls.log');
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    const docker = join(bin, 'docker');
    writeFileSync(
      docker,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1 $2" = "system df" ]; then printf 'TYPE TOTAL\\nBuild Cache 34.64GB\\n'; fi\n`,
    );
    chmodSync(docker, 0o755);
    writeFileSync(log, '');

    const harness = join(dir, 'harness.sh');
    writeFileSync(
      harness,
      [
        '#!/bin/bash',
        'set -uo pipefail',
        'docker_root() { echo /var/lib/docker; }',
        "df_bytes_row() { printf 'fs\\t100\\t40\\t/\\n'; }",
        'capacity_gc_target_met() { CAPACITY_GC_TARGET_MET=true; return 0; }',
        pass,
        'safe_build_cache_gc',
        '',
      ].join('\n'),
    );

    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...env },
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      dockerCalls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    removeFixtureTree(dir);
  }
}

void test('prunes unused build cache older than the age floor', () => {
  const { dockerCalls, output } = runPass();

  assert.deepEqual(dockerCalls, ['builder prune --force --all --filter until=24h']);
  assert.match(output, /Safe build-cache GC complete; min_age=24h dry_run=false/);
});

void test('the age floor is configurable and always applied', () => {
  const { dockerCalls } = runPass({ BUILD_CACHE_GC_MIN_AGE: '72h' });

  assert.deepEqual(dockerCalls, ['builder prune --force --all --filter until=72h']);
});

void test('never reaches any other Docker store', () => {
  // Volumes hold the platform's data; images and containers are the running
  // release. A pass that reclaimed space from any of them would be a worse
  // outage than the full disk it answers.
  const { dockerCalls } = runPass();

  for (const call of dockerCalls) {
    assert.doesNotMatch(call, /\b(volume|system prune|image|container|network|rmi|rm)\b/);
  }
});

void test('dry run reports without pruning', () => {
  const { dockerCalls, output } = runPass({ GC_DRY_RUN: 'true' });

  assert.ok(
    !dockerCalls.some((call) => call.startsWith('builder prune')),
    'dry run must prune nothing',
  );
  assert.match(
    output,
    /\[dry-run\] would run: docker builder prune --force --all --filter until=24h/,
  );
  assert.match(output, /Build Cache 34\.64GB/);
});

void test('the capacity gate calls it when it is short of space', () => {
  // A reclaim pass nobody invokes is the defect this finding is about.
  const body = readFileSync(SCRIPT, 'utf8');
  const gate = body.slice(body.indexOf('run_gate() {'));
  const gcBlock = gate.slice(0, gate.indexOf('capacity_diagnostic_snapshot'));

  const image = gcBlock.indexOf('safe_image_gc');
  const buildCache = gcBlock.indexOf('safe_build_cache_gc');
  const temp = gcBlock.indexOf('safe_tmp_gc');
  assert.ok(
    image > 0 && buildCache > image && temp > buildCache,
    'image, then build cache, then temp',
  );
});
