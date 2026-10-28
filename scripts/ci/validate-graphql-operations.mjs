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
 *   node scripts/ci/validate-graphql-operations.mjs --json             # NEW drift as one JSON array on stdout
 *
 * The check itself (`collectDrift`) lives in `./lib/graphql-operations.mjs`, the one
 * module CI (this gate) and ARIA's drift seeder (through `--json`) both run.
 * `--json` changes the output only: the exit codes and the ratchet are unchanged,
 * and the human report moves to stderr so stdout holds the array and nothing else.
 */
import { buildSchema } from 'graphql';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, collectDrift } from './lib/graphql-operations.mjs';

const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'ci', 'graphql-fe-drift.baseline.json');

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const JSON_OUTPUT = args.includes('--json');
const schemaArg = args[args.indexOf('--schema') + 1];
const SCHEMA_PATH = args.includes('--schema')
  ? schemaArg
  : join(REPO_ROOT, 'dist', 'graphql', 'supergraph.graphql');

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

// --json: stdout is the NEW drift (what the gate holds against the tree) and nothing else.
if (JSON_OUTPUT) process.stdout.write(`${JSON.stringify(NEW)}\n`);
const report = JSON_OUTPUT ? console.error : console.log;

report(
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

// The exit code is set, not forced with process.exit(): a pipe flushes stdout asynchronously, so an
// explicit exit after the --json array cut it at the pipe buffer (64 KiB, measured on Node 22).
if (!baseline) {
  console.error(`\n⚠️  No baseline at ${relative(REPO_ROOT, BASELINE_PATH)} — generate it once with --update-baseline.`);
  process.exitCode = drift.length ? 1 : 0;
} else if (failed) {
  process.exitCode = 1;
} else {
  report(`\n✅ GraphQL FE↔supergraph contract gate PASS — no new drift; ${baselineKeys.size} tracked drifts pending burn-down.`);
}
