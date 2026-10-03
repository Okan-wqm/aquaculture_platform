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
 * Every document, interpolated ones included (FE-MEDIUM-315)
 * ---------------------------------------------------------
 * Documents are read from the TypeScript AST (lib/graphql-documents.mjs), not a
 * backtick regex. A `${...}` inside a selection set is validated as `__typename`
 * instead of being deleted, which used to leave `items { }` and skip the whole
 * document (223 of 1039 on 405f2ecac). A document that still cannot be parsed
 * (interpolation inside an argument list, malformed text) is listed in the
 * call-site baseline's `unparseableDocuments` and ratcheted, never passed.
 *
 * Call-site variables (FE-MEDIUM-315)
 * -----------------------------------
 * GraphQL drops a variable its operation does not declare, so the gate also
 * reads every call that sends a document (lib/graphql-call-sites.mjs) and
 * compares its variables with the operation's declarations: an undeclared key
 * or a missing required variable is a mismatch. Mismatches are a burn-down
 * list and unresolvable call sites (spread, non-literal, later mutate()) a COUNT, both
 * in scripts/ci/graphql-call-site-variables.baseline.json and both ratcheted the
 * same two ways as the drift baseline: a new entry fails, and a fixed entry
 * must leave the baseline. That half needs no schema: `--call-sites-only` runs
 * it alone (tests/invariants/graphql-call-site-variables.spec.ts does, on every
 * PR, and pins the baseline ceilings).
 *
 * Usage:
 *   node scripts/ci/validate-graphql-operations.mjs                 # gate (CI)
 *   node scripts/ci/validate-graphql-operations.mjs --update-baseline  # regen baselines after fixes
 *   node scripts/ci/validate-graphql-operations.mjs --schema path/to/supergraph.graphql
 *   node scripts/ci/validate-graphql-operations.mjs --call-sites-only  # call sites + parseability only
 */
import { buildSchema, validate } from 'graphql';
import { format, resolveConfig } from 'prettier';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { SourceIndex } from './lib/graphql-documents.mjs';
import {
  collectCallSites,
  describeMismatch,
  isMismatch,
  mismatchKey,
} from './lib/graphql-call-sites.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'ci', 'graphql-fe-drift.baseline.json');
const CALL_SITE_BASELINE_PATH = join(
  REPO_ROOT,
  'scripts',
  'ci',
  'graphql-call-site-variables.baseline.json',
);

const args = process.argv.slice(2);
const UPDATE_BASELINE = args.includes('--update-baseline');
const CALL_SITES_ONLY = args.includes('--call-sites-only');
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

function collectDrift(schema, documents) {
  const drift = [];
  for (const doc of documents) {
    if (!doc.ast || !doc.ast.definitions.some((d) => d.kind === 'OperationDefinition')) continue;
    // Fragment spreads defined in a sibling constant produce "Unknown fragment"
    // which is NOT schema drift — exclude it (codegen owns fragment wiring).
    const errors = validate(schema, doc.ast).filter(
      (e) => !/Unknown fragment|never used/i.test(e.message),
    );
    if (!errors.length) continue;
    drift.push({
      key: `${doc.file}::${doc.name}`,
      file: doc.file,
      op: doc.name,
      category: categorize(errors.map((e) => e.message)),
      messages: errors.map((e) => e.message),
    });
  }
  return drift.sort((a, b) => a.key.localeCompare(b.key));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { keys: new Set(), raw: null };
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  return { keys: new Set(raw.operations.map((o) => o.key)), raw };
}

/** Write a baseline exactly as the repository's Prettier would, so a regenerated file is commit-clean. */
async function writeBaseline(path, payload) {
  const options = (await resolveConfig(path)) ?? {};
  writeFileSync(path, await format(JSON.stringify(payload), { ...options, filepath: path }));
}

/** `key#n` for the n-th repeat of a key, so two identical mismatches stay two entries. */
function numbered(items, keyOf) {
  const seen = new Map();
  return items.map((item) => {
    const base = keyOf(item);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...item, key: n === 1 ? base : `${base}#${n}` };
  });
}

