import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { AuditLog, AuditLogSeverity } from './audit-log.entity';

export interface CreateAuditLogDto {
  tenantId?: string;
  performedBy: string;
  performedByEmail?: string;
  action: string;
  entityType: string;
  entityId?: string;
  details?: Record<string, any>;
  previousValue?: Record<string, any>;
  newValue?: Record<string, any>;
  severity?: AuditLogSeverity;
  requestId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
  ) {}

  async log(dto: CreateAuditLogDto): Promise<AuditLog> {
    const auditLog = this.auditLogRepository.create({
      ...dto,
      severity: dto.severity ?? AuditLogSeverity.INFO,
    });
    const saved = await this.auditLogRepository.save(auditLog);
    this.logger.debug(`Audit log created: ${dto.action} for ${dto.entityType}`);
    return saved;
  }

  async findByTenant(
    tenantId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      action?: string;
      performedBy?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ data: AuditLog[]; total: number }> {
    const query = this.auditLogRepository.createQueryBuilder('audit')
      .where('audit.tenantId = :tenantId', { tenantId });

    if (options?.startDate && options?.endDate) {
      query.andWhere('audit.createdAt BETWEEN :startDate AND :endDate', {
        startDate: options.startDate,
        endDate: options.endDate,
      });
    }

    if (options?.action) {
      query.andWhere('audit.action = :action', { action: options.action });
    }

    if (options?.performedBy) {
      query.andWhere('audit.performedBy = :performedBy', { performedBy: options.performedBy });
    }

    query.orderBy('audit.createdAt', 'DESC');

    if (options?.limit) {
      query.take(options.limit);
    }

    if (options?.offset) {
      query.skip(options.offset);
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total };
  }

  async findByPerformer(
    performedBy: string,
    tenantId: string,
    limit: number = 100,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { performedBy, tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async findByEntity(
    entityType: string,
    entityId: string,
    tenantId: string,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { entityType, entityId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  async deleteOldLogs(retentionDays: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.auditLogRepository.delete({
      createdAt: LessThan(cutoffDate),
    });

    this.logger.log(`Deleted ${result.affected} old audit logs`);
    return result.affected || 0;
  }
}
