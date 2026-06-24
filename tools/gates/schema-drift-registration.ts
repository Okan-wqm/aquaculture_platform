#!/usr/bin/env ts-node
/**
 * schema-drift-registration — static gate (Wave 4-A.2 Part C).
 * ============================================================================
 *
 * Asserts that every canonical service's `app.module.ts` registers
 * `SchemaDriftModule.forRoot({ serviceName: '<svc>' })`. Without this
 * registration the runtime schema-drift validator never instantiates,
 * and entity↔table drift goes undetected at cold start (the very class
 * of bug that motivated ADR-012).
 *
 * # Why a static gate (and not a runtime test)
 *
 * The runtime validator only catches drift when a service actually boots
 * — it cannot signal `the service forgot to register me`. A grep-based
 * static gate closes the loop: deleting the `SchemaDriftModule.forRoot`
 * call is now visible in CI before merge, not after deploy when the
 * silently disarmed validator stops catching the next drift.
 *
 * # What it checks
 *
 * For each service in `CANONICAL_SERVICES` (mirrors the 14-entry
 * SCHEMA_REGISTRY in apps/db-migrate/src/schema-registry.ts):
 *
 *   1. The `app.module.ts` file imports `SchemaDriftModule` from
 *      `@aquaculture/backend-common` (or its `/database` sub-export).
 *   2. The file calls `SchemaDriftModule.forRoot({ serviceName: '<svc>' })`
 *      with the schema name matching the registry entry.
 *
 * Both checks are AST-grep style — regex over the source — because the
 * import/call shape is canonical across all services and a full TS AST
 * walk is overkill for a pre-commit gate.
 *
 * # Exit codes
 *
 *   0 — every canonical service registers SchemaDriftModule with the
 *       correct schema name.
 *   1 — at least one service is missing the registration or carries the
 *       wrong schema name.
 *   2 — invocation error (a canonical service is missing its
 *       `app.module.ts` file entirely).
 *
 * # Invocation
 *
 *   ts-node tools/gates/schema-drift-registration.ts
 *
 * Pre-commit hook integration: see `.husky/pre-commit` (Wave 4-A.2 added
 * this gate to the pre-commit chain alongside migration-sql-lint).
 */

/* eslint-disable no-console */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// CommonJS resolution — matches the tools/gates/tsconfig.json module=CommonJS
// setting and the sibling main-deletion-witness.ts pattern. Switching to
// ESM `import.meta.url` would force every gate caller to either flip the
// tsconfig or invoke node with `--loader ts-node/esm`, neither of which
// is the current call shape (ts-node --project tools/gates/tsconfig.json).
const REPO_ROOT = resolve(__dirname, '..', '..');

interface CanonicalService {
  /** Service directory name under apps/. */
  readonly app: string;
  /**
   * Set of accepted `serviceName` literals for SchemaDriftModule.forRoot.
   * The serviceName is a log-prefix tag, not load-bearing — different
   * services historically passed the schema name (`'farm'`), the truncated
   * app name (`'event-store'`), or the full app name (`'alert-engine'`).
   * The gate accepts ANY of the documented forms so the architectural
   * concern (registration exists at all) is enforced without re-litigating
   * the per-service log-tag choice every PR.
   */
  readonly acceptedNames: readonly string[];
}

/**
 * The 14 canonical services that own a database schema. Mirrors
 * apps/db-migrate/src/schema-registry.ts SCHEMA_REGISTRY but
 * intentionally duplicates here — this gate must run before the
 * registry compiles, and importing across the workspace boundary
 * would couple a static gate to the build graph.
 *
 * Each `acceptedNames` set is the union of:
 *   - the schema name (matches SCHEMA_REGISTRY),
 *   - the app-dir name (e.g. `auth-service`),
 *   - common short forms (e.g. `auth`, `event-store`).
 * If a service registers with a NAME outside this set, the gate
 * surfaces the drift — the operator either updates the registration to
 * one of the canonical forms or extends `acceptedNames` with PR review.
 */
