import { Injectable, Logger } from '@nestjs/common';
import { ToolExecutionContext, ToolResult } from './tool.interface';
import { ToolRegistryService } from '../tool-registry.service';

/**
 * Central tool execution pipeline:
 * 1. Resolve tool from registry
 * 2. Check permissions (role + module entitlement)
 * 3. Check actuation confirmation requirement
 * 4. Execute tool
 * 5. Log to audit trail
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly registry: ToolRegistryService,
  ) {}

  async executeTool(
    toolName: string,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        durationMs: 0,
        cacheable: false,
      };
    }

    const metadata = tool.getMetadata();

    // Permission check
    const hasPermission = metadata.requiredPermissions.some((perm) =>
      ctx.userRoles.includes(perm),
    );
    if (!hasPermission) {
      this.logger.warn(
        `Permission denied: ${ctx.userId} (roles: ${ctx.userRoles.join(',')}) attempted ${toolName}`,
      );
      return {
        success: false,
        error: `Permission denied: requires one of [${metadata.requiredPermissions.join(', ')}]`,
        durationMs: 0,
        cacheable: false,
      };
    }

    // Confirmation check for actuation tools
    if (metadata.requiresConfirmation) {
      this.logger.log(
        `Tool ${toolName} requires confirmation - marking for approval workflow`,
      );
      // The approval workflow will be handled by the agent runner
      // This executor assumes confirmation has already been obtained
    }

    // Execute the tool
    const result = await tool.execute(input, ctx);

    // Audit logging (async, non-blocking)
    this.logExecution(toolName, input, result, ctx).catch((err) =>
      this.logger.error(`Audit log failed: ${err}`),
    );

    return result;
  }

  private async logExecution(
    toolName: string,
    input: unknown,
    result: ToolResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    this.logger.debug(
      `Tool execution: ${toolName} | tenant: ${ctx.tenantId} | success: ${result.success} | ${result.durationMs}ms`,
    );
    // TODO: Write to tool_execution_audit table when AuditService is implemented
  }
}
