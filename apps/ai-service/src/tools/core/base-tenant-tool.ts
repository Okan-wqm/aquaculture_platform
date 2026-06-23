import { DataSource, QueryRunner } from 'typeorm';
import { BaseTool } from './base-tool';
import { ToolExecutionContext } from './tool.interface';

/**
 * Base class for tools that need database access.
 * Automatically sets PostgreSQL search_path to the tenant's schema before execution
 * using a dedicated QueryRunner so the search_path persists across queries.
 *
 * Subclasses should use `this.queryRunner.manager` instead of `this.dataSource`
 * for all database operations within `run()` to ensure tenant isolation.
 */
export abstract class TenantScopedTool<
  TInput = unknown,
  TOutput = unknown,
> extends BaseTool<TInput, TOutput> {
  /**
   * Active QueryRunner for the current tool execution.
   * Available inside `run()` — use `this.queryRunner.manager` for queries.
   * Null outside of an active `execute()` call.
   */
  protected queryRunner: QueryRunner | null = null;

  constructor(protected readonly dataSource: DataSource) {
    super();
  }

  async execute(
    input: TInput,
    ctx: ToolExecutionContext,
  ): Promise<import('./tool.interface').ToolResult<TOutput>> {
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
      await qr.query(
        `SET search_path TO "${schemaName}", ai, public`,
      );
      this.queryRunner = qr;

      // Delegate to parent execute (which calls this.run())
      return await super.execute(input, ctx);
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
      this.queryRunner = null;
      // Best-effort cleanup: a RESET failure on a connection we are about
      // to release is non-actionable — the connection is discarded back to
      // the pool which resets session state, so swallow rather than mask a
      // primary error already being returned.
      await qr.query('RESET search_path').catch(() => undefined);
      await qr.release();
    }
  }
}
