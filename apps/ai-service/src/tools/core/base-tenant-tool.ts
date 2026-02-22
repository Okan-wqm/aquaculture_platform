import { DataSource } from 'typeorm';
import { BaseTool } from './base-tool';
import { ToolExecutionContext } from './tool.interface';

/**
 * Base class for tools that need database access.
 * Automatically sets PostgreSQL search_path to the tenant's schema before execution.
 */
export abstract class TenantScopedTool<
  TInput = unknown,
  TOutput = unknown,
> extends BaseTool<TInput, TOutput> {
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

    try {
      await this.dataSource.query(
        `SET LOCAL search_path TO "${schemaName}", ai, public`,
      );
    } catch (error) {
      this.logger.error(`Failed to set search_path: ${error}`);
      return {
        success: false,
        error: 'Database schema unavailable',
        durationMs: 0,
        cacheable: false,
      };
    }

    // Delegate to parent execute (which calls this.run())
    return super.execute(input, ctx);
  }
}
