/**
 * CLI argument parser for `aqua-db-migrate`.
 *
 * Extracted from `main.ts` so the parser is importable from tests
 * without running the full entrypoint (which blocks on DB connect
 * at import time). The module has zero side-effects — pure
 * functions over argv.
 */

/**
 * CLI argument shape for migration, tenant provisioner and rollback
 * authority paths. When `down` is undefined and no mode is selected, the
 * caller wants the default up-all behaviour.
 *
 * Intentionally narrow — this CLI is operator-facing during deploy
 * recovery, not a general-purpose interface. Provisioner and rollback modes
 * are explicit subcommands; invalid cross-mode combinations are rejected up
 * front.
 */
export interface ParsedArgs {
  /**
   * Present when the caller wants the db-migrate tenant schema worker rather
   * than release-wide source/tenant migration fan-out.
   */
  mode?: 'migrate' | 'tenant-schema-provisioner' | 'tenant-schema-rollback';
  /**
   * Tenant provisioner run mode. `once` claims at most one job and exits;
   * `loop` keeps polling until the process is stopped.
   */
  provisionerRunMode?: 'once' | 'loop';
  /**
   * Tenant rollback fan-out scope for the db-migrate-owned rollback command.
   * The legacy `--down N --schema <source>` form still rolls back every tenant
   * schema for tenant-aware sources.
   */
  tenantRollbackTarget?: 'all' | 'tenant';
  tenantRollbackTenant?: string;
  /**
   * Present when the caller passed `--down N`. Integer ≥ 1 —
   * number of migrations to undo from the HEAD of the target
   * schema's applied history, newest-first.
   */
  down?: number;
  /**
   * Present when the caller passed `--schema <name>`. Required
   * when `down` is present so the rollback targets exactly one
   * schema registry entry (blast-radius containment).
   */
  schema?: string;
}

