/**
 * WaterQuality Service
 *
 * Su kalitesi ölçümleri CRUD işlemleri.
 * Tank/batch bazlı sorgulama ve değerlendirme.
 *
 * @module WaterQuality
 */
import { randomUUID } from 'crypto';

import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import { IStandardPaginatedResult, createStandardPaginatedResult } from '@aquaculture/backend-common';
import { NatsEventBus } from '@platform/event-bus';
import { WaterQualityMeasurementCreatedEvent, WaterQualityCriticalEvent } from '@platform/event-contracts';
import { WaterQualityMeasurement, WaterQualityStatus, MeasurementSource, ParameterStatus } from './entities/water-quality-measurement.entity';
import { Tank } from '../tank/entities/tank.entity';
import { WaterQualityEvaluationService } from './services/water-quality-evaluation.service';
import { WaterQualityValidationService } from './services/water-quality-validation.service';
import { CreateBatchWaterQualityInput } from './dto/create-batch-water-quality.input';

// ============================================================================
// INTERNAL INTERFACES (Service layer only)
// ============================================================================

export interface CreateWaterQualityData {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  measuredAt: Date;
  source: MeasurementSource;
  measuredBy?: string;
  parameters?: {
    temperature?: number;
    dissolvedOxygen?: number;
    pH?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
    salinity?: number;
    turbidity?: number;
    alkalinity?: number;
    hardness?: number;
  };
  equipmentId?: string;
  dynamicParameters?: Record<string, number | string | boolean>;
  idempotencyKey?: string;
  notes?: string;
  weatherConditions?: string;
}

export interface UpdateWaterQualityData {
  parameters?: {
    temperature?: number;
    dissolvedOxygen?: number;
    pH?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
    salinity?: number;
    turbidity?: number;
    alkalinity?: number;
    hardness?: number;
  };
  notes?: string;
  weatherConditions?: string;
}

