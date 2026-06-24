#!/usr/bin/env node
/**
 * GraphQL FE↔supergraph contract validation gate (SSoT enforcement).
 *
 * WHY this exists
 * ----------------
 * Frontend GraphQL operations are hand-written and sent to the gateway as
 * strings/documents; nothing validated them against the schema until RUNTIME,
 * so drift accumulated silently (139 ops at introduction) and surfaced as
 * intermittent HTTP-400s ("data sometimes loads, sometimes not"). This gate
 * mirrors EXACTLY what the gateway does at request time — `graphql.validate(
 * schema, parse(op))` — but at build time, across EVERY frontend operation, so
 * a drifted field/argument/type is caught in CI instead of in production.
 *
 * Schema source (freshness)
 * -------------------------
 * Validates against the COMPOSED supergraph at `dist/graphql/supergraph.graphql`.
 * In CI this script runs AFTER `scripts/apollo-router/build-supergraph.mjs`
 * composes a fresh supergraph from the current code, so it can never validate
 * against a stale schema. Pass `--schema <path>` to override.
 *
 * Zero-new-drift ratchet (burn-down, NOT silencing)
 * -------------------------------------------------
 * The 139 pre-existing drifts are recorded in a committed, human-readable
 * baseline (`scripts/ci/graphql-fe-drift.baseline.json`). The gate enforces:
 *   1. ZERO new drift   — any op NOT in the baseline that fails → FAIL (hard wall).
 *   2. Monotonic shrink — a baselined op that now PASSES must be removed
 *      (regenerate the baseline) → keeps the debt visible + shrinking.
 * This is the opposite of an allowlist that hides: every entry is listed by
 * file+op+category and traceable to docs/reviews/2026-06-24-graphql-fe-be-
 * contract-drift-audit.md. A new op cannot reuse a silenced bad field because
 * baseline keys are operation+file specific.
 *
 * Usage:
 *   node scripts/ci/validate-graphql-operations.mjs                 # gate (CI)
 *   node scripts/ci/validate-graphql-operations.mjs --update-baseline  # regen baseline after fixes
 *   node scripts/ci/validate-graphql-operations.mjs --schema path/to/supergraph.graphql
 */
import { buildSchema, parse, validate } from 'graphql';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'ci', 'graphql-fe-drift.baseline.json');

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const schemaArg = args[args.indexOf('--schema') + 1];
const SCHEMA_PATH = args.includes('--schema')
  ? schemaArg
  : join(REPO_ROOT, 'dist', 'graphql', 'supergraph.graphql');

// FE/mcp source roots that ship GraphQL operations to the gateway.
const SCAN_ROOTS = ['web/modules', 'web/apps', 'web/shell', 'web/shared-ui', 'mcp'];

function loadSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    // FAIL LOUD — never vacuous-pass. A missing schema means the compose step
    // did not run; validating nothing would hide all drift.
    console.error(
      `\n[graphql-validate] FATAL: supergraph schema not found at ${SCHEMA_PATH}\n` +
        `  Run \`npm run apollo-router:compose\` first (CI composes it before this gate).\n`,
    );
    process.exit(2);
  }
  return buildSchema(readFileSync(SCHEMA_PATH, 'utf8'), { assumeValidSDL: true });
}

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

function collectDrift(schema) {
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
      const op = (body.match(/(?:query|mutation|subscription)\s+([A-Za-z0-9_]+)/) || [])[1] || '(anonymous)';
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

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { keys: new Set(), raw: null };
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return { keys: new Set(raw.operations.map((o) => o.key)), raw };
}

// ---- main ----
const schema = loadSchema();
const drift = collectDrift(schema);
const driftKeys = new Set(drift.map((d) => d.key));

if (UPDATE_BASELINE) {
  const payload = {
    $schema: 'GraphQL FE↔supergraph drift baseline — burn-down ratchet, MUST only shrink',
    generatedAgainst: relative(REPO_ROOT, SCHEMA_PATH),
    report: 'docs/reviews/2026-06-24-graphql-fe-be-contract-drift-audit.md',
    count: drift.length,
    operations: drift.map(({ key, file, op, category }) => ({ key, file, op, category })),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[graphql-validate] baseline written: ${drift.length} known drifts → ${relative(REPO_ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const { keys: baselineKeys, raw: baseline } = loadBaseline();
const NEW = drift.filter((d) => !baselineKeys.has(d.key)); // regressions — hard fail
const FIXED = [...baselineKeys].filter((k) => !driftKeys.has(k)); // must be removed from baseline

console.log(
  `[graphql-validate] schema=${relative(REPO_ROOT, SCHEMA_PATH)} | current drift=${drift.length} | baseline=${baselineKeys.size}`,
);

let failed = false;

if (NEW.length) {
  failed = true;
  console.error(`\n❌ ${NEW.length} NEW GraphQL contract drift(s) — these reference fields/ops the supergraph does not serve:\n`);
  for (const d of NEW) {
    console.error(`  • ${d.op} (${d.category})  [${d.file}]`);
    for (const msg of d.messages.slice(0, 3)) console.error(`      → ${msg}`);
  }
  console.error(`\nFix the operation (author it as a typed gql document in src/graphql/) or the resolver. The gate is a hard wall at zero new drift.`);
}

if (FIXED.length) {
  failed = true;
  console.error(`\n❌ ${FIXED.length} baselined drift(s) now PASS — burn them down by regenerating the baseline:\n`);
  for (const k of FIXED) console.error(`  • ${k}`);
  console.error(`\nRun: node scripts/ci/validate-graphql-operations.mjs --update-baseline  (then commit the shrunk baseline)`);
}

if (!baseline) {
  console.error(`\n⚠️  No baseline at ${relative(REPO_ROOT, BASELINE_PATH)} — generate it once with --update-baseline.`);
  process.exit(drift.length ? 1 : 0);
}

if (failed) process.exit(1);
console.log(`\n✅ GraphQL FE↔supergraph contract gate PASS — no new drift; ${baselineKeys.size} tracked drifts pending burn-down.`);
