import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { GqlExecutionContext } from '@nestjs/graphql';
import { withTenantContext } from '@aquaculture/backend-common/context';
import { isValidUUID } from '@aquaculture/backend-common/database';

import { ComplianceAuditService } from '../services/compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

/**
 * Map GraphQL mutation names to compliance audit actions.
 * Only mutations that should be audited are included.
 */
const MUTATION_ACTION_MAP: Record<string, ComplianceAction> = {
  sendMessage: ComplianceAction.MESSAGE_SEND,
  editMessage: ComplianceAction.MESSAGE_EDIT,
  deleteMessage: ComplianceAction.MESSAGE_DELETE,
  createChannel: ComplianceAction.CHANNEL_CREATE,
  archiveChannel: ComplianceAction.CHANNEL_ARCHIVE,
  addMember: ComplianceAction.MEMBER_ADD,
  removeMember: ComplianceAction.MEMBER_REMOVE,
  exportChannelData: ComplianceAction.MESSAGE_EXPORT,
  // Renamed (federation namespace disambiguation per resolver docblock).
  exportTenantMessages: ComplianceAction.MESSAGE_EXPORT,
  anonymizeMyData: ComplianceAction.DATA_ANONYMIZE,
  setRetentionPolicy: ComplianceAction.RETENTION_SET,
  // Legal-hold activation and release are deliberately absent: their command
  // authorities write immutable audit evidence inside the mutation transaction.
};

/**
 * Map GraphQL mutations to their resource type for audit logging.
 */
const MUTATION_RESOURCE_MAP: Record<string, string> = {
  sendMessage: 'message',
  editMessage: 'message',
  deleteMessage: 'message',
  createChannel: 'channel',
  archiveChannel: 'channel',
  addMember: 'channel_member',
  removeMember: 'channel_member',
  exportChannelData: 'channel',
  exportTenantMessages: 'tenant',
  anonymizeMyData: 'user',
  setRetentionPolicy: 'retention_policy',
};

/**
 * NestJS interceptor that wraps all messaging GraphQL mutations
 * and writes audit log entries to the compliance_audit_log table.
 *
 * Non-blocking: audit logging happens in a fire-and-forget fashion
 * after the mutation response is sent, so it never slows down the mutation.
 *
 * @see ADR-012 Phase 3 (Compliance Audit Log)
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(private readonly auditService: ComplianceAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo();

    // Only intercept mutations
    if (info.parentType?.name !== 'Mutation') {
      return next.handle();
    }

    const mutationName = info.fieldName as string;
    const action = MUTATION_ACTION_MAP[mutationName];

    // Skip mutations not in the audit map
    if (!action) {
      return next.handle();
    }

    const req = gqlContext.getContext().req as
      | {
          headers?: Record<string, string | string[] | undefined>;
          tenantId?: string;
          user?: { sub?: string };
        }
      | undefined;

    const tenantId = req?.tenantId ?? 'unknown';
    const userId = req?.user?.sub ?? 'unknown';
    const ipAddress = this.extractIp(req);
    const userAgent = this.extractUserAgent(req);
    const resourceType = MUTATION_RESOURCE_MAP[mutationName] ?? 'unknown';
    const args = gqlContext.getArgs();

    return next.handle().pipe(
      tap({
        next: (result: unknown) => {
          // Fire and forget — do not await
          const resourceId = this.extractResourceId(result, args);
          void this.logWithinTenant(tenantId, {
            tenantId,
            userId,
            action,
            resourceType,
            resourceId,
            details: { mutationName, args: this.sanitizeArgs(args) },
            ipAddress,
            userAgent,
          });
        },
        error: (error: unknown) => {
          // Log failed mutations too
          void this.logWithinTenant(tenantId, {
            tenantId,
            userId,
            action,
            resourceType,
            resourceId: '00000000-0000-0000-0000-000000000000',
            details: {
              mutationName,
              error: error instanceof Error ? error.message : String(error),
              failed: true,
            },
            ipAddress,
            userAgent,
          });
        },
      }),
    );
  }

  private async logWithinTenant(
    tenantId: string,
    entry: Parameters<ComplianceAuditService['log']>[0],
  ): Promise<void> {
    if (!isValidUUID(tenantId)) {
      this.logger.warn(`Skipping audit log for invalid tenantId: ${tenantId}`);
      return;
    }

    await withTenantContext(tenantId, () => this.auditService.log(entry));
  }

  /**
   * Extract the resource ID from the mutation result or args.
   */
  private extractResourceId(result: unknown, args: Record<string, unknown>): string {
    if (result && typeof result === 'object' && 'id' in result) {
      return String((result as { id: unknown }).id);
    }
    // Fall back to common arg names
    for (const key of ['messageId', 'channelId', 'id', 'holdId']) {
      if (typeof args[key] === 'string') {
        return args[key] as string;
      }
      if (args['input'] && typeof args['input'] === 'object') {
        const input = args['input'] as Record<string, unknown>;
        if (typeof input[key] === 'string') {
          return input[key] as string;
        }
      }
    }
    return '00000000-0000-0000-0000-000000000000';
  }

  /**
   * Sanitize mutation args to remove sensitive data before logging.
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      // Strip password fields
      if (key.toLowerCase().includes('password')) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.slice(0, 500) + '...[truncated]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Extract IP address from request, handling X-Forwarded-For and direct connection.
   */
  private extractIp(
    req: { headers?: Record<string, string | string[] | undefined> } | undefined,
  ): string | null {
    if (!req?.headers) return null;
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim() ?? null;
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0]?.split(',')[0]?.trim() ?? null;
    }
    return null;
  }

  /**
   * Extract user agent string from request headers.
   */
  private extractUserAgent(
    req: { headers?: Record<string, string | string[] | undefined> } | undefined,
  ): string | null {
    if (!req?.headers) return null;
    const ua = req.headers['user-agent'];
    if (typeof ua === 'string') return ua.slice(0, 512);
    return null;
  }
}