/**
 * Parse argv for db-migrate operational modes. Rejects invalid combinations
 * at the CLI boundary so the operator sees a clear error instead
 * of an unhelpful downstream failure.
 *
 * Accepted forms:
 *   (no flags)                                           — up all (default)
 *   tenant-schema-provisioner [--once|--loop]             — claim provisioner jobs
 *   --down N --schema <name>                             — roll back source + all tenants
 *   tenant-schema-rollback --all --down N --schema <name> — explicit all-tenant rollback
 *   tenant-schema-rollback --tenant T --down N --schema S — one-tenant rollback
 *
 * Anything else (bare `--down N`, `--schema` without `--down`,
 * invalid N, unknown flags, mixed modes) throws — the caller surfaces the
 * message + exits 2.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === 'tenant-schema-provisioner') {
      if (args.down !== undefined || args.schema !== undefined) {
        throw new Error(
          '[db-migrate] tenant-schema-provisioner cannot be combined with rollback flags.',
        );
      }
      args.mode = 'tenant-schema-provisioner';
    } else if (flag === 'tenant-schema-rollback') {
      if (args.mode !== undefined) {
        throw new Error('[db-migrate] tenant-schema-rollback cannot be combined with another mode.');
      }
      args.mode = 'tenant-schema-rollback';
    } else if (flag === '--once') {
      if (args.provisionerRunMode !== undefined && args.provisionerRunMode !== 'once') {
        throw new Error('[db-migrate] tenant-schema-provisioner accepts only one of --once or --loop.');
      }
      args.provisionerRunMode = 'once';
    } else if (flag === '--loop') {
      if (args.provisionerRunMode !== undefined && args.provisionerRunMode !== 'loop') {
        throw new Error('[db-migrate] tenant-schema-provisioner accepts only one of --once or --loop.');
      }
      args.provisionerRunMode = 'loop';
    } else if (flag === '--all') {
      if (args.mode !== 'tenant-schema-rollback') {
        throw new Error('[db-migrate] --all is only accepted after tenant-schema-rollback.');
      }
      if (args.tenantRollbackTarget === 'tenant') {
        throw new Error('[db-migrate] tenant-schema-rollback accepts only one of --tenant or --all.');
      }
      args.tenantRollbackTarget = 'all';
    } else if (flag === '--tenant') {
      if (args.mode !== 'tenant-schema-rollback') {
        throw new Error('[db-migrate] --tenant is only accepted after tenant-schema-rollback.');
      }
      if (args.tenantRollbackTarget === 'all') {
        throw new Error('[db-migrate] tenant-schema-rollback accepts only one of --tenant or --all.');
      }
      // PR#363 port: duplicate value-flags must fail loud — silently
      // letting the LAST occurrence win hides operator typos on a
      // rollback CLI where the wrong target is a data-loss event.
      if (args.tenantRollbackTenant !== undefined) {
        throw new Error('[db-migrate] Duplicate CLI flag: --tenant');
      }
      const raw = argv[i + 1];
      // PR#363 port: a `--`-prefixed lookahead means the VALUE is missing
      // and the next flag would be swallowed as the value.
      if (raw === undefined || raw.length === 0 || raw.startsWith('--')) {
        throw new Error('[db-migrate] --tenant requires a tenant id or tenant schema name.');
      }
      args.tenantRollbackTarget = 'tenant';
      args.tenantRollbackTenant = raw;
      i += 1;
    } else if (flag === '--down') {
      if (args.mode === 'tenant-schema-provisioner') {
        throw new Error(
          '[db-migrate] tenant-schema-provisioner cannot be combined with rollback flags.',
        );
      }
      if (args.down !== undefined) {
        throw new Error('[db-migrate] Duplicate CLI flag: --down');
      }
      const raw = argv[i + 1];
      if (raw === undefined || raw.startsWith('--')) {
        throw new Error(
          '[db-migrate] --down requires an integer argument: --down <N>',
        );
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || !/^\d+$/.test(raw)) {
        throw new Error(
          `[db-migrate] --down argument must be a positive integer; got "${raw}".`,
        );
      }
      args.down = parsed;
      i += 1;
    } else if (flag === '--schema') {
      if (args.mode === 'tenant-schema-provisioner') {
        throw new Error(
          '[db-migrate] tenant-schema-provisioner cannot be combined with rollback flags.',
        );
      }
      if (args.schema !== undefined) {
        throw new Error('[db-migrate] Duplicate CLI flag: --schema');
      }
      const raw = argv[i + 1];
      if (raw === undefined || raw.length === 0 || raw.startsWith('--')) {
        throw new Error(
          '[db-migrate] --schema requires a schema name: --schema <name>',
        );
      }
      args.schema = raw;
      i += 1;
    } else if (flag !== undefined && flag.startsWith('--')) {
      throw new Error(`[db-migrate] Unknown CLI flag: ${flag}`);
    } else if (flag !== undefined) {
      // PR#363 port: an unknown positional was previously IGNORED — a
      // typo'd subcommand (`tenant-schema-provisioneer`) silently fell
      // through to the default up-all migration run. Operator CLIs fail
      // loud at the boundary.
      throw new Error(`[db-migrate] Unexpected positional argument: ${flag}`);
    }
  }
  if (args.down !== undefined && args.schema === undefined) {
    throw new Error(
      '[db-migrate] --down N requires --schema <name> — rollback must target ' +
        'exactly one schema to contain blast radius.',
    );
  }
  if (args.down === undefined && args.schema !== undefined) {
    throw new Error(
      '[db-migrate] --schema is only accepted alongside --down.',
    );
  }
  if (args.mode !== 'tenant-schema-provisioner' && args.provisionerRunMode !== undefined) {
    throw new Error(
      '[db-migrate] --once/--loop are only accepted after tenant-schema-provisioner.',
    );
  }
  if (args.mode === 'tenant-schema-provisioner' && args.provisionerRunMode === undefined) {
    args.provisionerRunMode = 'once';
  }
  if (args.mode === 'tenant-schema-rollback') {
    if (args.down === undefined || args.schema === undefined) {
      throw new Error(
        '[db-migrate] tenant-schema-rollback requires --schema <source> --down <N> plus --tenant <id> or --all.',
      );
    }
    if (args.tenantRollbackTarget === undefined) {
      throw new Error('[db-migrate] tenant-schema-rollback requires --tenant <id> or --all.');
    }
  } else if (args.tenantRollbackTarget !== undefined || args.tenantRollbackTenant !== undefined) {
    throw new Error('[db-migrate] tenant rollback scope is only accepted after tenant-schema-rollback.');
  }
  return args;
}
