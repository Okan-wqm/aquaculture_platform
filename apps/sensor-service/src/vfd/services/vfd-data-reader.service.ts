import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';

import {
  createVfdAdapter,
  VfdConnectionHandle,
  VfdReadResult,
} from '../adapters';
import { VfdDevice } from '../entities/vfd-device.entity';
import { VfdReading } from '../entities/vfd-reading.entity';

import { VfdDeviceService } from './vfd-device.service';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';

/**
 * Time range for reading queries
 */
export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * VFD Data Reader Service
 * Handles reading data from VFD devices and storing readings
 */
@Injectable()
export class VfdDataReaderService {
  private readonly logger = new Logger(VfdDataReaderService.name);

  // Active connections cache
  private activeConnections: Map<string, {
    handle: VfdConnectionHandle;
    adapter: ReturnType<typeof createVfdAdapter>;
    lastActivity: Date;
  }> = new Map();

  constructor(
    @InjectRepository(VfdReading)
    private readonly vfdReadingRepository: Repository<VfdReading>,
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService
  ) {}

  /**
   * Read current parameters from a VFD device
   */
  async readParameters(deviceId: string, tenantId: string): Promise<VfdReadResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const mappings = await this.registerMappingService.getMappingsForBrand(device.brand);

    // Get or create connection
    const { adapter, handle } = await this.getOrCreateConnection(device);

    try {
      // Read parameters using adapter
      const result = await adapter.readParameters(handle, mappings);

      // Save reading to database
      await this.saveReading(device, result);

      // Update device connection status
      await this.vfdDeviceService.updateConnectionStatus(deviceId, tenantId, {
        isConnected: true,
        lastTestedAt: new Date(),
        latencyMs: result.latencyMs,
      });

      return result;
    } catch (error) {
      this.logger.error(`Failed to read parameters from device ${deviceId}`, error);

      // Update connection status
      await this.vfdDeviceService.updateConnectionStatus(deviceId, tenantId, {
        isConnected: false,
        lastError: (error as Error).message,
      });

      throw error;
    }
  }

  /**
   * Read only critical parameters (for fast polling)
   */
  async readCriticalParameters(deviceId: string, tenantId: string): Promise<VfdReadResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);
    const mappings = await this.registerMappingService.getCriticalMappings(device.brand);

    const { adapter, handle } = await this.getOrCreateConnection(device);

    try {
      const result = await adapter.readParameters(handle, mappings);
      await this.saveReading(device, result);
      return result;
    } catch (error) {
      this.logger.error(`Failed to read critical parameters from device ${deviceId}`, error);
      throw error;
    }
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
    limit?: number
  ): Promise<VfdReading[]> {
    const whereCondition: Record<string, unknown> = {
      vfdDeviceId: deviceId,
      tenantId,
    };

    if (timeRange) {
      whereCondition.timestamp = Between(timeRange.from, timeRange.to);
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
    timeRange: TimeRange
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
      avgOutputFrequency: result.avgoutputfrequency ? parseFloat(result.avgoutputfrequency) : undefined,
      maxOutputFrequency: result.maxoutputfrequency ? parseFloat(result.maxoutputfrequency) : undefined,
      minOutputFrequency: result.minoutputfrequency ? parseFloat(result.minoutputfrequency) : undefined,
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

  /**
   * Close connection for a device
   */
  async closeConnection(deviceId: string): Promise<void> {
    const cached = this.activeConnections.get(deviceId);
    if (cached) {
      try {
        await cached.adapter.disconnect(cached.handle);
      } catch (error) {
        this.logger.warn(`Error closing connection for device ${deviceId}`, error);
      }
      this.activeConnections.delete(deviceId);
    }
  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    for (const [deviceId] of this.activeConnections) {
      await this.closeConnection(deviceId);
    }
  }

  // ============ PRIVATE METHODS ============

  /**
   * Get or create connection to a device
   */
  private async getOrCreateConnection(device: VfdDevice): Promise<{
    adapter: ReturnType<typeof createVfdAdapter>;
    handle: VfdConnectionHandle;
  }> {
    const cached = this.activeConnections.get(device.id);

    // Check if we have a valid cached connection
    if (cached && cached.handle.isConnected) {
      const idleTime = Date.now() - cached.lastActivity.getTime();
      if (idleTime < 60000) { // 1 minute idle timeout
        cached.lastActivity = new Date();
        return { adapter: cached.adapter, handle: cached.handle };
      }
      // Connection is stale, close it
      await this.closeConnection(device.id);
    }

    // Create new connection
    const adapter = createVfdAdapter(device.protocol);
    const handle = await adapter.connect(device.protocolConfiguration as unknown as Record<string, unknown>);

    this.activeConnections.set(device.id, {
      adapter,
      handle,
      lastActivity: new Date(),
    });

    return { adapter, handle };
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
