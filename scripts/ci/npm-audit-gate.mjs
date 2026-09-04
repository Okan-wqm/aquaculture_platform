#!/usr/bin/env node
/**
 * npm-audit-gate — decide `npm audit` with reviewed, expiring exceptions.
 *
 * # Why this exists
 *
 * The `security-audit` job gated on npm's own exit code, which is all-or-
 * nothing: one advisory with no safe remediation turns a REQUIRED check red
 * forever, and a required check that is permanently red stops being read. The
 * gate then protects nothing — worse than a gate with a narrow, dated hole in
 * it, because nobody can tell the hole from the wall.
 *
 * SUPPLY-CRITICAL-002 is the case that forced it. `minio@8.0.7` depends on
 * `stream-json@^1.8.0`; GHSA-528h-pc64-c93x covers every stream-json `<=3.4.0`,
 * so no patched 1.x or 2.x exists, and 3.5+ is ESM-only and restructured under
 * `src/` — an override breaks minio's CommonJS
 * `require("stream-json/jsonl/Parser.js")` outright. npm's own suggestion is a
 * major DOWNGRADE of minio, and 8.0.7 is the latest published release. There is
 * no action that both keeps minio working and clears the advisory.
 *
 * # What an exception is, and is not
 *
 * It is NOT "ignore this package". It is one advisory, in one named scope,
 * bounded to the packages it was reviewed against, with an owner, an argument,
 * a registry finding and a DATE. On that date the gate fails closed again and
 * the argument has to be made afresh — which is what makes this a forcing
 * function rather than a silent policy change. The four-field shape is shared
 * with the affected-target quarantine and the dormant-invariant registry
 * (`scripts/ci/lib/reviewed-exception.mjs`), so the repository has one
 * vocabulary for "a gate we are knowingly not enforcing".
 *
 * Three things deliberately do NOT get an exception, and fail loudly instead:
 * an advisory that has a non-breaking fix (fix it), an advisory reaching a
 * package the entry does not name (the exception was reviewed against a
 * dependency graph that has since moved), and an entry whose expiry has passed.
 *
 * # Usage
 *
 *   node scripts/ci/npm-audit-gate.mjs \
 *     --audit npm-audit-root-production.json \
 *     --level moderate \
 *     --scope root-production \
 *     --exceptions scripts/ci/npm-audit-exceptions.json
 *
 * Exit 0 = every remaining advisory at or above `--level` is excepted.
 * Exit 1 = at least one is not, or an exception is malformed, expired or
 *          drifted. Exit 2 = usage error.
 */

import { existsSync, readFileSync } from 'node:fs';

import { validateReviewedException } from './lib/reviewed-exception.mjs';

const EXCEPTIONS_VERSION = 1;
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const ADVISORY_ID = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--audit') args.audit = next();
    else if (arg === '--level') args.level = next();
    else if (arg === '--scope') args.scope = next();
    else if (arg === '--exceptions') args.exceptions = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['audit', 'level', 'scope', 'exceptions']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  if (!(args.level in SEVERITY_RANK)) {
    throw new Error(`--level must be one of ${Object.keys(SEVERITY_RANK).join(', ')}`);
  }
  return args;
}

/**
 * Every advisory reaching a package, as GHSA ids. npm nests these: a package is
 * vulnerable either directly (a `via` entry that is an advisory object) or
 * because a dependency is (a `via` entry that is a package name), so the ids
 * have to be followed transitively through the report's own graph.
 */
function advisoriesFor(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const found = new Set();
  const entry = vulnerabilities[name];
  if (entry === undefined) return found;
  for (const via of entry.via ?? []) {
    if (typeof via === 'string') {
      for (const id of advisoriesFor(via, vulnerabilities, seen)) found.add(id);
      continue;
    }
    const url = typeof via.url === 'string' ? via.url : '';
    const id = url.split('/').pop() ?? '';
    if (ADVISORY_ID.test(id)) found.add(id);
  }
  return found;
}

