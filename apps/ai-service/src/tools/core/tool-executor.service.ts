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
      const unknown: ToolResult = {
        success: false,
        error: `Unknown tool: ${toolName}`,
        durationMs: 0,
        cacheable: false,
      };
      // Audit unknown-tool attempts too — an LLM probing tool names should
      // leave a trail rather than vanish.
      await this.audit(toolName, inputRecord, unknown, ctx);
      return unknown;
    }

    const metadata = tool.getMetadata();

    // SENSOR-MEDIUM-070: a first-class internal service principal is authorized
    // for exactly the tools it declares in `grantedToolNames` — no user-role
    // fabrication. Read-only by construction: an actuation tool (requires
    // confirmation) is refused even when granted, so a service principal can
    // never actuate. A human request has no servicePrincipal and falls through
    // to the user-RBAC check below unchanged.
    const serviceGrant = ctx.servicePrincipal?.grantedToolNames.includes(toolName) ?? false;
    if (serviceGrant && metadata.requiresConfirmation) {
      this.logger.warn(
        `Service principal ${ctx.servicePrincipal?.name} denied actuation tool ${toolName} — ` +
          `service principals are read-only by construction`,
      );
      const denied: ToolResult = {
        success: false,
        error: `Service principals may not run actuation tool ${toolName}`,
        durationMs: 0,
        cacheable: false,
      };
      await this.audit(toolName, inputRecord, denied, ctx);
      return denied;
    }

    // Permission check
    const hasPermission =
      serviceGrant ||
      metadata.requiredPermissions.some((perm) => ctx.userRoles.includes(perm));
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

    // Persist every execution to the audit trail (DB-PEOPLE-MEDIUM-003).
    // Read-only tools: best-effort — a broken audit write must never break the
    // chat flow. Actuation-class tools (requiresConfirmation): the row is
    // safety-load-bearing, so we write it STRICTLY and, on failure, SURFACE the
    // gap (auditFailed flag + CRITICAL log) instead of swallowing it silently.
    // We surface-and-continue rather than refuse post-hoc: the actuation has
    // already run, so returning a false failure would risk a double-actuation.
    if (metadata.requiresConfirmation) {
      try {
        await this.auditService.logToolExecution(toolName, inputRecord, result, ctx, undefined, true);
      } catch (auditError) {
        this.logger.error(
          `AUDIT GAP (actuation): ${toolName} executed but its audit write failed — ` +
            `${auditError instanceof Error ? auditError.message : String(auditError)}`,
        );
        return { ...result, auditFailed: true };
      }
    } else {
      await this.audit(toolName, inputRecord, result, ctx);
    }

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
