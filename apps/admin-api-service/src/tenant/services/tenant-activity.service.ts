import { queryRowsNormalized } from '@aquaculture/backend-common/database';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  ActivityType,
  TenantActivityDto,
  TenantNoteDto,
  toTenantNoteDto,
} from '../dto/tenant-activity.dto';
import { TenantNote, TenantBillingInfo } from '../entities/tenant-activity.entity';

interface TenantActivityAuthorityRow {
  readonly id: string | null;
  readonly tenantId: string | null;
  readonly activityType: ActivityType | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly previousValue: Record<string, unknown> | null;
  readonly newValue: Record<string, unknown> | null;
  readonly performedBy: string | null;
  readonly performedByEmail: string | null;
  readonly createdAt: Date | string | null;
  readonly total: number | string;
}

export interface CreateNoteDto {
  tenantId: string;
  content: string;
  category?: string;
  isPinned?: boolean;
  createdBy: string;
  createdByEmail?: string;
}

@Injectable()
export class TenantActivityService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(TenantNote)
    private readonly noteRepository: Repository<TenantNote>,
    @InjectRepository(TenantBillingInfo)
    private readonly billingRepository: Repository<TenantBillingInfo>,
  ) {}

  // ============================================================================
  // Activity Methods
  // ============================================================================

  async getActivities(
    tenantId: string,
    options?: {
      limit?: number;
      offset?: number;
      activityTypes?: ActivityType[];
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<{ items: TenantActivityDto[]; total: number }> {
    const rows = queryRowsNormalized<TenantActivityAuthorityRow>(
      await this.dataSource.query(
        `WITH projected AS MATERIALIZED (
           SELECT
             receipt.id,
             receipt."tenantId",
             CASE receipt."commandType"
               WHEN 'ReserveTenant' THEN 'created'
               WHEN 'ActivateTenant' THEN 'activated'
               WHEN 'ResumeTenant' THEN 'activated'
               WHEN 'SuspendTenant' THEN 'suspended'
               WHEN 'DeprovisionTenant' THEN 'deactivated'
               WHEN 'ArchiveTenant' THEN 'deactivated'
               WHEN 'AssignModules' THEN 'module_assigned'
               WHEN 'RemoveModule' THEN 'module_removed'
             END AS "activityType",
             CASE receipt."commandType"
               WHEN 'ReserveTenant' THEN 'Tenant reserved'
               WHEN 'ActivateTenant' THEN 'Tenant activated after provisioning'
               WHEN 'ResumeTenant' THEN 'Tenant resumed'
               WHEN 'SuspendTenant' THEN 'Tenant suspended'
               WHEN 'DeprovisionTenant' THEN 'Tenant deactivated'
               WHEN 'ArchiveTenant' THEN 'Tenant archived'
               WHEN 'AssignModules' THEN 'Modules assigned'
               WHEN 'RemoveModule' THEN 'Module removed'
             END AS title,
             COALESCE(
               receipt."resultSummary"->>'reason',
               receipt."auditMetadata"->>'reason'
             ) AS description,
             jsonb_build_object(
               'sourceAuthority', 'auth.tenant_command_receipts',
               'operationId', receipt."operationId",
               'commandType', receipt."commandType",
               'resultHash', receipt."resultHash"
             ) AS metadata,
             CASE WHEN receipt."resultSummary" ? 'previousStatus'
               THEN jsonb_build_object('status', receipt."resultSummary"->>'previousStatus')
               ELSE NULL
             END AS "previousValue",
             CASE WHEN receipt."resultSummary" ? 'status'
               THEN jsonb_build_object('status', receipt."resultSummary"->>'status')
               ELSE NULL
             END AS "newValue",
             receipt.actor->>'id' AS "performedBy",
             NULL::text AS "performedByEmail",
             COALESCE(receipt."completedAt", receipt."createdAt") AS "createdAt"
           FROM auth.tenant_command_receipts receipt
           WHERE receipt."tenantId" = $1
             AND receipt.status = 'SUCCEEDED'
             AND receipt."commandType" = ANY($2::text[])
           UNION ALL
           SELECT
             audit.id,
             audit."tenantId",
             audit.details->>'legacyActivityType' AS "activityType",
             audit.details->>'title' AS title,
             audit.details->>'description' AS description,
             audit.details->'metadata' AS metadata,
             audit."previousValue",
             audit."newValue",
             audit."performedBy",
             audit."performedByEmail",
             audit."createdAt"
           FROM admin.audit_logs audit
           WHERE audit."tenantId" = $1
             AND audit.action = 'LEGACY_TENANT_ACTIVITY_IMPORTED'
         ), filtered AS MATERIALIZED (
           SELECT *
             FROM projected
            WHERE ($3::text[] IS NULL OR "activityType" = ANY($3::text[]))
              AND ($4::timestamptz IS NULL OR "createdAt" >= $4::timestamptz)
              AND ($5::timestamptz IS NULL OR "createdAt" <= $5::timestamptz)
         )
         SELECT page.*, totals.total::text
           FROM (SELECT COUNT(*) AS total FROM filtered) totals
           LEFT JOIN LATERAL (
             SELECT * FROM filtered
              ORDER BY "createdAt" DESC, id ASC
              LIMIT $6 OFFSET $7
           ) page ON TRUE`,
        [
          tenantId,
          [
            'ReserveTenant',
            'ActivateTenant',
            'ResumeTenant',
            'SuspendTenant',
            'DeprovisionTenant',
            'ArchiveTenant',
            'AssignModules',
            'RemoveModule',
          ],
          options?.activityTypes?.length ? options.activityTypes : null,
          options?.startDate ?? null,
          options?.endDate ?? null,
          options?.limit ?? 20,
          options?.offset ?? 0,
        ],
      ),
    );
    const total = Number(rows[0]?.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new TypeError('Tenant activity authority returned an invalid total');
    }
    const items = rows.flatMap((row): TenantActivityDto[] => {
      if (
        row.id === null ||
        row.tenantId === null ||
        row.activityType === null ||
        row.title === null ||
        row.createdAt === null
      ) {
        return [];
      }
      const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
      if (!Number.isFinite(createdAt.getTime())) {
        throw new TypeError('Tenant activity authority returned an invalid timestamp');
      }
      return [
        {
          id: row.id,
          tenantId: row.tenantId,
          activityType: row.activityType,
          title: row.title,
          description: row.description ?? undefined,
          metadata: row.metadata ?? undefined,
          previousValue: row.previousValue ?? undefined,
          newValue: row.newValue ?? undefined,
          performedBy: row.performedBy ?? undefined,
          performedByEmail: row.performedByEmail ?? undefined,
          createdAt,
        },
      ];
    });
    return { items, total };
  }

  async getRecentActivities(tenantId: string, limit = 20): Promise<TenantActivityDto[]> {
    return (await this.getActivities(tenantId, { limit })).items;
  }

  // ============================================================================
  // Note Methods
  // ============================================================================

  async createNote(dto: CreateNoteDto): Promise<TenantNoteDto> {
    const note = this.noteRepository.create({
      ...dto,
      category: dto.category || 'general',
      isPinned: dto.isPinned || false,
    });
    return toTenantNoteDto(await this.noteRepository.save(note));
  }

  async getNotes(
    tenantId: string,
    options?: { category?: string; limit?: number },
  ): Promise<TenantNoteDto[]> {
    const query = this.noteRepository
      .createQueryBuilder('note')
      .where('note.tenantId = :tenantId', { tenantId })
      .orderBy('note.isPinned', 'DESC')
      .addOrderBy('note.createdAt', 'DESC');

    if (options?.category) {
      query.andWhere('note.category = :category', {
        category: options.category,
      });
    }

    if (options?.limit) {
      query.take(options.limit);
    }

    return (await query.getMany()).map(toTenantNoteDto);
  }

  async updateNote(
    noteId: string,
    updates: { content?: string; isPinned?: boolean; category?: string },
    tenantId?: string,
  ): Promise<TenantNoteDto> {
    // HIGH-004 fix: verify tenant ownership if tenantId is provided
    if (tenantId) {
      const existing = await this.noteRepository.findOne({ where: { id: noteId } });
      if (!existing) {
        throw new Error(`Note not found: ${noteId}`);
      }
      if (existing.tenantId !== tenantId) {
        throw new Error('Note does not belong to the specified tenant');
      }
    }
    await this.noteRepository.update(noteId, updates);
    const note = await this.noteRepository.findOneOrFail({
      where: { id: noteId },
    });
    return toTenantNoteDto(note);
  }

  async deleteNote(noteId: string, tenantId?: string): Promise<void> {
    // HIGH-004 fix: verify tenant ownership if tenantId is provided
    if (tenantId) {
      const existing = await this.noteRepository.findOne({ where: { id: noteId } });
      if (!existing) {
        throw new Error(`Note not found: ${noteId}`);
      }
      if (existing.tenantId !== tenantId) {
        throw new Error('Note does not belong to the specified tenant');
      }
    }
    await this.noteRepository.delete(noteId);
  }

  // ============================================================================
  // Billing Methods
  // ============================================================================

  async getBillingInfo(tenantId: string): Promise<TenantBillingInfo | null> {
    return this.billingRepository.findOne({ where: { tenantId } });
  }

  async createOrUpdateBillingInfo(
    tenantId: string,
    data: Partial<TenantBillingInfo>,
  ): Promise<TenantBillingInfo> {
    let billing = await this.billingRepository.findOne({ where: { tenantId } });

    if (billing) {
      Object.assign(billing, data);
    } else {
      billing = this.billingRepository.create({ tenantId, ...data });
    }

    return this.billingRepository.save(billing);
  }
}
