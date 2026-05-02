#!/usr/bin/env ts-node
/**
 * tools/gates/check-pin.ts — gate dependency pin verifier.
 *
 * Purpose:
 *   Closes the architectural deficit ORPHAN-012 surfaced. The
 *   `tools/gates/**.ts` scripts (`banned-phrase`, `migration-sql-lint`,
 *   `tier-claim-lint`, `finding-registry`, `commit-msg-validator`) all
 *   compile + run via `ts-node` against `tools/gates/tsconfig.json`.
 *   Their behaviour depends on:
 *
 *     1. WHICH `typescript` compiler resolves at run time (TS 5.x vs
 *        6.x emit different diagnostics for `moduleResolution: "Node"`).
 *     2. WHICH `ts-node` resolves at run time (10.x vs 11.x change
 *        the transpiler entry point).
 *
 *   The architectural fix `docs/reviews/orphan-findings.md` ORPHAN-012
 *   prescribes under `"Real architectural fix"` is exactly this
 *   script: assert at gate-time that the LOCALLY INSTALLED versions
 *   match the pinned constants, and refuse to proceed if they drift.
 *   With the pin, the matching `ignoreDeprecations` value is
 *   deterministic too — no value-bouncing across environments.
 *
 *   Architectural-tier-1 ("make it impossible"): a developer or CI
 *   runner whose `node_modules` resolves a different `typescript` /
 *   `ts-node` cannot run the gates without this check failing first.
 *   Combined with `npm ci` against the locked `package-lock.json`,
 *   the pinning is enforceable end-to-end.
 *
 * Why version-string assertion ONLY (no full compile dry-run):
 *   The gate scripts THEMSELVES compile + run on every commit; if the
 *   tsconfig is broken, those gates fail and the operator sees the
 *   error directly. Repeating a full compile here would double the
 *   pre-commit cost. Version assertion is O(2 file reads) — sub-
 *   millisecond.
 *
 * Exit codes:
 *   0 — versions match the pin; gate suite is OK to run.
 *   1 — typescript or ts-node version drift detected; commit refused.
 *   2 — workspace state broken (missing package.json under
 *       node_modules); commit refused.
 *
 * Usage:
 *   ./node_modules/.bin/ts-node --transpile-only tools/gates/check-pin.ts
 *
 * Wired into `.husky/pre-commit` AS THE FIRST gate (so a drifted env
 * fails before any other gate runs and produces noise) AND into
 * `.github/workflows/quality-gates.yml` (so CI catches the drift on
 * every PR).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageJsonShape {
  version?: string;
}

/**
 * Pinned versions. MUST match the exact strings in the repo root
 * `package.json` `devDependencies` block. Caret/tilde prefixes are
 * forbidden — see the rejection in `assertExactPin` below.
 *
 * To bump:
 *   1. Edit BOTH the constant here AND the `package.json` value.
 *   2. Run `npm install` to refresh the lockfile.
 *   3. Run this script locally to verify the assertion still passes.
 *   4. If `typescript` major bumps, also revisit
 *      `tools/gates/tsconfig.json` for any `ignoreDeprecations`
 *      compatibility (TS 5.x accepts "5.0", TS 6.x accepts "6.0",
 *      TS 7+ TBD per upstream).
 */
const PINNED = {
  typescript: '5.9.3',
  'ts-node': '10.9.2',
} as const;

type PinnedPkg = keyof typeof PINNED;

function readPackageVersion(pkg: PinnedPkg): string {
  const path = resolve(__dirname, '..', '..', 'node_modules', pkg, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(
      `check-pin: cannot read ${path}: ${(err as Error).message}\n` +
        '         Run `npm ci --ignore-scripts` to populate node_modules with strict peer checks.\n',
    );
    process.exit(2);
  }
  let parsed: PackageJsonShape;
  try {
    parsed = JSON.parse(raw) as PackageJsonShape;
  } catch (err) {
    process.stderr.write(
      `check-pin: ${path} is not valid JSON: ${(err as Error).message}\n`,
    );
    process.exit(2);
  }
  if (typeof parsed.version !== 'string') {
    process.stderr.write(
      `check-pin: ${path} has no string \`version\` field\n`,
    );
    process.exit(2);
  }
  return parsed.version;
}

/**
 * Assert that the resolved version matches the pinned literal exactly.
 * No semver-range tolerance — enterprise determinism beats developer
 * convenience here. A loose `^10.9.2` could resolve to 10.9.5 on one
 * machine and 10.9.2 on another, producing different ts-node stack
 * traces on test failures and different cache invalidation behaviour.
 */
function assertExactPin(pkg: PinnedPkg, resolved: string): void {
  const expected = PINNED[pkg];
  if (resolved !== expected) {
    process.stderr.write(
      `check-pin: ${pkg} version drift detected — ` +
        `expected ${expected}, resolved ${resolved}.\n` +
        '         The gate suite + CI assume the pinned compiler.\n' +
        '         Fix: edit `package.json` to pin ' +
        `${pkg} = "${expected}" exactly (no ^/~), then \`npm install\` ` +
        'to refresh package-lock.json.\n',
    );
    process.exit(1);
  }
}

function main(): void {
  for (const pkg of Object.keys(PINNED) as PinnedPkg[]) {
    const resolved = readPackageVersion(pkg);
    assertExactPin(pkg, resolved);
  }
  // Silent on success — pre-commit gates print only on failure to keep
  // the developer's terminal noise-free.
}

main();
