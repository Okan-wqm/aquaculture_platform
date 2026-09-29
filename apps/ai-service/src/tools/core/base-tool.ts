import { Logger } from '@nestjs/common';
import { ITool, ToolMetadata, ToolExecutionContext, ToolResult, TenantBoundToolContext } from './tool.interface';
import { TenantBoundaryViolation } from '../../tenant-boundary/tenant-boundary-violation';
import { getToolMetadata } from './tool.decorator';

/**
 * Abstract base class for all tools.
 * Provides common validation, error handling, and timing.
 */
export abstract class BaseTool<TInput = unknown, TOutput = unknown>
  implements ITool<TInput, TOutput>
{
  protected readonly logger: Logger;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  getMetadata(): ToolMetadata {
    const metadata = getToolMetadata(this.constructor);
    if (!metadata) {
      throw new Error(
        `Tool ${this.constructor.name} is missing @Tool() decorator`,
      );
    }
    return metadata;
  }

  async validate(input: TInput): Promise<{ valid: boolean; errors?: string[] }> {
    // Default validation - subclasses can override for custom validation
    if (input === null || input === undefined) {
      return { valid: false, errors: ['Input is required'] };
    }
    return { valid: true };
  }

  async execute(
    input: TInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult<TOutput>> {
    const startTime = Date.now();
    const metadata = this.getMetadata();

    try {
      // Validate input first
      const validation = await this.validate(input);
      if (!validation.valid) {
        return {
          success: false,
          error: `Validation failed: ${validation.errors?.join(', ')}`,
          durationMs: Date.now() - startTime,
          cacheable: false,
        };
      }

      this.logger.debug(
        `Executing tool ${metadata.name} for tenant ${ctx.tenant.tenantId}`,
      );

      // Call the implementation
      const result = await this.run(input, ctx);

      return {
        success: true,
        data: result,
        durationMs: Date.now() - startTime,
        cacheable: this.isCacheable(),
        cacheTtlSeconds: this.getCacheTtl(),
      };
    } catch (error) {
      // K10 (MT-HIGH-062): a tenant-boundary violation is not a tool error the
      // model may retry around — it ends the run. Re-throw past the executor.
      if (error instanceof TenantBoundaryViolation) {
        throw error;
      }
      this.logger.error(
        `Tool ${metadata.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        cacheable: false,
      };
    }
  }

  /**
   * Implement this in each tool - the actual computation. A tool sees only the
   * tenant-bound view of the execution (K10): who it acts for, which tenant
   * binding it carries, and the correlation id — never authorization fields.
   */
  protected abstract run(
    input: TInput,
    ctx: TenantBoundToolContext,
  ): Promise<TOutput>;

  /** Override to enable caching (default: false) */
  protected isCacheable(): boolean {
    return false;
  }

  /** Override to set cache TTL in seconds (default: 300 = 5 min) */
  protected getCacheTtl(): number {
    return 300;
  }
}
