/**
 * messaging-service migration runner convergence invariant
 * =========================================================
 *
 * Locks the architectural contract that messaging-service uses ONE migration
 * code path — the platform's `MessagingMigrationRunnerService`
 * (`createMigrationRunnerService('messaging')`) — across both production
 * and E2E. Forbids regression to TypeORM's built-in DataSource-init runner
 * via `migrationsRun: true`.
 *
 * # Why this invariant exists
 *
 * Before this convergence, messaging-service had TWO migration execution
 * paths:
 *
 *   1. Production: `MessagingMigrationRunnerService` provider registered
 *      at `OnApplicationBootstrap`, sets `executor.transaction = 'each'`.
 *      Honours per-migration `transaction = 'none'` opt-outs.
 *
 *   2. E2E (legacy): TypeORM's built-in runner triggered by
 *      `DATABASE_MIGRATIONS_RUN=true` + `migrationsRunFromEnv` returning
 *      `true`. Defaults to `transaction = 'all'` and throws
 *      `ForbiddenTransactionModeOverrideError` on any migration that
 *      declares `transaction = 'none'` (e.g.
 *      `1782800000000-AddMessageAttachmentIsDeletedIndex` which uses
 *      `CREATE INDEX CONCURRENTLY` — Postgres forbids that inside any
 *      transaction block).
 *
 * The dual-path architecture diverged silently the moment the first
 * `transaction: 'none'` migration landed. Convergence is the Tier-1
 * "make it impossible" fix per CLAUDE.md hierarchy: this invariant
 * ensures the two paths cannot drift again.
 *
 * # What this invariant locks
 *
 *   1. `apps/messaging-service/src/app.module.ts` declares the
 *      `MessagingMigrationRunnerService` factory call
 *      (`createMigrationRunnerService('messaging')`).
 *   2. The runner is registered as a provider in the `providers: [...]`
 *      array.
 *   3. The TypeORM factory does NOT use `migrationsRun: true` (literal
 *      static-true form). Use `migrationsRunFromEnv` so the env-aware
 *      switch can keep the runner as the SSoT in both prod and E2E.
 *   4. The E2E workflow (`.github/workflows/e2e-messaging.yml`) sets
 *      `DATABASE_MIGRATIONS_RUN: 'false'` so `migrationsRunFromEnv`
 *      evaluates to false and the custom runner owns migration execution.
 *
 * # When this spec fails
 *
 *   - Someone removes `createMigrationRunnerService('messaging')` from
 *     app.module.ts → restore the factory call + the provider entry.
 *   - Someone replaces `migrationsRunFromEnv` with literal
 *     `migrationsRun: true` → revert; the literal form bypasses the env
 *     switch and brings back TypeORM's built-in runner.
 *   - Someone flips `DATABASE_MIGRATIONS_RUN: 'true'` in the workflow →
 *     revert; that re-activates the dual-runner architecture and
 *     re-introduces ForbiddenTransactionModeOverrideError on
 *     `transaction = 'none'` migrations.
 *
 * # What this invariant does NOT check
 *
 *   - Whether each migration declares the correct `transaction` mode —
 *     that's per-migration review.
 *   - Whether the runner provider order in the array is correct (the
 *     ordering must place the runner BEFORE
 *     `SourceSchemaBootstrapService` so migrations finish before the
 *     bootstrap hook fires). The order check would require parsing the
 *     provider array; it is enforced today by review and by the
 *     SourceSchemaBootstrapService's own hard-fail on empty schema.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const APP_MODULE_PATH = resolve(
  REPO_ROOT,
  'apps/messaging-service/src/app.module.ts',
);
const E2E_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  '.github/workflows/e2e-messaging.yml',
);

/**
 * Strip line and block comments from TypeScript source so the regex
 * checks below match only on executable code, not docblocks. Keeps
 * a literal `migrationsRun: true` reference inside a comment from
 * tripping the invariant.
 *
 * The replacement preserves whitespace (newlines + spaces of equal
 * length) so line numbers in error reports stay accurate when the
 * regex hits real code further down.
 */
function stripComments(src: string): string {
  // Block comments: /* ... */ (non-greedy, dotAll).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, ' '),
  );
  // Line comments: // to end-of-line.
  out = out.replace(/\/\/[^\n]*/g, (line) => line.replace(/./g, ' '));
  return out;
}

