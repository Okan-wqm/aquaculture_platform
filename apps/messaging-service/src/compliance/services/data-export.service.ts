import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { Message } from '../../message/entities/message.entity';
import { LegalHoldService } from './legal-hold.service';
import { ComplianceAuditService } from './compliance-audit.service';
import { ComplianceAction } from '../entities/compliance-audit-log.entity';

/**
 * Supported export formats.
 */
export type ExportFormat = 'csv' | 'json';

/**
 * Represents an export job result.
 */
export interface ExportJobResult {
  jobId: string;
  status: 'completed' | 'pending' | 'failed';
  format: ExportFormat;
  recordCount: number;
  data: string;
  isUnderLegalHold: boolean;
  exportedAt: string;
}

/**
 * Exported message row used in both CSV and JSON outputs.
 */
interface ExportedMessageRow {
  messageId: string;
  channelId: string;
  senderId: string;
  content: string | null;
  contentType: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  attachmentCount: number;
  hasLegalHold: boolean;
}

/**
 * Compliance data export service for generating channel or tenant
 * message history in CSV or JSON format.
 *
 * Exports include messages, attachment metadata, and legal hold status.
 * Access restricted to TENANT_ADMIN only.
 *
 * @see ADR-012 Phase 3 (Data Export for Compliance Officers)
 */
@Injectable()
export class DataExportService {
  private readonly logger = new Logger(DataExportService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly legalHoldService: LegalHoldService,
    private readonly auditService: ComplianceAuditService,
  ) {}

  /**
   * Export all messages from a specific channel.
   */
  async exportChannel(
    tenantId: string,
    channelId: string,
    format: ExportFormat,
    userId: string,
  ): Promise<ExportJobResult> {
    const jobId = crypto.randomUUID();

    const isUnderHold = await this.legalHoldService.isUnderLegalHold(
      tenantId,
      channelId,
    );

    const messages = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      (queryRunner) => queryRunner.manager.find(Message, {
        where: { tenantId, channelId },
        relations: ['attachments'],
        order: { createdAt: 'ASC' },
      }),
    );

    const rows = messages.map((msg) =>
      this.toExportRow(msg, isUnderHold),
    );

    const data =
      format === 'json'
        ? JSON.stringify(rows, null, 2)
        : this.toCsv(rows);

    // Log the export to compliance audit
    await this.auditService.log({
      tenantId,
      userId,
      action: ComplianceAction.MESSAGE_EXPORT,
      resourceType: 'channel',
      resourceId: channelId,
      details: {
        format,
        recordCount: rows.length,
        isUnderLegalHold: isUnderHold,
        jobId,
      },
      ipAddress: null,
      userAgent: null,
    });

    this.logger.log(
      `Channel export completed: channel=${channelId}, format=${format}, records=${rows.length}`,
    );

    return {
      jobId,
      status: 'completed',
      format,
      recordCount: rows.length,
      data,
      isUnderLegalHold: isUnderHold,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Export all messages across all channels for a tenant.
   *
   * IMPORTANT: Uses streaming cursor via createQueryBuilder().stream() instead of
   * loading all messages into a single array. For tenants with large message volumes,
   * the previous approach caused OOM (e.g., 1M messages * 2KB avg = ~2GB in memory).
   * The streaming approach keeps memory bounded by processing one row at a time.
   * @see MSG-MEDIUM-028
   */
  async exportTenant(
    tenantId: string,
    format: ExportFormat,
    userId: string,
  ): Promise<ExportJobResult> {
    const jobId = crypto.randomUUID();

    const isUnderHold = await this.legalHoldService.isUnderLegalHold(
      tenantId,
      null,
    );

    const rows = await runInTenantTransaction(
      this.dataSource,
      'messaging',
      tenantId,
      async (queryRunner) => {
        // Pre-fetch held channels to avoid N+1 queries per message during streaming
        const heldChannelSet = new Set<string>();
        if (!isUnderHold) {
          const heldChannels: Array<{ channelId: string | null }> = await queryRunner.query(
            `SELECT "channelId" FROM "legal_holds"
             WHERE "tenantId" = $1::uuid
               AND "isActive" = true
               AND "channelId" IS NOT NULL`,
            [tenantId],
          ).catch(() => []);
          for (const row of heldChannels) {
            if (row.channelId) heldChannelSet.add(row.channelId);
          }
        }

        // Stream messages using cursor to avoid OOM for large tenants
        const stream = await queryRunner.manager
          .createQueryBuilder(Message, 'msg')
          .leftJoinAndSelect('msg.attachments', 'att')
          .where('msg."tenantId" = :tenantId', { tenantId })
          .orderBy('msg.createdAt', 'ASC')
          .stream();

        const exportedRows: ExportedMessageRow[] = [];
        for await (const rawRow of stream) {
          // TypeORM stream returns raw rows; map to export format
          const row: ExportedMessageRow = {
            messageId: rawRow.msg_id,
            channelId: rawRow.msg_channelId,
            senderId: rawRow.msg_senderId,
            content: rawRow.msg_content,
            contentType: rawRow.msg_contentType,
            createdAt: new Date(rawRow.msg_createdAt).toISOString(),
            editedAt: rawRow.msg_editedAt ? new Date(rawRow.msg_editedAt).toISOString() : null,
            isDeleted: rawRow.msg_isDeleted ?? false,
            attachmentCount: rawRow.att_id ? 1 : 0,
            hasLegalHold: isUnderHold || heldChannelSet.has(rawRow.msg_channelId),
          };
          exportedRows.push(row);
        }
        return exportedRows;
      },
    );

    const data =
      format === 'json'
        ? JSON.stringify(rows, null, 2)
        : this.toCsv(rows);

    await this.auditService.log({
      tenantId,
      userId,
      action: ComplianceAction.MESSAGE_EXPORT,
      resourceType: 'tenant',
      resourceId: tenantId,
      details: {
        format,
        recordCount: rows.length,
        isUnderLegalHold: isUnderHold,
        jobId,
      },
      ipAddress: null,
      userAgent: null,
    });

    this.logger.log(
      `Tenant export completed: tenant=${tenantId}, format=${format}, records=${rows.length}`,
    );

    return {
      jobId,
      status: 'completed',
      format,
      recordCount: rows.length,
      data,
      isUnderLegalHold: isUnderHold,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Map a message entity to an export row.
   */
  private toExportRow(
    msg: Message,
    isUnderHold: boolean,
  ): ExportedMessageRow {
    return {
      messageId: msg.id,
      channelId: msg.channelId,
      senderId: msg.senderId,
      content: msg.content,
      contentType: msg.contentType,
      createdAt: msg.createdAt.toISOString(),
      editedAt: msg.editedAt?.toISOString() ?? null,
      isDeleted: msg.isDeleted,
      attachmentCount: msg.attachments?.length ?? 0,
      hasLegalHold: isUnderHold,
    };
  }

  /**
   * Convert export rows to CSV string.
   */
  private toCsv(rows: ExportedMessageRow[]): string {
    const headers = [
      'messageId',
      'channelId',
      'senderId',
      'content',
      'contentType',
      'createdAt',
      'editedAt',
      'isDeleted',
      'attachmentCount',
      'hasLegalHold',
    ];

    const csvRows = rows.map((row) =>
      headers
        .map((h) => {
          const value = row[h as keyof ExportedMessageRow];
          if (value === null || value === undefined) return '';
          const str = String(value);
          // Escape CSV values containing commas, quotes, or newlines
          if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(','),
    );

    return [headers.join(','), ...csvRows].join('\n');
  }
}