export interface WaterQualityFilters {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  systemId?: string;
  status?: WaterQualityStatus;
  source?: MeasurementSource;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export type WaterQualityListResult = IStandardPaginatedResult<WaterQualityMeasurement>;

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class WaterQualityService {
  private readonly logger = new Logger(WaterQualityService.name);

  constructor(
    @InjectRepository(WaterQualityMeasurement)
    private readonly repository: Repository<WaterQualityMeasurement>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    private readonly evaluationService: WaterQualityEvaluationService,
    private readonly validationService: WaterQualityValidationService,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Yeni su kalitesi ölçümü oluşturur
   */
  async create(tenantId: string, input: CreateWaterQualityData): Promise<WaterQualityMeasurement> {
    this.logger.log(`Creating water quality measurement for tenant ${tenantId}`);

    // C3: Idempotency check — return existing if same key within recent window
    if (input.idempotencyKey) {
      const existing = await this.repository.findOne({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        this.logger.debug(`Idempotent hit: returning existing measurement ${existing.id} for key ${input.idempotencyKey}`);
        return existing;
      }
    }

    // C2: Validate dynamic parameters against tenant configs if provided
    if (input.dynamicParameters && Object.keys(input.dynamicParameters).length > 0) {
      const validation = await this.validationService.validate(
        tenantId,
        input.dynamicParameters,
        input.equipmentId,
      );
      if (!validation.valid) {
        throw new BadRequestException({
          message: 'Dynamic parameter validation failed',
          errors: validation.errors,
        });
      }
    }

    // Merge static parameters + dynamic parameters into single JSONB
    const mergedParameters = {
      ...(input.parameters || {}),
      ...(input.dynamicParameters || {}),
    };

    const measurement = this.repository.create({
      tenantId,
      tankId: input.tankId,
      pondId: input.pondId,
      siteId: input.siteId,
      batchId: input.batchId,
      equipmentId: input.equipmentId,
      measuredAt: input.measuredAt,
      source: input.source,
      measuredBy: input.measuredBy,
      parameters: mergedParameters,
      notes: input.notes,
      weatherConditions: input.weatherConditions,
      idempotencyKey: input.idempotencyKey,
      overallStatus: WaterQualityStatus.UNKNOWN,
      hasAlarm: false,
    });

    // Dynamic config-driven evaluation (falls back to hardcoded if no configs)
    const summary = await this.evaluationService.evaluate(tenantId, measurement.parameters as unknown as Record<string, unknown>);
    if (summary.evaluations.length > 0) {
      measurement.overallStatus = summary.overallStatus;
      measurement.summary = summary;
      measurement.hasAlarm = summary.criticalCount > 0;
    } else {
      // Fallback: no tenant configs, use hardcoded defaults
      measurement.evaluateParameters();
    }

    const saved = await this.repository.save(measurement);
    this.logger.log(`Created water quality measurement ${saved.id} with status ${saved.overallStatus}`);

    // Publish NATS domain events (non-blocking — failure does not affect measurement creation)
    if (this.eventBus) {
      try {
        const createdEvent: WaterQualityMeasurementCreatedEvent = {
          eventId: randomUUID(),
          eventType: 'WaterQualityMeasurementCreated',
          tenantId,
          timestamp: new Date(),
          version: 1,
          measurementId: saved.id,
          equipmentId: saved.equipmentId ?? null,
          tankId: saved.tankId ?? null,
          source: saved.source,
          overallStatus: saved.overallStatus,
          hasAlarm: saved.hasAlarm,
          measuredBy: saved.measuredBy ?? null,
          measuredAt: saved.measuredAt.toISOString(),
          parameterCount: Object.keys(saved.parameters || {}).length,
        };
        await this.eventBus.publish(createdEvent);
        this.logger.debug(`Published WaterQualityMeasurementCreatedEvent for measurement ${saved.id}`);

        // High-priority critical event for alert-service
        if (saved.hasAlarm && saved.summary?.evaluations) {
          const criticalParams = saved.summary.evaluations
            .filter(e => e.status === ParameterStatus.CRITICAL_LOW || e.status === ParameterStatus.CRITICAL_HIGH)
            .map(e => ({
              code: e.parameter,
              name: e.parameter,
              value: e.value,
              threshold: e.status === ParameterStatus.CRITICAL_LOW ? (e.criticalMin ?? 0) : (e.criticalMax ?? 0),
              direction: (e.status === ParameterStatus.CRITICAL_LOW ? 'below' : 'above') as 'above' | 'below',
              unit: e.unit,
            }));

          if (criticalParams.length > 0) {
            // ARCH-C01: Serialize criticalParameters to JSON string — flat-object contract
            const criticalEvent: WaterQualityCriticalEvent = {
              eventId: randomUUID(),
              eventType: 'WaterQualityCritical',
              tenantId,
              timestamp: new Date(),
              version: 2,
              measurementId: saved.id,
              equipmentId: saved.equipmentId ?? null,
              tankId: saved.tankId ?? null,
              criticalParametersJson: JSON.stringify(criticalParams),
              criticalParameterCount: criticalParams.length,
              measuredAt: saved.measuredAt.toISOString(),
            };
            await this.eventBus.publish(criticalEvent);
            this.logger.debug(`Published WaterQualityCriticalEvent for measurement ${saved.id} with ${criticalParams.length} critical parameters`);
          }
        }
      } catch (eventError) {
        this.logger.warn(`Failed to publish WQ event: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }

  // -------------------------------------------------------------------------
  // BATCH CREATE
  // -------------------------------------------------------------------------

  /**
   * Batch creation of water quality measurements for multiple equipment.
   * Validates all items first (fail-fast), then bulk inserts in a single transaction.
   */
  async createBatch(
    tenantId: string,
    input: CreateBatchWaterQualityInput,
    userId: string,
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.log(`Creating batch of ${input.measurements.length} WQ measurements for tenant ${tenantId}`);

    // 1. Validate ALL items first (fail-fast)
    for (const item of input.measurements) {
      const result = await this.validationService.validate(tenantId, item.dynamicParameters, item.equipmentId);
      if (!result.valid) {
        throw new BadRequestException({
          message: `Validation failed for equipment ${item.equipmentId}`,
          errors: result.errors,
        });
      }
    }

    // 2. Build entities
    const entities: WaterQualityMeasurement[] = [];
    for (const item of input.measurements) {
      const measurement = this.repository.create({
        tenantId,
        equipmentId: item.equipmentId,
        measuredAt: input.measuredAt,
        source: input.source,
        measuredBy: userId,
        parameters: item.dynamicParameters as unknown as Record<string, unknown> as WaterQualityMeasurement['parameters'],
        notes: item.notes,
        idempotencyKey: item.idempotencyKey,
        overallStatus: WaterQualityStatus.UNKNOWN,
        hasAlarm: false,
      });

      // Evaluate thresholds
      const summary = await this.evaluationService.evaluate(
        tenantId,
        item.dynamicParameters as unknown as Record<string, unknown>,
      );
      if (summary.evaluations.length > 0) {
        measurement.overallStatus = summary.overallStatus;
        measurement.summary = summary;
        measurement.hasAlarm = summary.criticalCount > 0;
      } else {
        measurement.evaluateParameters();
      }

      entities.push(measurement);
    }

    // 3. Bulk INSERT in single transaction
    const saved = await this.repository.save(entities);

    // 4. Emit NATS events (non-blocking)
    if (this.eventBus) {
      for (const measurement of saved) {
        try {
          const createdEvent: WaterQualityMeasurementCreatedEvent = {
            eventId: randomUUID(),
            eventType: 'WaterQualityMeasurementCreated',
            tenantId,
            timestamp: new Date(),
            version: 1,
            measurementId: measurement.id,
            equipmentId: measurement.equipmentId ?? null,
            tankId: measurement.tankId ?? null,
            source: measurement.source,
            overallStatus: measurement.overallStatus,
            hasAlarm: measurement.hasAlarm,
            measuredBy: measurement.measuredBy ?? null,
            measuredAt: measurement.measuredAt.toISOString(),
            parameterCount: Object.keys(measurement.parameters || {}).length,
          };
          await this.eventBus.publish(createdEvent);

          // High-priority critical event for alert-service
          if (measurement.hasAlarm && measurement.summary?.evaluations) {
            const criticalParams = measurement.summary.evaluations
              .filter(e => e.status === ParameterStatus.CRITICAL_LOW || e.status === ParameterStatus.CRITICAL_HIGH)
              .map(e => ({
                code: e.parameter,
                name: e.parameter,
                value: e.value,
                threshold: e.status === ParameterStatus.CRITICAL_LOW ? (e.criticalMin ?? 0) : (e.criticalMax ?? 0),
                direction: (e.status === ParameterStatus.CRITICAL_LOW ? 'below' : 'above') as 'above' | 'below',
                unit: e.unit,
              }));

            if (criticalParams.length > 0) {
              const criticalEvent: WaterQualityCriticalEvent = {
                eventId: randomUUID(),
                eventType: 'WaterQualityCritical',
                tenantId,
                timestamp: new Date(),
                version: 1,
                measurementId: measurement.id,
                equipmentId: measurement.equipmentId ?? null,
                tankId: measurement.tankId ?? null,
                criticalParameters: criticalParams,
                measuredAt: measurement.measuredAt.toISOString(),
              };
              await this.eventBus.publish(criticalEvent);
            }
          }
        } catch (eventError) {
          this.logger.warn(`Failed to publish WQ event for measurement ${measurement.id}: ${(eventError as Error).message}`);
        }
      }
    }

    this.logger.log(`Created batch of ${saved.length} WQ measurements for tenant ${tenantId}`);
    return saved;
  }

  // -------------------------------------------------------------------------
  // READ
  // -------------------------------------------------------------------------

  /**
   * ID ile ölçüm getirir
   */
  async findById(tenantId: string, id: string): Promise<WaterQualityMeasurement> {
    const measurement = await this.repository.findOne({
      where: { id, tenantId },
      relations: ['tank'],
    });

    if (!measurement) {
      throw new NotFoundException(`Water quality measurement ${id} not found`);
    }

    return measurement;
  }

  /**
   * Tank için son ölçümü getirir
   */
  async findLatestByTank(tenantId: string, tankId: string): Promise<WaterQualityMeasurement | null> {
    return this.repository.findOne({
      where: { tenantId, tankId },
      order: { measuredAt: 'DESC' },
    });
  }

  /**
   * Filtreli liste getirir
   */
  async findAll(tenantId: string, filters: WaterQualityFilters = {}): Promise<WaterQualityListResult> {
    const {
      tankId,
      pondId,
      siteId,
      batchId,
      systemId,
      status,
      source,
      fromDate,
      toDate,
      limit = 50,
      offset = 0,
    } = filters;

    const where: FindOptionsWhere<WaterQualityMeasurement> = { tenantId };

    // System-level: find all tanks in the system, then filter by those tankIds
    if (systemId) {
      const tanks = await this.tankRepository.find({
        where: { tenantId, systemId } as FindOptionsWhere<Tank>,
        select: ['id'],
      });
      const tankIds = tanks.map(t => t.id);
      if (tankIds.length === 0) {
        return createStandardPaginatedResult([], 0, 1, limit);
      }
      where.tankId = In(tankIds);
    } else if (tankId) {
      where.tankId = tankId;
    }
    if (pondId) where.pondId = pondId;
    if (siteId) where.siteId = siteId;
    if (batchId) where.batchId = batchId;
    if (status) where.overallStatus = status;
    if (source) where.source = source;

    // Date range filtering
    if (fromDate && toDate) {
      where.measuredAt = Between(fromDate, toDate);
    } else if (fromDate) {
      where.measuredAt = MoreThanOrEqual(fromDate);
    } else if (toDate) {
      where.measuredAt = LessThanOrEqual(toDate);
    }

    const [items, total] = await this.repository.findAndCount({
      where,
      order: { measuredAt: 'DESC' },
      take: limit,
      skip: offset,
      relations: ['tank'],
    });

    const page = Math.floor(offset / limit) + 1;

    return createStandardPaginatedResult(items, total, page, limit);
  }

  /**
   * Tank için tüm ölçümleri getirir (grafik için)
   */
  async findByTankForChart(
    tenantId: string,
    tankId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<WaterQualityMeasurement[]> {
    return this.repository.find({
      where: {
        tenantId,
        tankId,
        measuredAt: Between(fromDate, toDate),
      },
      order: { measuredAt: 'ASC' },
      select: [
        'id',
        'measuredAt',
        'temperature',
        'dissolvedOxygen',
        'pH',
        'ammonia',
        'nitrite',
        'overallStatus',
      ],
    });
  }

  /**
   * Kritik durumda olan tank'ları bulur
   */
  async findCriticalTanks(tenantId: string): Promise<WaterQualityMeasurement[]> {
    // Her tank için son ölçümü al ve kritik olanları filtrele
    const subQuery = this.repository
      .createQueryBuilder('wq')
      .select('MAX(wq.measuredAt)', 'maxDate')
      .addSelect('wq.tankId', 'tankId')
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId IS NOT NULL')
      .groupBy('wq.tankId');

    return this.repository
      .createQueryBuilder('measurement')
      .innerJoin(
        `(${subQuery.getQuery()})`,
        'latest',
        'measurement.tankId = latest.tankId AND measurement.measuredAt = latest.maxDate',
      )
      .setParameters(subQuery.getParameters())
      .where('measurement.tenantId = :tenantId', { tenantId })
      .andWhere('measurement.overallStatus IN (:...statuses)', {
        statuses: [WaterQualityStatus.CRITICAL, WaterQualityStatus.WARNING],
      })
      .leftJoinAndSelect('measurement.tank', 'tank')
      .orderBy('measurement.overallStatus', 'ASC') // CRITICAL first
      .getMany();
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------

  /**
   * Ölçümü günceller
   */
  async update(
    tenantId: string,
    id: string,
    input: UpdateWaterQualityData,
  ): Promise<WaterQualityMeasurement> {
    const measurement = await this.findById(tenantId, id);

    if (input.parameters) {
      measurement.parameters = {
        ...measurement.parameters,
        ...input.parameters,
      };
    }

    if (input.notes !== undefined) {
      measurement.notes = input.notes;
    }

    if (input.weatherConditions !== undefined) {
      measurement.weatherConditions = input.weatherConditions;
    }

    // Dynamic config-driven evaluation (falls back to hardcoded if no configs)
    const summary = await this.evaluationService.evaluate(tenantId, measurement.parameters as unknown as Record<string, unknown>);
    if (summary.evaluations.length > 0) {
      measurement.overallStatus = summary.overallStatus;
      measurement.summary = summary;
      measurement.hasAlarm = summary.criticalCount > 0;
    } else {
      measurement.evaluateParameters();
    }

    return this.repository.save(measurement);
  }

  // -------------------------------------------------------------------------
  // DELETE
  // -------------------------------------------------------------------------

  /**
   * Ölçümü siler
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const measurement = await this.findById(tenantId, id);
    await this.repository.remove(measurement);
    this.logger.log(`Deleted water quality measurement ${id}`);
    return true;
  }

  // -------------------------------------------------------------------------
  // STATISTICS
  // -------------------------------------------------------------------------

  /**
   * Tank için istatistik özeti
   */
  async getTankStatistics(
    tenantId: string,
    tankId: string,
    days: number = 7,
  ): Promise<{
    avgTemperature: number | null;
    avgDO: number | null;
    avgPH: number | null;
    avgAmmonia: number | null;
    avgNitrite: number | null;
    measurementCount: number;
    criticalCount: number;
    warningCount: number;
    lastMeasurement: WaterQualityMeasurement | null;
  }> {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const stats = await this.repository
      .createQueryBuilder('wq')
      .select('AVG(wq.temperature)', 'avgTemperature')
      .addSelect('AVG(wq.dissolvedOxygen)', 'avgDO')
      .addSelect('AVG(wq.pH)', 'avgPH')
      .addSelect('AVG(wq.ammonia)', 'avgAmmonia')
      .addSelect('AVG(wq.nitrite)', 'avgNitrite')
      .addSelect('COUNT(*)', 'measurementCount')
      .addSelect(
        'SUM(CASE WHEN wq.overallStatus = :criticalStatus THEN 1 ELSE 0 END)',
        'criticalCount',
      )
      .addSelect(
        'SUM(CASE WHEN wq.overallStatus = :warningStatus THEN 1 ELSE 0 END)',
        'warningCount',
      )
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId = :tankId', { tankId })
      .andWhere('wq.measuredAt >= :fromDate', { fromDate })
      .setParameters({
        criticalStatus: WaterQualityStatus.CRITICAL,
        warningStatus: WaterQualityStatus.WARNING,
      })
      .getRawOne();

    const lastMeasurement = await this.findLatestByTank(tenantId, tankId);

    return {
      avgTemperature: stats.avgTemperature ? parseFloat(stats.avgTemperature) : null,
      avgDO: stats.avgDO ? parseFloat(stats.avgDO) : null,
      avgPH: stats.avgPH ? parseFloat(stats.avgPH) : null,
      avgAmmonia: stats.avgAmmonia ? parseFloat(stats.avgAmmonia) : null,
      avgNitrite: stats.avgNitrite ? parseFloat(stats.avgNitrite) : null,
      measurementCount: parseInt(stats.measurementCount) || 0,
      criticalCount: parseInt(stats.criticalCount) || 0,
      warningCount: parseInt(stats.warningCount) || 0,
      lastMeasurement,
    };
  }

  // -------------------------------------------------------------------------
  // SYSTEM-LEVEL QUERIES
  // -------------------------------------------------------------------------

  /**
   * Get chart data for all tanks in a system
   */
  async findBySystemForChart(
    tenantId: string,
    systemId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<WaterQualityMeasurement[]> {
    const tanks = await this.tankRepository.find({
      where: { tenantId, systemId } as FindOptionsWhere<Tank>,
      select: ['id'],
    });
    const tankIds = tanks.map(t => t.id);
    if (tankIds.length === 0) return [];

    return this.repository.find({
      where: {
        tenantId,
        tankId: In(tankIds),
        measuredAt: Between(fromDate, toDate),
      },
      order: { measuredAt: 'ASC' },
      select: ['id', 'measuredAt', 'tankId', 'temperature', 'dissolvedOxygen', 'pH', 'ammonia', 'nitrite', 'overallStatus', 'parameters'],
      relations: ['tank'],
    });
  }

  /**
   * Get aggregate statistics for all tanks in a system
   */
  async getSystemStatistics(
    tenantId: string,
    systemId: string,
    days: number = 7,
  ): Promise<{
    avgTemperature: number | null;
    avgDO: number | null;
    avgPH: number | null;
    avgAmmonia: number | null;
    avgNitrite: number | null;
    measurementCount: number;
    criticalCount: number;
    warningCount: number;
    lastMeasurement: WaterQualityMeasurement | null;
  }> {
    const tanks = await this.tankRepository.find({
      where: { tenantId, systemId } as FindOptionsWhere<Tank>,
      select: ['id'],
    });
    const tankIds = tanks.map(t => t.id);
    if (tankIds.length === 0) {
      return {
        avgTemperature: null, avgDO: null, avgPH: null,
        avgAmmonia: null, avgNitrite: null,
        measurementCount: 0, criticalCount: 0, warningCount: 0,
        lastMeasurement: null,
      };
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const stats = await this.repository
      .createQueryBuilder('wq')
      .select('AVG(wq.temperature)', 'avgTemperature')
      .addSelect('AVG(wq.dissolvedOxygen)', 'avgDO')
      .addSelect('AVG(wq.pH)', 'avgPH')
      .addSelect('AVG(wq.ammonia)', 'avgAmmonia')
      .addSelect('AVG(wq.nitrite)', 'avgNitrite')
      .addSelect('COUNT(*)', 'measurementCount')
      .addSelect("SUM(CASE WHEN wq.\"overallStatus\" = 'critical' THEN 1 ELSE 0 END)", 'criticalCount')
      .addSelect("SUM(CASE WHEN wq.\"overallStatus\" = 'warning' THEN 1 ELSE 0 END)", 'warningCount')
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId IN (:...tankIds)', { tankIds })
      .andWhere('wq.measuredAt >= :fromDate', { fromDate })
      .getRawOne();

    const lastMeasurement = await this.repository.findOne({
      where: { tenantId, tankId: In(tankIds) },
      order: { measuredAt: 'DESC' },
    });

    return {
      avgTemperature: stats?.avgTemperature ? parseFloat(stats.avgTemperature) : null,
      avgDO: stats?.avgDO ? parseFloat(stats.avgDO) : null,
      avgPH: stats?.avgPH ? parseFloat(stats.avgPH) : null,
      avgAmmonia: stats?.avgAmmonia ? parseFloat(stats.avgAmmonia) : null,
      avgNitrite: stats?.avgNitrite ? parseFloat(stats.avgNitrite) : null,
      measurementCount: parseInt(stats?.measurementCount) || 0,
      criticalCount: parseInt(stats?.criticalCount) || 0,
      warningCount: parseInt(stats?.warningCount) || 0,
      lastMeasurement,
    };
  }
}
