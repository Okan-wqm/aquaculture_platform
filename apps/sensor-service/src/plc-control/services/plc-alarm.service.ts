import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual, In, IsNull } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@platform/backend-common';

import {
  PlcAlarm,
  AlarmSeverity,
  AlarmSource,
  ApprovalChainEntry,
} from '../entities/plc-alarm.entity';
import {
  PlcAlarmFilterDto,
  PlcAlarmStatsDto,
  AlarmCountBySeverityDto,
  AlarmCountBySourceDto,
} from '../dto';
import { PlcPaginationDto } from '../dto/plc-connection.dto';

export type PaginatedPlcAlarms = IStandardPaginatedResult<PlcAlarm>;

/**
 * PLC Alarm Service
 * Handles operations for PLC alarms with tenant isolation
 */
@Injectable()
export class PlcAlarmService {
  private readonly logger = new Logger(PlcAlarmService.name);

  constructor(
    @InjectRepository(PlcAlarm)
    private readonly plcAlarmRepository: Repository<PlcAlarm>,
  ) {}

  /**
   * Find an alarm by ID with tenant isolation
   */
  async findById(id: string, tenantId: string): Promise<PlcAlarm> {
    const alarm = await this.plcAlarmRepository.findOne({
      where: { id, tenantId },
    });

    if (!alarm) {
      throw new NotFoundException(`PLC alarm with ID ${id} not found`);
    }

    return alarm;
  }

  /**
   * Find all alarms with filtering and pagination
   */
  async findAll(
    tenantId: string,
    filter?: PlcAlarmFilterDto,
    pagination?: PlcPaginationDto,
  ): Promise<PaginatedPlcAlarms> {
    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.plcAlarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.plcConnectionId) {
      queryBuilder.andWhere('alarm.plcConnectionId = :plcConnectionId', {
        plcConnectionId: filter.plcConnectionId,
      });
    }

    if (filter?.tankId) {
      queryBuilder.andWhere('alarm.tankId = :tankId', { tankId: filter.tankId });
    }

    if (filter?.severity) {
      queryBuilder.andWhere('alarm.severity = :severity', {
        severity: filter.severity,
      });
    }

    if (filter?.source) {
      queryBuilder.andWhere('alarm.source = :source', { source: filter.source });
    }

    if (filter?.acknowledged !== undefined) {
      queryBuilder.andWhere('alarm.acknowledged = :acknowledged', {
        acknowledged: filter.acknowledged,
      });
    }

    if (filter?.fromDate) {
      queryBuilder.andWhere('alarm.timestamp >= :fromDate', {
        fromDate: filter.fromDate,
      });
    }

    if (filter?.toDate) {
      queryBuilder.andWhere('alarm.timestamp <= :toDate', { toDate: filter.toDate });
    }

