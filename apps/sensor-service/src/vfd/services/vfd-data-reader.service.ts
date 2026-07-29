import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';

import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdReading } from '../entities/vfd-reading.entity';

import { VfdDeviceService } from './vfd-device.service';
import { VfdEdgeReadService } from './vfd-edge-read.service';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';
import { buildVfdReadResult, VfdReadResult } from './vfd-reading-codec';

/**
 * Time range for reading queries
 */
export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * VFD Data Reader Service
 *
 * SENSOR-CRITICAL-007 / Faz 4: VFD telemetry is edge-delegated. This service does
 * NOT open a socket to the drive (and no longer pools in-process connections) —
 * it reads every configured register through `VfdEdgeReadService` (edge
 * `read_modbus`) and decodes the values with the shared `VfdReadingCodec`. A
 * failed edge read throws rather than returning fabricated telemetry.
 */
@Injectable()
export class VfdDataReaderService {
  private readonly logger = new Logger(VfdDataReaderService.name);

  constructor(
    @InjectRepository(VfdReading)
    private readonly vfdReadingRepository: Repository<VfdReading>,
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService,
    private readonly edgeReadService: VfdEdgeReadService,
  ) {}

  /**
   * Read current parameters from a VFD device (all mapped registers).
   */
  async readParameters(deviceId: string, tenantId: string): Promise<VfdReadResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const mappings = await this.registerMappingService.getMappingsForBrand(device.brand);
    return this.readViaEdge(device, tenantId, mappings, 'read parameters', true);
  }

  /**
   * Read only critical parameters (for fast polling).
   */
  async readCriticalParameters(deviceId: string, tenantId: string): Promise<VfdReadResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const mappings = await this.registerMappingService.getCriticalMappings(device.brand);
    return this.readViaEdge(device, tenantId, mappings, 'read critical parameters', false);
  }

  /**
   * Get latest reading for a device
   */
  async getLatestReading(deviceId: string, tenantId: string): Promise<VfdReading | null> {
    return this.vfdReadingRepository.findOne({
      where: { vfdDeviceId: deviceId, tenantId },
      order: { timestamp: 'DESC' },
    });
  }

  /**
   * Get readings for a device within a time range
   */
  async getReadings(
    deviceId: string,
    tenantId: string,
    timeRange?: TimeRange,
    limit?: number,
  ): Promise<VfdReading[]> {
    const whereCondition: Record<string, unknown> = {
      vfdDeviceId: deviceId,
      tenantId,
    };

    if (timeRange) {
      whereCondition['timestamp'] = Between(timeRange.from, timeRange.to);
    }

    return this.vfdReadingRepository.find({
      where: whereCondition,
      order: { timestamp: 'DESC' },
      take: limit || 100,
    });
  }

  /**
   * Get aggregated statistics for a device
   */
  async getReadingStats(
    deviceId: string,
    tenantId: string,
    timeRange: TimeRange,
  ): Promise<{
    avgOutputFrequency?: number;
    maxOutputFrequency?: number;
    minOutputFrequency?: number;
    avgMotorCurrent?: number;
    maxMotorCurrent?: number;
    avgOutputPower?: number;
    maxOutputPower?: number;
    readingCount: number;
    faultCount: number;
    warningCount: number;
  }> {
    interface VfdStatisticsRaw {
      avgoutputfrequency: string | null;
      maxoutputfrequency: string | null;
      minoutputfrequency: string | null;
      avgmotorcurrent: string | null;
      maxmotorcurrent: string | null;
      avgoutputpower: string | null;
      maxoutputpower: string | null;
      readingcount: string;
      faultcount: string;
      warningcount: string;
    }

    const result: VfdStatisticsRaw | undefined = await this.vfdReadingRepository
      .createQueryBuilder('reading')
      .select([
        "AVG((reading.parameters->>'outputFrequency')::float) as avgOutputFrequency",
        "MAX((reading.parameters->>'outputFrequency')::float) as maxOutputFrequency",
        "MIN((reading.parameters->>'outputFrequency')::float) as minOutputFrequency",
        "AVG((reading.parameters->>'motorCurrent')::float) as avgMotorCurrent",
        "MAX((reading.parameters->>'motorCurrent')::float) as maxMotorCurrent",
        "AVG((reading.parameters->>'outputPower')::float) as avgOutputPower",
        "MAX((reading.parameters->>'outputPower')::float) as maxOutputPower",
        'COUNT(*) as readingCount',
        "SUM(CASE WHEN (reading.statusBits->>'fault')::boolean = true THEN 1 ELSE 0 END) as faultCount",
        "SUM(CASE WHEN (reading.statusBits->>'warning')::boolean = true THEN 1 ELSE 0 END) as warningCount",
      ])
      .where('reading.vfdDeviceId = :deviceId', { deviceId })
      .andWhere('reading.tenantId = :tenantId', { tenantId })
      .andWhere('reading.timestamp BETWEEN :from AND :to', {
        from: timeRange.from,
        to: timeRange.to,
      })
      .getRawOne();

    if (!result) {
      return {
        readingCount: 0,
        faultCount: 0,
        warningCount: 0,
      };
    }

    return {
      avgOutputFrequency: result.avgoutputfrequency
        ? parseFloat(result.avgoutputfrequency)
        : undefined,
      maxOutputFrequency: result.maxoutputfrequency
        ? parseFloat(result.maxoutputfrequency)
        : undefined,
      minOutputFrequency: result.minoutputfrequency
        ? parseFloat(result.minoutputfrequency)
        : undefined,
      avgMotorCurrent: result.avgmotorcurrent ? parseFloat(result.avgmotorcurrent) : undefined,
      maxMotorCurrent: result.maxmotorcurrent ? parseFloat(result.maxmotorcurrent) : undefined,
      avgOutputPower: result.avgoutputpower ? parseFloat(result.avgoutputpower) : undefined,
      maxOutputPower: result.maxoutputpower ? parseFloat(result.maxoutputpower) : undefined,
      readingCount: parseInt(result.readingcount, 10) || 0,
      faultCount: parseInt(result.faultcount, 10) || 0,
      warningCount: parseInt(result.warningcount, 10) || 0,
    };
  }

  /**
   * Get reading stats for a named period (hour, day, week, month).
   * Converts the period to a date range and delegates to getReadingStats.
   */
  async getReadingStatsByPeriod(
    deviceId: string,
    tenantId: string,
    period: 'hour' | 'day' | 'week' | 'month',
  ): Promise<{
    vfdDeviceId: string;
    period: string;
    avgFrequency?: number;
    avgCurrent?: number;
    avgPower?: number;
    maxFrequency?: number;
    maxCurrent?: number;
    maxPower?: number;
    totalEnergy?: number;
    runningTime?: number;
    faultCount: number;
  }> {
    const now = new Date();
    const from = new Date(now);

    switch (period) {
      case 'hour':
        from.setHours(from.getHours() - 1);
        break;
      case 'day':
        from.setDate(from.getDate() - 1);
        break;
      case 'week':
        from.setDate(from.getDate() - 7);
        break;
      case 'month':
        from.setMonth(from.getMonth() - 1);
        break;
    }

    const stats = await this.getReadingStats(deviceId, tenantId, { from, to: now });

    return {
      vfdDeviceId: deviceId,
      period,
      avgFrequency: stats.avgOutputFrequency,
      avgCurrent: stats.avgMotorCurrent,
      avgPower: stats.avgOutputPower,
      maxFrequency: stats.maxOutputFrequency,
      maxCurrent: stats.maxMotorCurrent,
      maxPower: stats.maxOutputPower,
      totalEnergy: undefined, // Not yet aggregated in base stats
      runningTime: undefined, // Not yet aggregated in base stats
      faultCount: stats.faultCount,
    };
  }

  /**
   * Read specific parameters from a VFD device (filtered).
   * If parameterNames is provided, only those parameters are returned.
   */
  async readFilteredParameters(
    deviceId: string,
    tenantId: string,
    parameterNames?: string[],
  ): Promise<VfdReadResult> {
    const result = await this.readParameters(deviceId, tenantId);

    if (parameterNames && parameterNames.length > 0) {
      // Filter the result parameters to only include requested ones
      const filtered: Record<string, unknown> = {};
      for (const name of parameterNames) {
        if (name in result.parameters) {
          filtered[name] = (result.parameters as Record<string, unknown>)[name];
        }
      }
      return {
        ...result,
        parameters: filtered as typeof result.parameters,
      };
    }

    return result;
  }

  /**
   * Delete old readings (for data retention)
   */
  async deleteOldReadings(tenantId: string, olderThan: Date): Promise<number> {
    const result = await this.vfdReadingRepository.delete({
      tenantId,
      timestamp: LessThanOrEqual(olderThan),
    });

    this.logger.log(`Deleted ${result.affected} old readings for tenant ${tenantId}`);
    return result.affected || 0;
  }

  // ============ PRIVATE METHODS ============

  /**
   * Read the given register mappings via the owning edge gateway and decode them
   * into a `VfdReadResult`. Fail-closed: an edge read failure throws (no
   * fabricated reading) and, when `updateStatus`, marks the drive disconnected.
   */
  private async readViaEdge(
    device: VfdDevice,
    tenantId: string,
    mappings: Awaited<ReturnType<VfdRegisterMappingService['getMappingsForBrand']>>,
    intent: string,
    updateStatus: boolean,
  ): Promise<VfdReadResult> {
    const edgeResult = await this.edgeReadService.readAllRegisters(device, intent);

    if (!edgeResult.success) {
      if (updateStatus) {
        await this.vfdDeviceService.updateConnectionStatus(device.id, tenantId, {
          isConnected: false,
          lastError: edgeResult.error ?? 'Edge read failed',
        });
      }
      this.logger.error(
        `Failed to read parameters from device ${device.id}: ${edgeResult.error ?? 'unknown error'}`,
      );
      throw new Error(
        `Edge read failed for VFD ${device.id}: ${edgeResult.error ?? 'unknown error'}`,
      );
    }

    const reading = buildVfdReadResult(
      mappings,
      edgeResult.values,
      edgeResult.latencyMs ?? 0,
      new Date(),
    );

    await this.saveReading(device, reading);

    if (updateStatus) {
      await this.vfdDeviceService.updateConnectionStatus(device.id, tenantId, {
        isConnected: true,
        lastTestedAt: reading.timestamp,
        latencyMs: reading.latencyMs,
      });
    }

    return reading;
  }

  /**
   * Save reading to database
   */
  private async saveReading(device: VfdDevice, result: VfdReadResult): Promise<VfdReading> {
    const reading = this.vfdReadingRepository.create({
      vfdDeviceId: device.id,
      tenantId: device.tenantId,
      parameters: result.parameters,
      statusBits: result.statusBits,
      rawValues: result.rawValues,
      latencyMs: result.latencyMs,
      isValid: !result.errors || result.errors.length === 0,
      errorMessage: result.errors?.join('; '),
      timestamp: result.timestamp,
    });

    return this.vfdReadingRepository.save(reading);
  }
}