function loadExceptions(path, today) {
  if (!existsSync(path)) {
    throw new Error(`exceptions file not found: ${path}`);
  }
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.version !== EXCEPTIONS_VERSION) {
    throw new Error(`npm audit exceptions version ${doc.version} is not ${EXCEPTIONS_VERSION}`);
  }

  const problems = [];
  for (const [id, entry] of Object.entries(doc.advisories ?? {})) {
    if (!ADVISORY_ID.test(id)) {
      problems.push(`${id}: key must be a GHSA advisory id`);
    }
    problems.push(...validateReviewedException(entry, id, today));
    if (!Array.isArray(entry?.packages) || entry.packages.length === 0) {
      problems.push(`${id}: packages must list the package names this was reviewed against`);
    }
    if (!Array.isArray(entry?.scopes) || entry.scopes.length === 0) {
      problems.push(`${id}: scopes must list the audit legs this applies to`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`npm audit exceptions are invalid:\n  ${problems.join('\n  ')}`);
  }
  return doc.advisories ?? {};
}

/**
 * @returns {{ blocking: string[], excepted: string[] }}
 */
function assess(audit, exceptions, { level, scope }) {
  const floor = SEVERITY_RANK[level];
  const vulnerabilities = audit.vulnerabilities ?? {};
  const blocking = [];
  const excepted = [];

  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const rank = SEVERITY_RANK[entry.severity] ?? 0;
    if (rank < floor) continue;

    const ids = [...advisoriesFor(name, vulnerabilities)];
    if (ids.length === 0) {
      blocking.push(`${name} (${entry.severity}) — no advisory id in the report to except`);
      continue;
    }

    const unexcused = ids.filter((id) => {
      const exception = exceptions[id];
      if (exception === undefined) return true;
      if (!exception.scopes.includes(scope)) return true;
      // An exception is bound to the packages it was reviewed against. If the
      // advisory has since reached somewhere else, that is a NEW decision.
      return !exception.packages.includes(name);
    });

    if (unexcused.length === 0) {
      excepted.push(
        `${name} (${entry.severity}) — ${ids
          .map((id) => `${id} until ${exceptions[id].expires_on} [${exceptions[id].finding_id}]`)
          .join(', ')}`,
      );
      continue;
    }

    const fix = entry.fixAvailable;
    const remedy =
      fix === true
        ? 'a non-breaking fix is available — take it rather than an exception'
        : fix && typeof fix === 'object'
          ? `npm suggests ${fix.name}@${fix.version}${fix.isSemVerMajor ? ' (breaking)' : ''}`
          : 'no fix available';
    blocking.push(`${name} (${entry.severity}) — ${unexcused.join(', ')}; ${remedy}`);
  }

  return { blocking: blocking.sort(), excepted: excepted.sort() };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[npm-audit-gate] ${error.message}\n`);
    process.exit(2);
  }

  const today = new Date().toISOString().slice(0, 10);
  let exceptions;
  let audit;
  try {
    exceptions = loadExceptions(args.exceptions, today);
    audit = JSON.parse(readFileSync(args.audit, 'utf8'));
  } catch (error) {
    process.stderr.write(`[npm-audit-gate] ${error.message}\n`);
    process.exit(1);
  }

  const { blocking, excepted } = assess(audit, exceptions, args);

  for (const line of excepted) {
    process.stdout.write(`[npm-audit-gate] EXCEPTED ${args.scope}: ${line}\n`);
  }
  if (blocking.length === 0) {
    process.stdout.write(
      `[npm-audit-gate] ${args.scope}: clean at --audit-level=${args.level}` +
        `${excepted.length > 0 ? ` (${excepted.length} reviewed exception(s))` : ''}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `[npm-audit-gate] ${args.scope}: ${blocking.length} advisory/advisories at or above ` +
      `${args.level} with no reviewed exception:\n` +
      blocking.map((line) => `  - ${line}\n`).join('') +
      `\nFix them, or add a dated exception to ${args.exceptions} carrying an owner, ` +
      `a reason, an expiry and a registry finding id.\n`,
  );
  process.exit(1);
}

// The invariant exercises this through the CLI with fixtures rather than by
// importing it, so what CI runs is what the test runs — same argv, same exits.
main();