function loadCallSiteBaseline() {
  if (!existsSync(CALL_SITE_BASELINE_PATH))
    return { mismatches: [], unresolved: 0, unparseableDocuments: [] };
  return JSON.parse(readFileSync(CALL_SITE_BASELINE_PATH, 'utf8'));
}

/** Entries present now but not in the baseline, and baselined entries now gone. */
function diffKeys(current, baselined) {
  const now = new Set(current.map((e) => e.key));
  const then = new Set(baselined.map((e) => e.key));
  return {
    added: current.filter((e) => !then.has(e.key)),
    removed: [...then].filter((k) => !now.has(k)),
  };
}

function checkDrift(drift) {
  const driftKeys = new Set(drift.map((d) => d.key));
  const { keys: baselineKeys, raw: baseline } = loadBaseline();
  const NEW = drift.filter((d) => !baselineKeys.has(d.key)); // regressions — hard fail
  const FIXED = [...baselineKeys].filter((k) => !driftKeys.has(k)); // must be removed from baseline

  console.log(
    `[graphql-validate] schema=${relative(REPO_ROOT, SCHEMA_PATH)} | current drift=${drift.length} | baseline=${baselineKeys.size}`,
  );

  let failed = false;

  if (NEW.length) {
    failed = true;
    console.error(
      `\n❌ ${NEW.length} NEW GraphQL contract drift(s) — these reference fields/ops the supergraph does not serve:\n`,
    );
    for (const d of NEW) {
      console.error(`  • ${d.op} (${d.category})  [${d.file}]`);
      for (const msg of d.messages.slice(0, 3)) console.error(`      → ${msg}`);
    }
    console.error(
      `\nFix the operation (author it as a typed gql document in src/graphql/) or the resolver. The gate is a hard wall at zero new drift.`,
    );
  }

  if (FIXED.length) {
    failed = true;
    console.error(
      `\n❌ ${FIXED.length} baselined drift(s) now PASS — burn them down by regenerating the baseline:\n`,
    );
    for (const k of FIXED) console.error(`  • ${k}`);
    console.error(
      `\nRun: node scripts/ci/validate-graphql-operations.mjs --update-baseline  (then commit the shrunk baseline)`,
    );
  }

  if (!baseline) {
    console.error(
      `\n⚠️  No baseline at ${relative(REPO_ROOT, BASELINE_PATH)} — generate it once with --update-baseline.`,
    );
    return drift.length > 0;
  }
  if (!failed) {
    console.log(
      `✅ GraphQL FE↔supergraph contract gate PASS — no new drift; ${baselineKeys.size} tracked drifts pending burn-down.`,
    );
  }
  return failed;
}

