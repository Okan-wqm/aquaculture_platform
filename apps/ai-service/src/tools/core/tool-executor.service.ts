import { Injectable, Logger } from '@nestjs/common';
import { ToolExecutionContext, ToolResult } from './tool.interface';
import { ToolRegistryService } from '../tool-registry.service';
import { AuditService } from '../../audit/audit.service';

/**
 * Central tool execution pipeline:
 * 1. Resolve tool from registry
 * 2. Check permissions (role + module entitlement)
 * 3. Enforce actuation policy — an actuation tool runs autonomously ONLY under
 *    'allowed'; otherwise it is NOT executed (fail-closed)
 * 4. Execute tool
 * 5. Persist to the tool_execution_audit trail (every outcome, incl. denials)
 */
@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly registry: ToolRegistryService,
    private readonly auditService: AuditService,
  ) {}

  async executeTool(
    toolName: string,
    input: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const inputRecord =
      input !== null && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : { value: input };

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
      const denied: ToolResult = {
        success: false,
        error: `Permission denied: requires one of [${metadata.requiredPermissions.join(', ')}]`,
        durationMs: 0,
        cacheable: false,
      };
      await this.audit(toolName, inputRecord, denied, ctx);
      return denied;
    }

    // AISAFETY-MEDIUM-017: actuation policy enforcement (fail-closed).
    // Previously this branch only LOGGED and executed anyway ("assumes
    // confirmation has already been obtained") — nothing obtained it, so an
    // actuation tool ran without confirmation. Now: a tool that requires
    // confirmation executes autonomously ONLY under an 'allowed' policy.
    // 'blocked' denies outright; 'confirm_required' returns a pending result
    // (the tool does NOT run) that the human-in-the-loop flow (Faz 6) resolves.
    if (metadata.requiresConfirmation && ctx.actuationPolicy !== 'allowed') {
      const blocked = ctx.actuationPolicy === 'blocked';
      this.logger.warn(
        `Actuation ${blocked ? 'blocked' : 'held for confirmation'}: ${toolName} ` +
          `(policy=${ctx.actuationPolicy}) by ${ctx.userId} — NOT executed`,
      );
      const pending: ToolResult = {
        success: false,
        requiresConfirmation: !blocked,
        error: blocked
          ? `Tool ${toolName} is blocked by the tenant actuation policy`
          : `Tool ${toolName} requires human confirmation before execution`,
        durationMs: 0,
        cacheable: false,
      };
      await this.audit(toolName, inputRecord, pending, ctx);
      return pending;
    }

    // Execute the tool
    const result = await tool.execute(input, ctx);

    // Persist every execution to the audit trail. Awaited (not fire-and-forget)
    // so a regulated actuation is never reported done before its audit row is
    // durable; AuditService itself swallows storage errors so audit can't break
    // the chat flow.
    await this.audit(toolName, inputRecord, result, ctx);

    return result;
  }

  private async audit(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolExecutionContext,
  ): Promise<void> {
    await this.auditService.logToolExecution(toolName, input, result, ctx);
  }
}
