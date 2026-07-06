import { AsyncLocalStorage } from 'async_hooks';
import { DataSource, QueryRunner } from 'typeorm';
import { BaseTool } from './base-tool';
import { ToolExecutionContext, ToolResult } from './tool.interface';

/**
 * Base class for tools that need tenant-scoped database access.
 * Sets the PostgreSQL search_path to the tenant's schema on a dedicated
 * QueryRunner so it persists across queries within one execution.
 *
 * Subclasses use `this.queryRunner.manager` for all DB operations inside `run()`.
 *
 * AISAFETY-LOW-018: the active QueryRunner is held in AsyncLocalStorage, NOT on
 * the instance. Tools are NestJS singletons, so a mutable `this.queryRunner`
 * field raced across concurrent executions — request A could observe request B's
 * runner (and thus B's tenant search_path), a cross-tenant data leak. ALS binds
 * the runner to a single async execution, so concurrent calls on the shared
 * instance can never see each other's runner.
 */
export abstract class TenantScopedTool<
  TInput = unknown,
  TOutput = unknown,
> extends BaseTool<TInput, TOutput> {
  private readonly qrStore = new AsyncLocalStorage<QueryRunner>();

  constructor(protected readonly dataSource: DataSource) {
    super();
  }

  /**
   * The QueryRunner for the CURRENT execution (race-safe, per-async-context).
   * Use `this.queryRunner.manager` for queries inside `run()`. Throws if read
   * outside an active `execute()` — there is no ambient runner to leak.
   */
  protected get queryRunner(): QueryRunner {
    const qr = this.qrStore.getStore();
    if (!qr) {
      throw new Error(
        'queryRunner is only available inside run() during an active execute()',
      );
    }
    return qr;
  }

  async execute(
    input: TInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult<TOutput>> {
    // Set search_path for this tool execution
    const schemaName = ctx.schemaName;
    if (!/^[a-z0-9_]+$/.test(schemaName)) {
      return {
        success: false,
        error: 'Invalid schema name',
        durationMs: 0,
        cacheable: false,
      };
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    try {
      await qr.query(`SET search_path TO "${schemaName}", ai, public`);

      // Race-safe: the runner is visible ONLY within this async execution,
      // so `this.queryRunner` inside run() always resolves to THIS call's qr —
      // never a concurrent call's on the shared singleton.
      return await this.qrStore.run(qr, () => super.execute(input, ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to set search_path: ${message}`);
      return {
        success: false,
        error: 'Database schema unavailable',
        durationMs: 0,
        cacheable: false,
      };
    } finally {
      // Best-effort cleanup: a RESET failure on a connection we are about to
      // release is non-actionable — the pool resets session state on release.
      await qr.query('RESET search_path').catch(() => undefined);
      await qr.release();
    }
  }
}