function checkCallSites(sites, mismatches, unparseable) {
  const baseline = loadCallSiteBaseline();
  const unresolved = sites.filter((s) => s.unresolved);
  const docDiff = diffKeys(unparseable, baseline.unparseableDocuments);
  const siteDiff = diffKeys(mismatches, baseline.mismatches);
  let failed = false;

  console.log(
    `[graphql-validate] call sites: ${sites.length - unresolved.length} resolved, ${unresolved.length} unresolved, ` +
      `${mismatches.length} mismatched | unparseable documents: ${unparseable.length}`,
  );
  console.log(
    `[graphql-validate] unresolved call sites: ${unresolved.length} (baseline ${baseline.unresolved})`,
  );

  if (siteDiff.added.length) {
    failed = true;
    console.error(
      `\n❌ ${siteDiff.added.length} NEW call-site variable mismatch(es) — GraphQL drops an undeclared variable and rejects a missing required one:\n`,
    );
    for (const site of siteDiff.added) console.error(`  • ${describeMismatch(site)}`);
    console.error(
      `\nSend exactly the variables the operation declares (or declare the ones the resolver takes).`,
    );
  }
  if (docDiff.added.length) {
    failed = true;
    console.error(
      `\n❌ ${docDiff.added.length} NEW GraphQL document(s) the gate cannot parse, so cannot validate:\n`,
    );
    for (const doc of docDiff.added)
      console.error(`  • ${doc.file}:${doc.line} ${doc.op} — ${doc.reason}`);
  }
  if (unresolved.length > baseline.unresolved) {
    failed = true;
    console.error(
      `\n❌ unresolved call sites rose ${baseline.unresolved} → ${unresolved.length}. A call site whose variables are not a literal object cannot be checked; write them literally. All unresolved sites:\n`,
    );
    for (const site of unresolved)
      console.error(`  • ${site.file}:${site.line} ${site.op} — ${site.unresolved}`);
  }
  const shrunk = [...siteDiff.removed, ...docDiff.removed];
  if (shrunk.length || unresolved.length < baseline.unresolved) {
    failed = true;
    console.error(
      `\n❌ the call-site baseline is above what the tree has — burn it down by regenerating it:\n`,
    );
    for (const k of shrunk) console.error(`  • ${k}`);
    if (unresolved.length < baseline.unresolved) {
      console.error(`  • unresolved ${baseline.unresolved} → ${unresolved.length}`);
    }
    console.error(
      `\nRun: node scripts/ci/validate-graphql-operations.mjs --update-baseline  (then lower the ceilings in tests/invariants/graphql-call-site-variables.spec.ts)`,
    );
  }
  return failed;
}

// ---- main ----
const index = new SourceIndex(REPO_ROOT);
const documents = index.documents();
const unparseable = numbered(
  documents.filter((d) => d.ast === null),
  (d) => `${d.file}::${d.name}`,
).map(({ key, file, line, name, error }) => ({ key, file, line, op: name, reason: error }));
const callSites = collectCallSites(index);
const mismatches = numbered(callSites.filter(isMismatch), mismatchKey);
const drift = CALL_SITES_ONLY ? [] : collectDrift(loadSchema(), documents);

if (UPDATE_BASELINE) {
  if (!CALL_SITES_ONLY) {
    const payload = {
      $schema: 'GraphQL FE↔supergraph drift baseline — burn-down ratchet, MUST only shrink',
      generatedAgainst: relative(REPO_ROOT, SCHEMA_PATH),
      report: 'docs/reviews/claude/2026-10-03-graphql-call-site-variables.md',
      count: drift.length,
      operations: drift.map(({ key, file, op, category }) => ({ key, file, op, category })),
    };
    await writeBaseline(BASELINE_PATH, payload);
    console.log(
      `[graphql-validate] baseline written: ${drift.length} known drifts → ${relative(REPO_ROOT, BASELINE_PATH)}`,
    );
  }
  const callSitePayload = {
    $schema:
      'GraphQL call-site variables baseline — burn-down ratchet, every list and count MUST only shrink',
    report: 'docs/reviews/claude/2026-10-03-graphql-call-site-variables.md',
    callSites: callSites.length,
    unresolved: callSites.filter((s) => s.unresolved).length,
    mismatches: mismatches.map((s) => ({
      key: s.key,
      file: s.file,
      line: s.line,
      op: s.op,
      undeclared: s.undeclared,
      missingRequired: s.missingRequired,
    })),
    unparseableDocuments: unparseable,
  };
  await writeBaseline(CALL_SITE_BASELINE_PATH, callSitePayload);
  console.log(
    `[graphql-validate] call-site baseline written: ${mismatches.length} mismatches, ${callSitePayload.unresolved} unresolved → ${relative(REPO_ROOT, CALL_SITE_BASELINE_PATH)}`,
  );
  process.exit(0);
}

const driftFailed = CALL_SITES_ONLY ? false : checkDrift(drift);
const callSitesFailed = checkCallSites(callSites, mismatches, unparseable);
if (driftFailed || callSitesFailed) process.exit(1);
console.log(
  `✅ GraphQL call-site variables gate PASS — ${mismatches.length} tracked mismatches pending burn-down.`,
);
