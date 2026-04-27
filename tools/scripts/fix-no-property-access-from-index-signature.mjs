#!/usr/bin/env node
/**
 * fix-no-property-access-from-index-signature
 *
 * Programmatic fixer for PROC-MEDIUM-011 phase 2. Runs `tsc -p
 * <project>/tsconfig.spec.json --noEmit` against every monorepo
 * project, parses the TS4111 errors that
 * `noPropertyAccessFromIndexSignature: true` produces, and rewrites
 * each `obj.foo` access at the reported line:col into `obj['foo']`.
 *
 * The error message format is:
 *   path/file.ts(LINE,COL): error TS4111: Property 'foo' comes from
 *   an index signature, so it must be accessed with ['foo'].
 *
 * Strategy: read the file, locate the dot just before the property
 * at (line, col-1), turn `.foo` into `['foo']`. Column is 1-indexed.
 * Property name is parsed from the error message (always the value
 * inside the first single-quoted string).
 *
 * Why a script and not sed: TS4111 fires on `obj.foo` only when
 * `obj` has an index signature — `process.env.NODE_ENV`,
 * `Record<string, unknown>['x']`, `req.headers.contenttype` etc.
 * Plain property access on a typed interface keeps the dot form.
 * A blind sed `\.([a-z]+)` replacement would corrupt thousands of
 * legitimate property accesses. Using tsc's exact line:col output
 * is the only safe transform.
 *
 * Usage:
 *   node tools/scripts/fix-no-property-access-from-index-signature.mjs
 *
 * The script enables the setting in tsconfig.base.json before
 * running, so the rewrites converge to 0 in one or two passes.
 * Caller restores the base config if the run is aborted.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE_TSCONFIG = join(REPO_ROOT, 'tsconfig.base.json');
const BASE_TSCONFIG_BACKUP = join(REPO_ROOT, 'tsconfig.base.original.json.bak');

const PROJECTS = [
  'apps/admin-api-service',
  'apps/ai-service',
  'apps/alert-engine',
  'apps/auth-service',
  'apps/billing-service',
  'apps/config-service',
  'apps/db-migrate',
  'apps/event-store-service',
  'apps/farm-service',
  'apps/gateway-api',
  'apps/hr-service',
  'apps/hydroponics-service',
  'apps/messaging-service',
  'apps/notification-service',
  'apps/observability-service',
  'apps/sensor-service',
  'libs/backend-common',
  'libs/event-contracts',
  'libs/migration-harness',
  'libs/storage',
  'platform/libs/event-bus',
  'platform/libs/outbox',
];

function enableSetting() {
  copyFileSync(BASE_TSCONFIG, BASE_TSCONFIG_BACKUP);
  const config = JSON.parse(readFileSync(BASE_TSCONFIG, 'utf8'));
  config.compilerOptions.noPropertyAccessFromIndexSignature = true;
  writeFileSync(BASE_TSCONFIG, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function restoreSetting() {
  copyFileSync(BASE_TSCONFIG_BACKUP, BASE_TSCONFIG);
}

/**
 * Run tsc against one project and return the parsed TS4111 errors.
 * Each entry: { file, line, col, prop }.
 *
 * Note: tsc may report errors in files NOT under this project
 * (cross-lib imports). We trust the reported path; if the file is
 * outside this project's source tree, we still rewrite it — that's
 * the correct behaviour because the violation lives in the imported
 * file, not at the import site.
 */
function probeProject(project) {
  const tsc = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  const cfg = join(REPO_ROOT, project, 'tsconfig.spec.json');
  let out = '';
  try {
    out = execFileSync(
      tsc,
      ['-p', cfg, '--noEmit', '--pretty', 'false'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
        maxBuffer: 50 * 1024 * 1024,
      },
    );
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const errors = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+error TS4111:\s+Property '([^']+)' comes from an index signature/gm;
  let m;
  while ((m = re.exec(out)) !== null) {
    errors.push({
      file: m[1],
      line: parseInt(m[2], 10),
      col: parseInt(m[3], 10),
      prop: m[4],
    });
  }
  return errors;
}

/**
 * Apply edits to a single file. Edits are sorted by (line desc,
 * col desc) so each rewrite doesn't shift the columns of later
 * edits on the same line.
 *
 * For each edit at (line, col, prop):
 *   - col points to the character AFTER the dot (the start of `prop`).
 *   - We delete the dot at col-1 and replace `prop` with `['prop']`.
 *
 * If the source at (line, col-1) is not a dot, we skip — the file
 * may have changed since the probe. The script re-runs the probe
 * on a second pass to catch leftovers.
 */
function applyEdits(absolutePath, edits) {
  const source = readFileSync(absolutePath, 'utf8');
  const lines = source.split('\n');

  // Group edits by line and apply right-to-left within each line.
  const byLine = new Map();
  for (const e of edits) {
    if (!byLine.has(e.line)) byLine.set(e.line, []);
    byLine.get(e.line).push(e);
  }

  let changed = 0;
  for (const [lineNum, lineEdits] of byLine.entries()) {
    lineEdits.sort((a, b) => b.col - a.col);
    let line = lines[lineNum - 1];
    if (line === undefined) continue;
    for (const e of lineEdits) {
      const dotPos = e.col - 2; // col is 1-indexed; property starts at col, dot at col-1
      if (line[dotPos] !== '.') continue;
      const propEnd = dotPos + 1 + e.prop.length;
      // Sanity: the chars at [dotPos+1, propEnd) must equal e.prop.
      if (line.slice(dotPos + 1, propEnd) !== e.prop) continue;
      // Optional chain (`obj?.foo`) needs to become `obj?.['foo']`
      // (dot preserved before bracket). Plain access (`obj.foo`)
      // becomes `obj['foo']` (dot removed). Earlier versions of this
      // script unconditionally removed the dot, producing the invalid
      // `obj?['foo']` form — fixed in PR-42 follow-through.
      const isOptional = line[dotPos - 1] === '?';
      const replacement = isOptional ? `.['${e.prop}']` : `['${e.prop}']`;
      line = line.slice(0, dotPos) + replacement + line.slice(propEnd);
      changed += 1;
    }
    lines[lineNum - 1] = line;
  }

  if (changed > 0) {
    writeFileSync(absolutePath, lines.join('\n'), 'utf8');
  }
  return changed;
}

function main() {
  enableSetting();
  let total = 0;
  try {
    for (let pass = 1; pass <= 3; pass++) {
      let passTotal = 0;
      for (const project of PROJECTS) {
        const errors = probeProject(project);
        if (errors.length === 0) continue;
        // Group errors by absolute file path.
        const byFile = new Map();
        for (const e of errors) {
          const abs = e.file.startsWith('/') ? e.file : join(REPO_ROOT, e.file);
          if (!byFile.has(abs)) byFile.set(abs, []);
          byFile.get(abs).push(e);
        }
        for (const [abs, fileEdits] of byFile.entries()) {
          const changed = applyEdits(abs, fileEdits);
          passTotal += changed;
        }
      }
      console.log(`Pass ${pass}: rewrote ${passTotal} accesses`);
      total += passTotal;
      if (passTotal === 0) break;
    }
    console.log(`Total: ${total} access-form rewrites`);
  } finally {
    restoreSetting();
  }
}

main();
