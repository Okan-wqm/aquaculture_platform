/**
 * Platform-wide invariant — ORPHAN-CRITICAL-063 (migration runner transaction mode):
 *
 * Locks the structural rule that THREE migration runners across the
 * platform — TypeORM's built-in (legacy), the platform per-service
 * `MigrationRunnerService` (mainline), and the centralised db-migrate
 * orchestrator (Phase E) — all honour the same per-migration
 * `transaction = false` opt-out. CONCURRENTLY-scoped DDL (CREATE INDEX
 * CONCURRENTLY, DROP INDEX CONCURRENTLY) cannot run inside any
 * transaction block; Postgres rejects with "cannot run inside a
 * transaction block" no matter how the wrapper opens the tx.
 *
 * # Why this invariant exists
 *
 * Cold-boot crash on the production droplet (2026-05-10) — messaging-
 * service and admin-api-service crash-looped at boot with
 *
 *   ForbiddenTransactionModeOverrideError: Migrations
 *   "AddMessageAttachmentIsDeletedIndex1782800000000" override the
 *   transaction mode, but the global transaction mode is "all"
 *
 * Root-cause was twofold:
 *
 *   1. `createServiceTypeOrmConfig` did not pass `migrationsTransactionMode`
 *      to TypeORM, so the built-in runner used TypeORM's default of
 *      `'all'`. In `'all'` mode any pending migration declaring
 *      `transaction = false` raises `ForbiddenTransactionModeOverrideError`.
 *
 *   2. The per-service `MigrationRunnerService` wrapped EVERY migration
 *      in an unconditional `await queryRunner.startTransaction()` before
 *      `executor.executeMigration()`, ignoring `migration.instance.transaction`.
 *      Migrations declaring `transaction = false` therefore still ran
 *      inside an outer transaction wrapper opened by the runner itself —
 *      Postgres rejected the CONCURRENTLY DDL the moment it landed.
 *
 * PR #245 already fixed leg-3 (the centralised orchestrator); legs 1 and
 * 2 are closed by the commit landing this spec.
 *
 * # What this invariant locks
 *
 *   1. `libs/backend-common/src/database/typeorm-config.factory.ts`
 *      MUST emit `migrationsTransactionMode: 'each'` in the returned
 *      `TypeOrmModuleOptions`. Removing the line re-exposes legacy
 *      services (auth-service literal `migrationsRun: true`;
 *      admin-api / event-store env-default `'true'`; any service whose
 *      env sets `DATABASE_MIGRATIONS_RUN=true`) to TypeORM's unsafe
 *      default of `'all'`.
 *
 *   2. `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
 *      MUST gate the per-migration `startTransaction()` /
 *      `commitTransaction()` / `rollbackTransaction()` calls on
 *      `migration.instance.transaction !== false` (matching the
 *      `useTransaction` token introduced in PR #245's orchestrator
 *      fix). Removing the gate re-exposes every service using the
 *      platform per-service runner to the leg-2 crash class.
 *
 *   3. `apps/db-migrate/src/migration-orchestrator.ts` MUST keep the
 *      same `useTransaction` gate landed by PR #245. The check is the
 *      shared structural rule across all three runners — locking it
 *      here makes the contract greppable at one source.
 *
 * # When this spec fails
 *
 *   - Someone removes / renames `migrationsTransactionMode: 'each'`
 *     in the factory → restore the literal exactly as the runner
 *     contract requires.
 *   - Someone reintroduces an unconditional `await queryRunner.startTransaction()`
 *     before `executor.executeMigration` in either the per-service runner
 *     or the orchestrator → re-add the `useTransaction` gate.
 *
 * # What this invariant does NOT check
 *
 *   - The runtime behaviour (those are integration tests against a real
 *     Postgres). This is a SOURCE-TEXT invariant — fast, deterministic,
 *     and runnable on every CI affected pass without a database.
 *   - That every migration's `transaction = false` declaration is
 *     correct (per-migration review).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const FACTORY_PATH = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/typeorm-config.factory.ts',
);
const RUNNER_PATH = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/migration-runner/migration-runner.service.ts',
);
const ORCHESTRATOR_PATH = resolve(
  REPO_ROOT,
  'apps/db-migrate/src/migration-orchestrator.ts',
);

/**
 * Strip line and block comments from TypeScript source so the regex
 * checks below match only on executable code, not docblocks. Keeps
 * literal references to `migrationsTransactionMode: 'all'` or
 * `await queryRunner.startTransaction()` inside a comment from
 * tripping the invariant.
 *
 * Whitespace is preserved (newlines + spaces of equal length) so line
 * numbers in error reports stay accurate when the regex hits real code
 * further down.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  out = out.replace(/\/\/[^\n]*/g, (line) => line.replace(/./g, ' '));
  return out;
}

