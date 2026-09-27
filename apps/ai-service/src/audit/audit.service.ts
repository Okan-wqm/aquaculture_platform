import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolExecutionAudit } from './tool-execution-audit.entity';
import { ToolExecutionContext, ToolResult } from '../tools/core/tool.interface';
import { createHash } from 'crypto';

/**
 * FARM-AI-0.1: tool_execution_audit.userId is uuid NOT NULL — service principal
 * identities like 'service:sensor-service' are INVALID uuids and the audit INSERT
 * silently fails (best-effort catch). This helper derives a deterministic UUIDv5
 * from the service name so service-principal tool runs get durable audit rows.
 */
export function servicePrincipalUuid(serviceName: string): string {
  const namespace = createHash('sha256')
    .update('aqua-ai-service-principal-uuid-v1')
    .digest()
    .subarray(0, 16);
  const hash = createHash('sha1').update(namespace).update(serviceName).digest().subarray(0, 16);
  // Set UUID v5 bits (version 5, variant 1). A SHA-1 digest is 20 bytes, so
  // the 16-byte view always has bytes 6 and 8; read them through the typed
  // array's own bounds rather than asserting.
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
        userId: isUUID(ctx.userId) ? ctx.userId : servicePrincipalUuid(ctx.userId),
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

  async getRecentExecutions(tenantId: string, limit = 50): Promise<ToolExecutionAudit[]> {
    return this.auditRepo.find({
      where: { tenantId },
      order: { executedAt: 'DESC' },
      take: limit,
    });
  }
}
