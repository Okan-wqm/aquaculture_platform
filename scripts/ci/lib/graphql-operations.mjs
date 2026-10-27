/**
 * The FE GraphQL operation check as a module (DET crossfile-5, ledger Z-E3 / Z38).
 *
 * WHY. `scripts/ci/validate-graphql-operations.mjs` is the exact check: it runs
 * `graphql.validate(schema, parse(op))` over every frontend operation against the
 * composed supergraph, as the gateway does at request time. It was a CI-only
 * script with a top-level `main`, so nothing could import the check and ARIA's
 * drift seeder never ran it; a hook selecting a field the supergraph does not
 * serve was seen by CI alone. The check lives here, once, and both callers run
 * it: the gate (zero-new-drift ratchet, exit codes, baseline) and, through the
 * gate's `--json`, ARIA's seeder. A second validator would duplicate graphql-js
 * (arguments, variables, fragments, unions) against a hand-built contract table.
 */
import { parse, validate } from 'graphql';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// FE/mcp source roots that ship GraphQL operations to the gateway.
const SCAN_ROOTS = ['web/modules', 'web/apps', 'web/shell', 'web/shared-ui', 'mcp'];

function listFiles() {
  const patterns = SCAN_ROOTS.flatMap((r) => [`${r}/**/*.ts`, `${r}/**/*.tsx`]);
  return execFileSync('git', ['ls-files', ...patterns], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean)
    .filter(
      (f) =>
        !f.includes('.spec.') &&
        !f.includes('.test.') &&
        !f.includes('/generated/') &&
        !f.includes('/dist/'),
    );
}

const OP_RE = /`([^`]*?\b(?:query|mutation|subscription)\s+[^`]*?)`/g;

function categorize(messages) {
  const joined = messages.join(' | ');
  if (/Cannot query field ".*" on type "(Query|Mutation|Subscription)"/.test(joined))
    return 'MISSING-ROOT-OP';
  if (/Unknown type/.test(joined)) return 'MISSING-INPUT-TYPE';
  if (/Unknown argument/.test(joined)) return 'BAD-ARGUMENT';
  if (/used in position expecting type/.test(joined)) return 'VAR-TYPE-MISMATCH';
  if (/must (?:not )?have a selection/.test(joined)) return 'SELECTION-SHAPE';
  if (/Cannot query field/.test(joined)) return 'MISSING-FIELD';
  return 'OTHER';
}

/** The drift of the tracked FE tree against `schema`: `{key,file,op,category,messages}`, sorted by key. */
export function collectDrift(schema) {
  const drift = [];
  for (const file of listFiles()) {
    let src;
    try {
      src = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    let m;
    while ((m = OP_RE.exec(src)) !== null) {
      let body = m[1];
      if (!/^\s*(query|mutation|subscription)\b/m.test(body)) continue;
      // Drop ${...} interpolation (fragment injection / dynamic). Irreducible
      // cases that fail to parse are skipped here and caught by codegen (A1).
      body = body.replace(/\$\{[^}]*\}/g, '');
      let doc;
      try {
        doc = parse(body);
      } catch {
        continue;
      }
      // Fragment spreads defined in a sibling file produce "Unknown fragment"
      // which is NOT schema drift — exclude it (codegen owns fragment wiring).
      const errors = validate(schema, doc).filter(
        (e) => !/Unknown fragment|never used/i.test(e.message),
      );
      if (!errors.length) continue;
      const op =
        (body.match(/(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/) || [])[1] || '(anonymous)';
      drift.push({
        key: `${file}::${op}`,
        file,
        op,
        category: categorize(errors.map((e) => e.message)),
        messages: errors.map((e) => e.message),
      });
    }
  }
  return drift.sort((a, b) => a.key.localeCompare(b.key));
}