const CANONICAL_SERVICES: readonly CanonicalService[] = [
  { app: 'auth-service', acceptedNames: ['auth', 'auth-service'] },
  { app: 'farm-service', acceptedNames: ['farm', 'farm-service'] },
  { app: 'sensor-service', acceptedNames: ['sensor', 'sensor-service'] },
  { app: 'hr-service', acceptedNames: ['hr', 'hr-service'] },
  { app: 'messaging-service', acceptedNames: ['messaging', 'messaging-service'] },
  {
    app: 'hydroponics-service',
    acceptedNames: ['hydroponics', 'hydroponics-service'],
  },
  { app: 'alert-engine', acceptedNames: ['alert', 'alert-engine'] },
  { app: 'billing-service', acceptedNames: ['billing', 'billing-service'] },
  {
    app: 'notification-service',
    acceptedNames: ['notification', 'notification-service'],
  },
  { app: 'ai-service', acceptedNames: ['ai', 'ai-service'] },
  {
    app: 'admin-api-service',
    acceptedNames: ['admin', 'admin-api', 'admin-api-service'],
  },
  { app: 'config-service', acceptedNames: ['config', 'config-service'] },
  {
    app: 'observability-service',
    acceptedNames: ['observability', 'observability-service'],
  },
  {
    app: 'event-store-service',
    acceptedNames: ['event_store', 'event-store', 'event-store-service'],
  },
];

interface Violation {
  readonly app: string;
  readonly file: string;
  readonly reason: string;
}

function checkAppModule(svc: CanonicalService): Violation | null {
  const file = `apps/${svc.app}/src/app.module.ts`;
  const abs = resolve(REPO_ROOT, file);
  if (!existsSync(abs)) {
    return {
      app: svc.app,
      file,
      reason: `app.module.ts does not exist`,
    };
  }
  const source = readFileSync(abs, 'utf8');

  // 1. Must import SchemaDriftModule from backend-common (any sub-path).
  const importPattern =
    /import\s+\{[^}]*\bSchemaDriftModule\b[^}]*\}\s+from\s+['"]@aquaculture\/backend-common(?:\/[\w-]+)?['"]/;
  if (!importPattern.test(source)) {
    return {
      app: svc.app,
      file,
      reason:
        'no `import { SchemaDriftModule, ... } from "@aquaculture/backend-common"` ' +
        'found. SchemaDriftModule must be imported and registered for the ' +
        'runtime validator to fire at boot.',
    };
  }

  // 2. Must call SchemaDriftModule.forRoot({ serviceName: '<one-of-accepted>' }).
  // Walk every match of the call site, extract the serviceName literal,
  // and assert membership in svc.acceptedNames.
  const callRe =
    /SchemaDriftModule\.forRoot\s*\(\s*\{[^}]*\bserviceName\s*:\s*['"`]([^'"`]+)['"`][^}]*\}\s*\)/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const serviceName = m[1];
    if (serviceName) found.push(serviceName);
  }
  if (found.length === 0) {
    return {
      app: svc.app,
      file,
      reason:
        'no `SchemaDriftModule.forRoot({ serviceName: ... })` call found. ' +
        'The runtime drift validator only fires when the module is wired ' +
        'into AppModule.imports[] — without this registration, ADR-012 ' +
        'enforcement is silently disarmed.',
    };
  }
  const accepted = new Set(svc.acceptedNames);
  if (!found.some((n) => accepted.has(n))) {
    return {
      app: svc.app,
      file,
      reason:
        `SchemaDriftModule.forRoot({ serviceName: '${found.join("', '")}' }) ` +
        `does not match any accepted literal for ${svc.app}: ` +
        `[${svc.acceptedNames.join(', ')}]. Update the registration to one ` +
        `of the canonical forms, or extend acceptedNames with PR review.`,
    };
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function main(): void {
  const violations: Violation[] = [];
  for (const svc of CANONICAL_SERVICES) {
    const v = checkAppModule(svc);
    if (v) violations.push(v);
  }

  if (violations.length === 0) {
    console.log(
      `schema-drift-registration: PASS — all ${CANONICAL_SERVICES.length} ` +
        `canonical services register SchemaDriftModule with the correct schema name.`,
    );
    return;
  }

  console.error('schema-drift-registration: FAIL');
  console.error('');
  for (const v of violations) {
    console.error(`  ${v.app}  (${v.file})`);
    console.error(`    ${v.reason}`);
    console.error('');
  }
  console.error(
    'Cure: register SchemaDriftModule.forRoot({ serviceName: "<schema>" }) ' +
      'in the app.module.ts imports[] array. Reference the matching schema ' +
      'name from apps/db-migrate/src/schema-registry.ts SCHEMA_REGISTRY.',
  );
  process.exit(violations.length > 0 ? 1 : 2);
}

main();
