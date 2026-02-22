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
      // Audit logging should never break the main flow
      this.logger.error(
        `Failed to log audit: ${error instanceof Error ? error.message : String(error)}`,
      );
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
