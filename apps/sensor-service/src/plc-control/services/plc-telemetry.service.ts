import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { createStandardPaginatedResult, IStandardPaginatedResult } from '@platform/backend-common';

import {
  PlcTelemetry,
  SensorReadings,
  ActuatorStatus,
  FeedingStatus,
  PlcStatus,
} from '../entities/plc-telemetry.entity';
import {
  PlcTelemetryFilterDto,
  PlcTelemetryStatsDto,
  SensorStats,
  FeedingStatsDto,
  ActuatorUsageStatsDto,
  LatestTelemetrySummaryDto,
} from '../dto';

export type PaginatedPlcTelemetry = IStandardPaginatedResult<PlcTelemetry>;

/**
 * Time range for queries
 */
export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * PLC Telemetry Service
 * Handles operations for PLC telemetry data with tenant isolation
 */
@Injectable()
export class PlcTelemetryService {
  private readonly logger = new Logger(PlcTelemetryService.name);

  constructor(
    @InjectRepository(PlcTelemetry)
    private readonly plcTelemetryRepository: Repository<PlcTelemetry>,
  ) {}

  /**
   * Find telemetry by ID with tenant isolation
   */
  async findById(id: string, tenantId: string): Promise<PlcTelemetry> {
    const telemetry = await this.plcTelemetryRepository.findOne({
      where: { id, tenantId },
    });

    if (!telemetry) {
      throw new NotFoundException(`PLC telemetry with ID ${id} not found`);
    }

    return telemetry;
  }

