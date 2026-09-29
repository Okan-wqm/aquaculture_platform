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

/** The fingerprint of a tool output: what the audit row keeps instead of the payload. */
export interface ToolOutputFingerprint {
  readonly outputSha256: string;
  readonly outputBytes: number;
}

/**
 * sha256 + byte size of a tool output's JSON serialization, or undefined when
 * the tool returned nothing.
 *
 * WHY not the payload (K7 / V-T1b-6): `ai.tool_execution_audit` is ONE table for
 * every tenant. Tool outputs are tenant business data (water quality, finance,
 * fish health); keeping them there would put that data in a cross-tenant table
 * and outside per-tenant GDPR erasure. The fingerprint still proves which
 * output a call produced when an incident needs it.
 */
export function fingerprintToolOutput(data: unknown): ToolOutputFingerprint | undefined {
  if (data === undefined) return undefined;
  const serialized = JSON.stringify(data) ?? 'null';
  return {
    outputSha256: createHash('sha256').update(serialized).digest('hex'),
    outputBytes: Buffer.byteLength(serialized, 'utf8'),
  };
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
      const fingerprint = result.success ? fingerprintToolOutput(result.data) : undefined;
      const audit = this.auditRepo.create({
        tenantId: ctx.tenant.tenantId,
        userId: isUUID(ctx.userId) ? ctx.userId : servicePrincipalUuid(ctx.userId),
        toolName,
        persona: ctx.persona,
        input,
        success: result.success,
        outputSha256: fingerprint?.outputSha256,
        outputBytes: fingerprint?.outputBytes,
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