    if (filter?.search) {
      queryBuilder.andWhere(
        '(alarm.message ILIKE :search OR alarm.alarmCode ILIKE :search OR alarm.action ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    // Apply sorting — whitelist allowed columns to prevent SQL injection
    const allowedSortColumns = ['timestamp', 'severity', 'source', 'alarmCode', 'createdAt', 'acknowledged'];
    const sortBy = allowedSortColumns.includes(pagination?.sortBy || '') ? pagination!.sortBy! : 'timestamp';
    const sortOrder = pagination?.sortOrder || 'DESC';
    queryBuilder.orderBy(`alarm.${sortBy}`, sortOrder);

    // Get total count and items
    const [items, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Get active (uncleared) alarms
   */
  async findActive(tenantId: string, plcConnectionId?: string): Promise<PlcAlarm[]> {
    const queryBuilder = this.plcAlarmRepository
      .createQueryBuilder('alarm')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.clearedAt IS NULL');

    if (plcConnectionId) {
      queryBuilder.andWhere('alarm.plcConnectionId = :plcConnectionId', { plcConnectionId });
    }

    return queryBuilder.orderBy('alarm.timestamp', 'DESC').getMany();
  }

  /**
   * Get unacknowledged alarms
   */
  async findUnacknowledged(
    tenantId: string,
    plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    const where: Record<string, unknown> = {
      tenantId,
      acknowledged: false,
    };

    if (plcConnectionId) {
      where.plcConnectionId = plcConnectionId;
    }

    return this.plcAlarmRepository.find({
      where,
      order: { severity: 'DESC', timestamp: 'DESC' },
    });
  }

  /**
   * Acknowledge an alarm
   */
  async acknowledge(
    id: string,
    tenantId: string,
    userId: string,
    notes?: string,
  ): Promise<PlcAlarm> {
    const alarm = await this.findById(id, tenantId);

    if (alarm.acknowledged) {
      return alarm;
    }

    // Enterprise approval check: if alarm has requiredApprovalLevel > 0,
    // require approval workflow instead of direct acknowledge
    if (alarm.requiredApprovalLevel > 1 && alarm.approvalLevel < alarm.requiredApprovalLevel) {
      throw new Error(`Alarm requires level ${alarm.requiredApprovalLevel} approval before acknowledgement`);
    }

    alarm.acknowledged = true;
    alarm.acknowledgedAt = new Date();
    alarm.acknowledgedBy = userId;

    if (notes) {
      alarm.notes = notes;
    }

    const updatedAlarm = await this.plcAlarmRepository.save(alarm);
    this.logger.log(`Alarm ${id} acknowledged by ${userId}`);

    return updatedAlarm;
  }

  /**
   * Bulk acknowledge alarms
   */
  async bulkAcknowledge(
    alarmIds: string[],
    tenantId: string,
    userId: string,
    notes?: string,
  ): Promise<number> {
    const result = await this.plcAlarmRepository.update(
      {
        id: In(alarmIds),
        tenantId,
        acknowledged: false,
      },
      {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy: userId,
        notes: notes || undefined,
      },
    );

    this.logger.log(
      `${result.affected} alarms acknowledged by ${userId}`,
    );

    return result.affected || 0;
  }

  /**
   * Acknowledge all alarms for a PLC connection
   */
  async acknowledgeAllForConnection(
    plcConnectionId: string,
    tenantId: string,
    userId: string,
    notes?: string,
  ): Promise<number> {
    const result = await this.plcAlarmRepository.update(
      {
        plcConnectionId,
        tenantId,
        acknowledged: false,
      },
      {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy: userId,
        notes: notes || undefined,
      },
    );

    this.logger.log(
      `${result.affected} alarms acknowledged for PLC ${plcConnectionId} by ${userId}`,
    );

    return result.affected || 0;
  }

  /**
   * Clear an alarm (mark as resolved)
   */
  async clear(id: string, tenantId: string): Promise<PlcAlarm> {
    const alarm = await this.findById(id, tenantId);

    if (alarm.clearedAt) {
      return alarm;
    }

    alarm.clearedAt = new Date();

    return this.plcAlarmRepository.save(alarm);
  }

  /**
   * Add notes to an alarm
   */
  async addNotes(id: string, tenantId: string, notes: string): Promise<PlcAlarm> {
    const alarm = await this.findById(id, tenantId);
    alarm.notes = notes;

    return this.plcAlarmRepository.save(alarm);
  }

  /**
   * Get alarm statistics
   */
  async getStats(tenantId: string, plcConnectionId?: string): Promise<PlcAlarmStatsDto> {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Helper to build base query
    const baseQuery = () => {
      const qb = this.plcAlarmRepository
        .createQueryBuilder('alarm')
        .where('alarm.tenantId = :tenantId', { tenantId });
      if (plcConnectionId) {
        qb.andWhere('alarm.plcConnectionId = :plcConnectionId', { plcConnectionId });
      }
      return qb;
    };

    // Total active alarms (uncleared)
    const totalActive = await baseQuery()
      .andWhere('alarm.clearedAt IS NULL')
      .getCount();

    // Total unacknowledged
    const totalUnacknowledged = await baseQuery()
      .andWhere('alarm.acknowledged = :acknowledged', { acknowledged: false })
      .getCount();

    // Count by severity
    const criticalCount = await baseQuery()
      .andWhere('alarm.severity = :severity', { severity: AlarmSeverity.CRITICAL })
      .andWhere('alarm.clearedAt IS NULL')
      .getCount();

    const emergencyCount = await baseQuery()
      .andWhere('alarm.severity = :severity', { severity: AlarmSeverity.EMERGENCY })
      .andWhere('alarm.clearedAt IS NULL')
      .getCount();

    const warningCount = await baseQuery()
      .andWhere('alarm.severity = :severity', { severity: AlarmSeverity.WARNING })
      .andWhere('alarm.clearedAt IS NULL')
      .getCount();

    const infoCount = await baseQuery()
      .andWhere('alarm.severity = :severity', { severity: AlarmSeverity.INFO })
      .andWhere('alarm.clearedAt IS NULL')
      .getCount();

    // Last 24 hours
    const last24HoursCount = await baseQuery()
      .andWhere('alarm.timestamp >= :oneDayAgo', { oneDayAgo })
      .getCount();

    // Last 7 days
    const last7DaysCount = await baseQuery()
      .andWhere('alarm.timestamp >= :sevenDaysAgo', { sevenDaysAgo })
      .getCount();

    return {
      totalActive,
      totalUnacknowledged,
      criticalCount,
      emergencyCount,
      warningCount,
      infoCount,
      last24HoursCount,
      last7DaysCount,
    };
  }

  /**
   * Get alarm count by severity
   */
  async getCountBySeverity(
    tenantId: string,
    plcConnectionId?: string,
  ): Promise<AlarmCountBySeverityDto> {
    const queryBuilder = this.plcAlarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.severity', 'severity')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.clearedAt IS NULL');

    if (plcConnectionId) {
      queryBuilder.andWhere('alarm.plcConnectionId = :plcConnectionId', { plcConnectionId });
    }

    const counts = await queryBuilder
      .groupBy('alarm.severity')
      .getRawMany<{ severity: string; count: string }>();

    const result: AlarmCountBySeverityDto = {
      info: 0,
      warning: 0,
      critical: 0,
      emergency: 0,
    };

    for (const row of counts) {
      const count = parseInt(row.count, 10);
      switch (row.severity) {
        case AlarmSeverity.INFO:
          result.info = count;
          break;
        case AlarmSeverity.WARNING:
          result.warning = count;
          break;
        case AlarmSeverity.CRITICAL:
          result.critical = count;
          break;
        case AlarmSeverity.EMERGENCY:
          result.emergency = count;
          break;
      }
    }

    return result;
  }

  /**
   * Get alarm count by source
   */
  async getCountBySource(
    tenantId: string,
    plcConnectionId?: string,
  ): Promise<AlarmCountBySourceDto[]> {
    const queryBuilder = this.plcAlarmRepository
      .createQueryBuilder('alarm')
      .select('alarm.source', 'source')
      .addSelect('COUNT(*)', 'count')
      .where('alarm.tenantId = :tenantId', { tenantId })
      .andWhere('alarm.clearedAt IS NULL');

    if (plcConnectionId) {
      queryBuilder.andWhere('alarm.plcConnectionId = :plcConnectionId', {
        plcConnectionId,
      });
    }

    const counts = await queryBuilder
      .groupBy('alarm.source')
      .orderBy('count', 'DESC')
      .getRawMany<{ source: string; count: string }>();

    return counts.map((row) => ({
      source: row.source,
      count: parseInt(row.count, 10),
    }));
  }

  /**
   * Get recent alarms
   */
  async findRecent(
    tenantId: string,
    limit: number = 10,
    plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    const where: Record<string, unknown> = { tenantId };
    if (plcConnectionId) {
      where.plcConnectionId = plcConnectionId;
    }

    return this.plcAlarmRepository.find({
      where,
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get alarms within time range
   */
  async findByTimeRange(
    tenantId: string,
    from: Date,
    to: Date,
    plcConnectionId?: string,
  ): Promise<PlcAlarm[]> {
    const where: Record<string, unknown> = {
      tenantId,
      timestamp: Between(from, to),
    };

    if (plcConnectionId) {
      where.plcConnectionId = plcConnectionId;
    }

    return this.plcAlarmRepository.find({
      where,
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Delete old alarms (for data retention)
   */
  async deleteOldAlarms(tenantId: string, olderThan: Date): Promise<number> {
    const result = await this.plcAlarmRepository.delete({
      tenantId,
      timestamp: LessThanOrEqual(olderThan),
      acknowledged: true, // Only delete acknowledged alarms
    });

    this.logger.log(
      `Deleted ${result.affected} old alarms for tenant ${tenantId}`,
    );

    return result.affected || 0;
  }

  /**
   * Approve alarm at a specific level
   */
  async approveAlarm(
    tenantId: string,
    alarmId: string,
    userId: string,
    level: number,
    notes?: string,
  ): Promise<PlcAlarm> {
    if (level < 1 || level > 3) {
      throw new Error('Approval level must be between 1 and 3');
    }

    const alarm = await this.findById(alarmId, tenantId);

    if (alarm.approvalChain?.some(e => e.userId === userId)) {
      throw new Error('Same user cannot approve at multiple levels');
    }

    if (alarm.approvalLevel >= level) {
      throw new Error(`Alarm already approved at level ${alarm.approvalLevel}`);
    }

    const entry: ApprovalChainEntry = {
      userId,
      level,
      approvedAt: new Date(),
      notes,
    };

    alarm.approvalChain = [...(alarm.approvalChain || []), entry];
    alarm.approvalLevel = level;

    // If approval level meets required level, mark as acknowledged
    if (level >= alarm.requiredApprovalLevel) {
      alarm.acknowledged = true;
      alarm.acknowledgedAt = new Date();
      alarm.acknowledgedBy = userId;
    }

    this.logger.log(`Alarm ${alarmId} approved at level ${level} by ${userId}`);
    return this.plcAlarmRepository.save(alarm);
  }

  /**
   * Escalate alarm to next approval level
   */
  async escalateAlarm(tenantId: string, alarmId: string): Promise<PlcAlarm> {
    const alarm = await this.findById(alarmId, tenantId);

    if (alarm.acknowledged) {
      throw new Error('Cannot escalate an already acknowledged alarm');
    }

    alarm.escalatedAt = new Date();
    // Required level increases, pushing it to a higher authority
    if (alarm.requiredApprovalLevel < 3) {
      alarm.requiredApprovalLevel += 1;
    }

    this.logger.log(`Alarm ${alarmId} escalated to level ${alarm.requiredApprovalLevel}`);
    return this.plcAlarmRepository.save(alarm);
  }

  /**
   * Compute SLA parameters based on alarm severity
   */
  private computeAlarmSla(severity: AlarmSeverity): {
    requiredLevel: number;
    slaMs: number;
    autoEscalateMs: number;
  } {
    switch (severity) {
      case AlarmSeverity.EMERGENCY:
        return { requiredLevel: 3, slaMs: 5 * 60 * 1000, autoEscalateMs: 2 * 60 * 1000 };
      case AlarmSeverity.CRITICAL:
        return { requiredLevel: 2, slaMs: 15 * 60 * 1000, autoEscalateMs: 5 * 60 * 1000 };
      case AlarmSeverity.WARNING:
        return { requiredLevel: 1, slaMs: 60 * 60 * 1000, autoEscalateMs: 30 * 60 * 1000 };
      default:
        return { requiredLevel: 1, slaMs: 4 * 60 * 60 * 1000, autoEscalateMs: 2 * 60 * 60 * 1000 };
    }
  }

  /**
   * Apply SLA parameters to a newly created alarm
   */
  applySlaToAlarm(alarm: PlcAlarm): void {
    const sla = this.computeAlarmSla(alarm.severity);
    alarm.requiredApprovalLevel = sla.requiredLevel;
    alarm.slaDeadline = new Date(Date.now() + sla.slaMs);
    alarm.autoEscalateAfterMs = sla.autoEscalateMs;
  }
}