  /**
   * Get latest telemetry for a PLC connection
   */
  async getLatest(
    plcConnectionId: string,
    tenantId: string,
  ): Promise<PlcTelemetry | null> {
    return this.plcTelemetryRepository.findOne({
      where: { plcConnectionId, tenantId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get latest telemetry summary
   */
  async getLatestSummary(
    plcConnectionId: string,
    tenantId: string,
  ): Promise<LatestTelemetrySummaryDto | null> {
    const telemetry = await this.getLatest(plcConnectionId, tenantId);

    if (!telemetry) {
      return null;
    }

    return {
      plcConnectionId: telemetry.plcConnectionId,
      timestamp: telemetry.timestamp,
      oxygen: telemetry.sensors?.oxygen,
      temperature: telemetry.sensors?.temperature,
      ph: telemetry.sensors?.ph,
      flowRate: telemetry.sensors?.flowRate,
      blowerSpeed: telemetry.actuators?.blowerSpeed,
      doserSpeed: telemetry.actuators?.doserSpeed,
      aerationOn: telemetry.actuators?.aerationOn,
      feedingInProgress: telemetry.actuators?.feedingInProgress,
      plcMode: telemetry.plcStatus?.mode,
      activeAlarmCount: telemetry.plcStatus?.activeAlarmCount,
    };
  }

  /**
   * Get telemetry within time range
   */
  async findByTimeRange(
    plcConnectionId: string,
    tenantId: string,
    timeRange: TimeRange,
    limit: number = 1000,
  ): Promise<PlcTelemetry[]> {
    return this.plcTelemetryRepository.find({
      where: {
        plcConnectionId,
        tenantId,
        timestamp: Between(timeRange.from, timeRange.to),
      },
      order: { timestamp: 'DESC' },
      take: limit,
    });
  }

  /**
   * Find telemetry with filtering
   */
  async findAll(
    tenantId: string,
    filter?: PlcTelemetryFilterDto,
  ): Promise<PaginatedPlcTelemetry> {
    const page = filter?.page || 1;
    const limit = filter?.limit || 100;

    const queryBuilder = this.plcTelemetryRepository
      .createQueryBuilder('telemetry')
      .where('telemetry.tenantId = :tenantId', { tenantId });

    if (filter?.plcConnectionId) {
      queryBuilder.andWhere('telemetry.plcConnectionId = :plcConnectionId', {
        plcConnectionId: filter.plcConnectionId,
      });
    }

    if (filter?.tankId) {
      queryBuilder.andWhere('telemetry.tankId = :tankId', { tankId: filter.tankId });
    }

    if (filter?.fromDate) {
      queryBuilder.andWhere('telemetry.timestamp >= :fromDate', {
        fromDate: filter.fromDate,
      });
    }

    if (filter?.toDate) {
      queryBuilder.andWhere('telemetry.timestamp <= :toDate', {
        toDate: filter.toDate,
      });
    }

    queryBuilder
      .orderBy('telemetry.timestamp', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [items, total] = await queryBuilder.getManyAndCount();

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Get telemetry statistics for a time range
   */
  async getStats(
    plcConnectionId: string,
    tenantId: string,
    timeRange: TimeRange,
  ): Promise<PlcTelemetryStatsDto> {
    const telemetryData = await this.findByTimeRange(
      plcConnectionId,
      tenantId,
      timeRange,
      10000, // Get enough data for meaningful stats
    );

    if (telemetryData.length === 0) {
      return {
        plcConnectionId,
        from: timeRange.from,
        to: timeRange.to,
        totalRecords: 0,
        oxygen: { count: 0 },
        temperature: { count: 0 },
      };
    }

    // Calculate statistics for each sensor
    const oxygenValues = telemetryData
      .map((t) => t.sensors?.oxygen)
      .filter((v): v is number => v !== undefined && v !== null);

    const tempValues = telemetryData
      .map((t) => t.sensors?.temperature)
      .filter((v): v is number => v !== undefined && v !== null);

    const phValues = telemetryData
      .map((t) => t.sensors?.ph)
      .filter((v): v is number => v !== undefined && v !== null);

    const flowValues = telemetryData
      .map((t) => t.sensors?.flowRate)
      .filter((v): v is number => v !== undefined && v !== null);

    return {
      plcConnectionId,
      from: timeRange.from,
      to: timeRange.to,
      totalRecords: telemetryData.length,
      oxygen: this.calculateSensorStats(oxygenValues),
      temperature: this.calculateSensorStats(tempValues),
      ph: phValues.length > 0 ? this.calculateSensorStats(phValues) : undefined,
      flowRate: flowValues.length > 0 ? this.calculateSensorStats(flowValues) : undefined,
    };
  }

  /**
   * Get feeding statistics from telemetry
   */
  async getFeedingStats(
    plcConnectionId: string,
    tenantId: string,
    timeRange: TimeRange,
  ): Promise<FeedingStatsDto> {
    const telemetryData = await this.findByTimeRange(
      plcConnectionId,
      tenantId,
      timeRange,
      10000,
    );

    if (telemetryData.length === 0) {
      return {
        totalFeedKg: 0,
        totalFeedings: 0,
        avgFeedingAmountKg: 0,
      };
    }

    // Get the latest telemetry for current daily stats
    const latest = telemetryData[0]!;
    const feedingData = latest.feeding;

    // Calculate totals from all telemetry records
    const feedAmounts = telemetryData
      .map((t) => t.feeding?.lastFeedingAmountKg)
      .filter((v): v is number => v !== undefined && v !== null);

    const totalFeedKg = feedingData?.dailyTotalKg || 0;
    const totalFeedings = feedingData?.feedingsCompleted || 0;

    return {
      totalFeedKg,
      totalFeedings,
      avgFeedingAmountKg: totalFeedings > 0 ? totalFeedKg / totalFeedings : 0,
      lastFeedingTime: feedingData?.lastFeedingTime,
      lastFeedingAmountKg: feedingData?.lastFeedingAmountKg,
    };
  }

  /**
   * Get actuator usage statistics
   */
  async getActuatorUsageStats(
    plcConnectionId: string,
    tenantId: string,
    timeRange: TimeRange,
  ): Promise<ActuatorUsageStatsDto> {
    const telemetryData = await this.findByTimeRange(
      plcConnectionId,
      tenantId,
      timeRange,
      10000,
    );

    if (telemetryData.length === 0) {
      return {
        avgBlowerSpeed: 0,
        avgDoserSpeed: 0,
        aerationOnTimePercent: 0,
        feedingTimePercent: 0,
      };
    }

    const blowerSpeeds = telemetryData
      .map((t) => t.actuators?.blowerSpeed)
      .filter((v): v is number => v !== undefined && v !== null);

    const doserSpeeds = telemetryData
      .map((t) => t.actuators?.doserSpeed)
      .filter((v): v is number => v !== undefined && v !== null);

    const aerationOnCount = telemetryData.filter(
      (t) => t.actuators?.aerationOn === true,
    ).length;

    const feedingCount = telemetryData.filter(
      (t) => t.actuators?.feedingInProgress === true,
    ).length;

    const avgBlowerSpeed = blowerSpeeds.length > 0
      ? blowerSpeeds.reduce((a, b) => a + b, 0) / blowerSpeeds.length
      : 0;

    const avgDoserSpeed = doserSpeeds.length > 0
      ? doserSpeeds.reduce((a, b) => a + b, 0) / doserSpeeds.length
      : 0;

    return {
      avgBlowerSpeed,
      avgDoserSpeed,
      aerationOnTimePercent: (aerationOnCount / telemetryData.length) * 100,
      feedingTimePercent: (feedingCount / telemetryData.length) * 100,
    };
  }

  /**
   * Get latest telemetry for all connections of a tenant
   */
  async getLatestForAllConnections(
    tenantId: string,
  ): Promise<LatestTelemetrySummaryDto[]> {
    // Get distinct PLC connection IDs
    const connections = await this.plcTelemetryRepository
      .createQueryBuilder('telemetry')
      .select('DISTINCT telemetry.plcConnectionId', 'plcConnectionId')
      .where('telemetry.tenantId = :tenantId', { tenantId })
      .getRawMany<{ plcConnectionId: string }>();

    const summaries: LatestTelemetrySummaryDto[] = [];

    for (const conn of connections) {
      const summary = await this.getLatestSummary(conn.plcConnectionId, tenantId);
      if (summary) {
        summaries.push(summary);
      }
    }

    return summaries;
  }

  /**
   * Delete old telemetry data (for data retention)
   */
  async deleteOldTelemetry(tenantId: string, olderThan: Date): Promise<number> {
    const result = await this.plcTelemetryRepository.delete({
      tenantId,
      timestamp: LessThanOrEqual(olderThan),
    });

    this.logger.log(
      `Deleted ${result.affected} old telemetry records for tenant ${tenantId}`,
    );

    return result.affected || 0;
  }

  /**
   * Calculate statistics for a set of values
   */
  private calculateSensorStats(values: number[]): SensorStats {
    if (values.length === 0) {
      return { count: 0 };
    }

    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Calculate standard deviation
    const squaredDiffs = values.map((v) => Math.pow(v - avg, 2));
    const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = Math.sqrt(avgSquaredDiff);

    return {
      min,
      max,
      avg,
      stdDev,
      count: values.length,
    };
  }
}
