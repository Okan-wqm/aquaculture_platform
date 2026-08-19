#!/usr/bin/env node
// @ts-check
/**
 * Per-project tsc --noEmit runner.
 *
 * Addresses AUDIT-CRITICAL-001: before this script existed, `tsc --noEmit`
 * at repo root had no tsconfig.json to pick up, so it printed help and
 * exited 0 — every PR "passed" type-check without being checked.
 *
 * Architectural choice vs composite-build: the repo has 95 tsconfig files
 * across apps/libs/platform/web; promoting each to `composite: true`
 * is a separate migration. A per-project loop here gives the same Tier-1
 * guarantee (tsc cannot no-op) without touching 95 files. Each project
 * is compiled in its own tsc process, so memory stays bounded per
 * project — a flat-include repo-root tsconfig would OOM on this runner
 * (8GB host; 1000+ sources).
 *
 * Parallelism: tsc runs are bounded by PARALLEL (env or default 3).
 * Fail-fast: the first non-zero exit aborts the remaining projects.
 *
 * Usage:
 *   node tools/scripts/type-check-all.mjs          # default parallelism
 *   PARALLEL=6 node tools/scripts/type-check-all.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd());
const PARALLEL = Number.parseInt(process.env.PARALLEL ?? '3', 10);

/**
 * Enumerate the per-project tsconfigs the runner should type-check.
 * Only the app/lib compile tsconfigs — NOT .spec.json (tests are a
 * separate pass) and NOT .build.json (build emission path). The
 * tsconfig.json at each project root usually references both app and
 * spec configs and is safe to use as the canonical entry point.
 */
function discoverProjectTsconfigs() {
  /** @type {string[]} */
  const out = [];
  const roots = [
    'apps',
    'libs',
    'platform/libs',
    'web/modules',
    'web/apps',
  ];
  for (const root of roots) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const projectDir = join(abs, name);
      if (!statSync(projectDir).isDirectory()) continue;
      const candidates = [
        join(projectDir, 'tsconfig.app.json'),
        join(projectDir, 'tsconfig.lib.json'),
        join(projectDir, 'tsconfig.json'),
      ];
      const picked = candidates.find((p) => existsSync(p));
      if (picked) out.push(picked);
    }
  }
  // Standalone roots without a sub-directory layer.
  for (const standalone of ['web/shared-ui', 'web/shell']) {
    const abs = join(REPO_ROOT, standalone);
    if (!existsSync(abs)) continue;
    const candidates = [
      join(abs, 'tsconfig.app.json'),
      join(abs, 'tsconfig.lib.json'),
      join(abs, 'tsconfig.json'),
    ];
    const picked = candidates.find((p) => existsSync(p));
    if (picked) out.push(picked);
  }
  return out.sort();
}

/**
 * @param {string} tsconfig
 * @returns {Promise<{ ok: boolean; stdout: string; stderr: string; tsconfig: string }>}
 */
function runTsc(tsconfig) {
  const tscBin = resolve(REPO_ROOT, 'node_modules/.bin/tsc');
  return new Promise((resolveP) => {
    const proc = spawn(tscBin, ['--noEmit', '-p', tsconfig], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A missing tsc used to surface as an unhandled 'error' event: the
    // process died with a spawn ENOENT stack trace, and a reader (human or
    // agent) could not tell "the gate could not run" from "the code is
    // broken". The exit code was always non-zero — the gate never passed
    // silently — but the MESSAGE decides whether anyone reads it right.
    // A worktree without node_modules is the case that produces it.
    proc.on('error', (err) => {
      resolveP({
        ok: false,
        stdout: '',
        stderr:
          `type-check-all: cannot run tsc at ${tscBin} (${err.code || err.message}). ` +
          'If this is a git worktree, link or install node_modules there ' +
          '(ln -s <repo>/node_modules, or npm ci) — the type gate cannot ' +
          'check anything without it.',
        tsconfig,
      });
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (b) => (stdout += b.toString()));
    proc.stderr.on('data', (b) => (stderr += b.toString()));
    proc.on('close', (code) => {
      resolveP({ ok: code === 0, stdout, stderr, tsconfig });
    });
  });
}

async function main() {
  const tsconfigs = discoverProjectTsconfigs();
  if (tsconfigs.length === 0) {
    console.error('type-check-all: found no per-project tsconfigs.');
    process.exit(1);
  }
  console.error(
    `type-check-all: ${tsconfigs.length} project tsconfigs, parallel=${PARALLEL}`,
  );

  const queue = [...tsconfigs];
  const failures = [];
  const active = new Set();

  async function runNext() {
    const next = queue.shift();
    if (!next) return;
    active.add(next);
    process.stderr.write(`  [start] ${next}\n`);
    const result = await runTsc(next);
    active.delete(next);
    if (result.ok) {
      process.stderr.write(`  [ok]    ${next}\n`);
    } else {
      process.stderr.write(`  [FAIL]  ${next}\n`);
      if (result.stdout.trim()) process.stdout.write(result.stdout);
      if (result.stderr.trim()) process.stderr.write(result.stderr);
      failures.push(next);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(PARALLEL, tsconfigs.length); i++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          await runNext();
        }
      })(),
    );
  }
  await Promise.all(workers);

  if (failures.length > 0) {
    console.error(
      `\ntype-check-all: ${failures.length} project(s) FAILED:`,
    );
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.error(`\ntype-check-all: all ${tsconfigs.length} projects green.`);
}

main().catch((err) => {
  console.error('type-check-all: unexpected error:', err);
  process.exit(1);
});