describe('INVARIANT (e2e-messaging convergence): messaging-service uses MessagingMigrationRunnerService as the SSoT', () => {
  let appModuleSrc: string;
  let workflowSrc: string;

  beforeAll(() => {
    appModuleSrc = readFileSync(APP_MODULE_PATH, 'utf8');
    workflowSrc = readFileSync(E2E_WORKFLOW_PATH, 'utf8');
  });

  it('app.module.ts calls createMigrationRunnerService(\'messaging\') or createSchemaVersionGate(\'messaging\')', () => {
    // Faz 1.5 of the day-one baseline reset migrated the per-service
    // factory from `createMigrationRunnerService` to the read-only
    // `createSchemaVersionGate` (ADR-021). Both satisfy the SSoT
    // contract: gate-mode wraps the legacy runner verbatim when
    // DB_MIGRATE_AUTHORITATIVE is unset, and runs the production-side
    // ledger probe when it is set. The spec accepts either factory name.
    const legacyFactoryRe = /createMigrationRunnerService\(\s*['"]messaging['"]\s*\)/;
    const gateFactoryRe = /createSchemaVersionGate\(\s*['"]messaging['"]\s*\)/;
    if (!legacyFactoryRe.test(appModuleSrc) && !gateFactoryRe.test(appModuleSrc)) {
      throw new Error(
        `${APP_MODULE_PATH}: missing both \`createMigrationRunnerService('messaging')\` ` +
          `AND \`createSchemaVersionGate('messaging')\` factory calls. ` +
          'The messaging-service migration runner / gate is the SSoT for messaging schema migrations ' +
          '— removing both brings back TypeORM\'s built-in runner which crashes on `transaction = \'none\'` migrations ' +
          '(ForbiddenTransactionModeOverrideError).',
      );
    }
  });

  it('app.module.ts registers MessagingMigrationRunnerService as a provider', () => {
    // The factory result is captured into a local const named
    // `MessagingMigrationRunnerService` (top-of-file convention) and the
    // provider array entry references that identifier. Both forms
    // (`MessagingMigrationRunnerService` standalone, or wrapped in
    // `{ provide: ... }`) satisfy the contract — what matters is that
    // the identifier appears inside the `providers: [...]` block.
    const providersMatch = appModuleSrc.match(/providers:\s*\[([\s\S]*?)\][\s,]*}\s*\)/);
    if (!providersMatch || !providersMatch[1]) {
      throw new Error(
        `${APP_MODULE_PATH}: could not locate the \`providers: [...]\` array in @Module(). ` +
          'Either the file shape changed (update this invariant) or the file is unreadable.',
      );
    }
    const providersBody = providersMatch[1];
    if (!/\bMessagingMigrationRunnerService\b/.test(providersBody)) {
      throw new Error(
        `${APP_MODULE_PATH}: \`MessagingMigrationRunnerService\` is not registered in the providers array. ` +
          'Without the provider entry, the OnApplicationBootstrap hook never fires and migrations never apply ' +
          'in any environment that relies on the custom runner (E2E + production).',
      );
    }
  });

  it('app.module.ts does NOT use literal `migrationsRun: true` (which would re-activate TypeORM\'s built-in runner)', () => {
    // The literal static-true form bypasses migrationsRunFromEnv and
    // forfeits the env-aware switch that lets the custom runner own
    // migration execution. The legacy contract (auth-service) uses this
    // form, but messaging-service must NOT — it has a custom runner.
    //
    // Strip comments first — the docblock at the top of app.module.ts
    // mentions `migrationsRun: true` in PROSE describing what the
    // custom runner replaces; the regex must not flag that.
    const codeOnly = stripComments(appModuleSrc);
    const literalTrueMatch = codeOnly.match(/migrationsRun\s*:\s*true\b/);
    if (literalTrueMatch) {
      throw new Error(
        `${APP_MODULE_PATH}: forbidden literal \`migrationsRun: true\` detected. ` +
          'messaging-service uses MessagingMigrationRunnerService — set `migrationsRunFromEnv: cs => cs.get(\'DATABASE_MIGRATIONS_RUN\') === \'true\'` ' +
          'and leave DATABASE_MIGRATIONS_RUN=false in E2E so the custom runner owns migration execution.',
      );
    }
  });

  it('e2e-messaging workflow sets DATABASE_MIGRATIONS_RUN=false (custom runner is the SSoT in CI)', () => {
    // The E2E workflow MUST set DATABASE_MIGRATIONS_RUN=false to keep
    // migrationsRunFromEnv returning false → TypeORM does not run
    // migrations at DataSource init → MessagingMigrationRunnerService
    // applies them at OnApplicationBootstrap with transaction='each'.
    //
    // If DATABASE_MIGRATIONS_RUN=true reappears here, the dual-runner
    // architecture returns and the next `transaction = 'none'` migration
    // crashes E2E with ForbiddenTransactionModeOverrideError.
    const trueMatch = workflowSrc.match(/DATABASE_MIGRATIONS_RUN:\s*['"]?true['"]?/);
    if (trueMatch) {
      throw new Error(
        `${E2E_WORKFLOW_PATH}: forbidden \`DATABASE_MIGRATIONS_RUN: 'true'\` detected in E2E workflow env. ` +
          'Setting it to true re-activates TypeORM\'s built-in runner (transaction=\'all\' default), which crashes ' +
          'on `transaction = \'none\'` migrations like CREATE INDEX CONCURRENTLY. Set it to \'false\' so ' +
          'MessagingMigrationRunnerService owns migration execution in CI just like in production.',
      );
    }
    const falseMatch = workflowSrc.match(/DATABASE_MIGRATIONS_RUN:\s*['"]?false['"]?/);
    if (!falseMatch) {
      throw new Error(
        `${E2E_WORKFLOW_PATH}: missing \`DATABASE_MIGRATIONS_RUN: 'false'\` in E2E workflow env. ` +
          'Without an explicit setting, the env may be inherited from a default that flips the convergence contract.',
      );
    }
  });
});
