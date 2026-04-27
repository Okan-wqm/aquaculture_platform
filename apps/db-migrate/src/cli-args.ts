/**
 * CLI argument parser for `aqua-db-migrate`.
 *
 * Extracted from `main.ts` so the parser is importable from tests
 * without running the full entrypoint (which blocks on DB connect
 * at import time). The module has zero side-effects — pure
 * functions over argv.
 */

/**
 * CLI argument shape for the `--down N --schema <name>` rollback
 * path (ORPHAN-020). When `down` is undefined the caller wants the
 * default up-all behaviour.
 *
 * Intentionally narrow — this CLI is operator-facing during deploy
 * recovery, not a general-purpose interface. Only one action flag
 * (`--down`) is supported; any attempt to combine it with other
 * modes is rejected up front.
 */
export interface ParsedArgs {
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
 * Parse argv for the rollback flags. Rejects invalid combinations
 * at the CLI boundary so the operator sees a clear error instead
 * of an unhelpful downstream failure.
 *
 * Accepted forms:
 *   (no flags)                           — up all (default)
 *   --down N --schema <name>             — roll back N migrations on ONE schema
 *
 * Anything else (bare `--down N`, `--schema` without `--down`,
 * invalid N, unknown flags) throws — the caller surfaces the
 * message + exits 2.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--down') {
      const raw = argv[i + 1];
      if (raw === undefined) {
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
      const raw = argv[i + 1];
      if (raw === undefined || raw.length === 0) {
        throw new Error(
          '[db-migrate] --schema requires a schema name: --schema <name>',
        );
      }
      args.schema = raw;
      i += 1;
    } else if (flag !== undefined && flag.startsWith('--')) {
      throw new Error(`[db-migrate] Unknown CLI flag: ${flag}`);
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
  return args;
}