describe("INVARIANT (ORPHAN-CRITICAL-063): migration runners share one 'each' transaction-mode contract", () => {
  let factorySrc: string;
  let runnerSrc: string;
  let orchestratorSrc: string;

  beforeAll(() => {
    factorySrc = readFileSync(FACTORY_PATH, 'utf8');
    runnerSrc = readFileSync(RUNNER_PATH, 'utf8');
    orchestratorSrc = readFileSync(ORCHESTRATOR_PATH, 'utf8');
  });

  it("createServiceTypeOrmConfig pins migrationsTransactionMode: 'each'", () => {
    // Strip comments first — the docblock at the top of the factory
    // mentions the rationale in PROSE; the regex must not match a
    // commented `migrationsTransactionMode: 'each'` instead of the
    // executable line.
    const codeOnly = stripComments(factorySrc);
    const match = codeOnly.match(
      /migrationsTransactionMode\s*:\s*['"]each['"]/,
    );
    if (!match) {
      throw new Error(
        `${FACTORY_PATH}: missing \`migrationsTransactionMode: 'each'\` in the factory output. ` +
          'TypeORM\'s built-in runner defaults this to \'all\' when the option is omitted, which raises ' +
          'ForbiddenTransactionModeOverrideError on any migration declaring `transaction = false` ' +
          '(e.g. CREATE INDEX CONCURRENTLY). See docs/reviews/orphan-findings.md#ORPHAN-CRITICAL-063 for ' +
          'the production-droplet cold-boot crash this contract closes.',
      );
    }
  });

  it('createServiceTypeOrmConfig does NOT emit `migrationsTransactionMode: \'all\'` (forbidden)', () => {
    const codeOnly = stripComments(factorySrc);
    const forbidden = codeOnly.match(
      /migrationsTransactionMode\s*:\s*['"]all['"]/,
    );
    if (forbidden) {
      throw new Error(
        `${FACTORY_PATH}: forbidden literal \`migrationsTransactionMode: 'all'\` detected in the factory output. ` +
          '\'all\' mode prohibits per-migration transaction overrides — every CONCURRENTLY-scoped migration ' +
          'crashes at runtime. Use \'each\' so per-migration overrides are honored end-to-end.',
      );
    }
  });

  it("MigrationRunnerService gates the outer transaction wrapper on `migration.instance.transaction !== false`", () => {
    // Source-text invariant: the runner's hot loop MUST consult
    // `migration.instance.transaction` before opening the outer wrapper.
    // The presence of `instance?.transaction !== false` plus a wrapping
    // `if (useTransaction)` block proves the structural gate.
    const codeOnly = stripComments(runnerSrc);

    const instanceCheck = codeOnly.match(
      /\.instance\s*\?\s*\.transaction\s*!==\s*false/,
    );
    if (!instanceCheck) {
      throw new Error(
        `${RUNNER_PATH}: missing \`migration.instance?.transaction !== false\` gate. ` +
          'The runner must consult the per-migration override before opening the outer transaction; ' +
          'unconditional `startTransaction()` re-introduces the CONCURRENTLY-cannot-run-inside-tx crash ' +
          'class. See PR #245 (apps/db-migrate/src/migration-orchestrator.ts) for the canonical pattern.',
      );
    }

    const useTransactionGate = codeOnly.match(
      /if\s*\(\s*useTransaction\s*\)\s*\{[\s\S]*?await\s+queryRunner\.startTransaction\(\)/,
    );
    if (!useTransactionGate) {
      throw new Error(
        `${RUNNER_PATH}: missing \`if (useTransaction) { await queryRunner.startTransaction() }\` gate. ` +
          'The instance-override check must wrap the startTransaction call so transaction = false ' +
          'migrations skip the outer wrapper entirely.',
      );
    }
  });

  it('migration-orchestrator.ts keeps the matching `useTransaction` gate (PR #245 invariant)', () => {
    // Locking this in the same spec makes the three-runner contract
    // greppable at one source. PR #245 introduced the gate; this
    // assertion guards against any future refactor that strips it.
    const codeOnly = stripComments(orchestratorSrc);

    const instanceCheck = codeOnly.match(
      /\.instance\s*\?\s*\.transaction\s*!==\s*false/,
    );
    if (!instanceCheck) {
      throw new Error(
        `${ORCHESTRATOR_PATH}: missing \`migration.instance?.transaction !== false\` gate. ` +
          'PR #245 introduced this gate to honor CONCURRENTLY-scoped DDL opt-outs structurally. ' +
          'Removing it re-exposes every centralised db-migrate run to the same crash class.',
      );
    }

    const useTransactionGate = codeOnly.match(
      /if\s*\(\s*useTransaction\s*\)\s*\{[\s\S]*?await\s+queryRunner\.startTransaction\(\)/,
    );
    if (!useTransactionGate) {
      throw new Error(
        `${ORCHESTRATOR_PATH}: missing \`if (useTransaction) { await queryRunner.startTransaction() }\` gate. ` +
          'The instance-override check must wrap the startTransaction call so transaction = false ' +
          'migrations skip the outer wrapper.',
      );
    }
  });
});
