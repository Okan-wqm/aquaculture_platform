import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolExecutionAudit } from './tool-execution-audit.entity';
import { ToolExecutionContext, ToolResult } from '../tools/core/tool.interface';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(ToolExecutionAudit)
    private readonly auditRepo: Repository<ToolExecutionAudit>,
  ) {}

  async logToolExecution(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolExecutionContext,
    conversationId?: string,
    strict = false,
  ): Promise<void> {
    try {
      const audit = this.auditRepo.create({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        toolName,
        persona: ctx.persona,
        input,
        success: result.success,
        output: result.success ? (result.data as Record<string, unknown>) : undefined,
        errorMessage: result.error,
        durationMs: result.durationMs,
        correlationId: ctx.correlationId,
        conversationId,
      });
      await this.auditRepo.save(audit);
    } catch (error) {
      // DB-PEOPLE-MEDIUM-003: for read-only tools the audit is best-effort — a
      // broken write must never break the chat flow. For actuation-class tools
      // the caller passes strict=true: the row is safety-load-bearing, so we
      // re-throw instead of swallowing and let the executor surface the gap.
      this.logger.error(
        `Failed to log audit: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (strict) {
        throw error;
      }
    }
  }

  async getRecentExecutions(
    tenantId: string,
    limit = 50,
  ): Promise<ToolExecutionAudit[]> {
    return this.auditRepo.find({
      where: { tenantId },
      order: { executedAt: 'DESC' },
      take: limit,
    });
  }
}
