/**
 * WaterQuality Service
 *
 * Su kalitesi ölçümleri CRUD işlemleri.
 * Tank/batch bazlı sorgulama ve değerlendirme.
 *
 * LIFE-SAFETY: Water quality events (WaterQualityMeasurementCreated,
 * WaterQualityCritical) are now published via OutboxPublisher inside
 * QueryRunner transactions. If NATS is temporarily unavailable, events
 * are durably stored in the outbox table and delivered by the outbox
 * worker — no silent event loss. Lost critical alerts directly impact
 * fish mortality risk.
 *
 * Migration: NatsEventBus (fire-and-forget) -> OutboxPublisher (transactional).
 *
 * @module WaterQuality
 */
import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import { IStandardPaginatedResult, createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { OutboxPublisher } from '@platform/outbox';
import { WaterQualityMeasurementCreatedEvent, WaterQualityCriticalEvent , createBaseEvent } from '@platform/event-contracts';
import { WaterQualityMeasurement, WaterQualityStatus, MeasurementSource, ParameterStatus } from './entities/water-quality-measurement.entity';
import { Tank } from '../tank/entities/tank.entity';
import { WaterQualityEvaluationService } from './services/water-quality-evaluation.service';
import { WaterQualityValidationService } from './services/water-quality-validation.service';
import { CreateBatchWaterQualityInput } from './dto/create-batch-water-quality.input';

// ============================================================================
// INTERNAL INTERFACES (Service layer only)
// ============================================================================

/**
 * SINGLE-INGRESS (Tier-1): `dynamicParameters` + `equipmentId` are the sole
 * parameter channel. The legacy static `parameters` shape was removed from the
 * DTO and from this service interface so there is no code path that can persist
 * measurement values without first passing through
 * WaterQualityValidationService.validate().
 */
export interface CreateWaterQualityData {
  tankId?: string;
  pondId?: string;
  siteId?: string;
  batchId?: string;
  measuredAt: Date;
  source: MeasurementSource;
  measuredBy?: string;
  equipmentId: string;
  dynamicParameters: Record<string, number | string | boolean>;
  idempotencyKey?: string;
  notes?: string;
  weatherConditions?: string;
  /**
   * Phase 7.4 — sensor-service `sensor_readings` UUID that this WQ
   * measurement was derived from. Null for manual / bulk-imported.
   */
  relatedSensorReadingId?: string;
}

export interface UpdateWaterQualityData {
  dynamicParameters?: Record<string, number | string | boolean>;
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
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Yeni su kalitesi ölçümü oluşturur.
   *
   * LIFE-SAFETY: Measurement + outbox events are written in a single
   * QueryRunner transaction. If NATS is temporarily unavailable the events
   * persist in the outbox table and are delivered by the outbox worker.
   * Fire-and-forget eventBus.publish() was removed — it silently dropped
   * critical alerts when NATS was down, risking undetected fish mortality.
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

    // SINGLE-INGRESS (Tier-1): validation runs UNCONDITIONALLY on every create.
    // dynamicParameters is the sole parameter channel; strict mode rejects
    // empty-with-keys submissions and no-config tenants. There is no legacy
    // bypass branch — every value persisted has passed validate().
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

    const mergedParameters = { ...input.dynamicParameters };

    // Config-driven evaluation is the SOLE evaluator (the entity's hardcoded
    // evaluateParameters() was removed). Done before the transaction to avoid
    // holding a DB lock during evaluation.
    const summary = await this.evaluationService.evaluate(tenantId, mergedParameters);

    // ── Transaction: measurement save + outbox event(s) ───────────────
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: WaterQualityMeasurement;
    try {
      const measurement = queryRunner.manager.create(WaterQualityMeasurement, {
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
        // Phase 7.4: cross-service correlation pointer to the
        // sensor_readings row in sensor-service that produced this
        // measurement. Null for manual entries.
        relatedSensorReadingId: input.relatedSensorReadingId,
        overallStatus: WaterQualityStatus.UNKNOWN,
        hasAlarm: false,
      });

      // Config-driven evaluation is the SOLE evaluator. When strict validation
      // passed, configs exist by construction, so summary.evaluations is
      // populated. The measurement retains UNKNOWN status only when configs
      // legitimately yield no numeric evaluations (e.g. enum/boolean-only sets).
      if (summary.evaluations.length > 0) {
        measurement.overallStatus = summary.overallStatus;
        measurement.summary = summary;
        measurement.hasAlarm = summary.criticalCount > 0;
      }

      saved = await queryRunner.manager.save(WaterQualityMeasurement, measurement);

      // LIFE-SAFETY: Enqueue WaterQualityMeasurementCreatedEvent into the
      // transactional outbox BEFORE commit. Guaranteed delivery via outbox worker.
      const createdEvent: WaterQualityMeasurementCreatedEvent = {
        ...createBaseEvent<WaterQualityMeasurementCreatedEvent>('WaterQualityMeasurementCreated', tenantId),
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
      await this.outboxPublisher.enqueue(createdEvent, queryRunner.manager);

      // LIFE-SAFETY: Critical alert event for alert-service — if parameters are
      // in critical range, fish mortality risk is imminent. This event MUST be
      // delivered reliably via outbox, not fire-and-forget.
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
            ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantId),
            measurementId: saved.id,
            equipmentId: saved.equipmentId ?? null,
            tankId: saved.tankId ?? null,
            criticalParametersJson: JSON.stringify(criticalParams),
            criticalParameterCount: criticalParams.length,
            measuredAt: saved.measuredAt.toISOString(),
          };
          await this.outboxPublisher.enqueue(criticalEvent, queryRunner.manager);
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    this.logger.log(`Created water quality measurement ${saved.id} with status ${saved.overallStatus}`);
    return saved;
  }

  // -------------------------------------------------------------------------
  // BATCH CREATE
  // -------------------------------------------------------------------------

  /**
   * Batch creation of water quality measurements for multiple equipment.
   * Validates all items first (fail-fast), then bulk inserts + outbox events
   * in a single QueryRunner transaction.
   *
   * LIFE-SAFETY: All measurement events are enqueued in the transactional
   * outbox. A NATS outage cannot silently drop critical water quality alerts.
   */
  async createBatch(
    tenantId: string,
    input: CreateBatchWaterQualityInput,
    userId: string,
  ): Promise<WaterQualityMeasurement[]> {
    this.logger.log(`Creating batch of ${input.measurements.length} WQ measurements for tenant ${tenantId}`);

    // 1. Validate ALL items first (fail-fast, before transaction)
    for (const item of input.measurements) {
      const result = await this.validationService.validate(tenantId, item.dynamicParameters, item.equipmentId);
      if (!result.valid) {
        throw new BadRequestException({
          message: `Validation failed for equipment ${item.equipmentId}`,
          errors: result.errors,
        });
      }
    }

    // 2. Pre-evaluate thresholds (no DB writes, safe outside transaction)
    const evaluations = [];
    for (const item of input.measurements) {
      const summary = await this.evaluationService.evaluate(
        tenantId,
        item.dynamicParameters as WaterQualityMeasurement['parameters'],
      );
      evaluations.push(summary);
    }

    // 3. Transaction: bulk INSERT measurements + enqueue outbox events
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    let saved: WaterQualityMeasurement[];
    try {
      const entities: WaterQualityMeasurement[] = [];
      for (let i = 0; i < input.measurements.length; i++) {
        const item = input.measurements[i]!;
        const summary = evaluations[i]!;

        const measurement = queryRunner.manager.create(WaterQualityMeasurement, {
          tenantId,
          equipmentId: item.equipmentId,
          measuredAt: input.measuredAt,
          source: input.source,
          measuredBy: userId,
          parameters: item.dynamicParameters as WaterQualityMeasurement['parameters'],
          notes: item.notes,
          idempotencyKey: item.idempotencyKey,
          overallStatus: WaterQualityStatus.UNKNOWN,
          hasAlarm: false,
        });

        // Config-driven evaluation is the SOLE evaluator (the entity's
        // hardcoded evaluateParameters() was removed). Batch items are
        // validate()-gated above, so configs exist; UNKNOWN remains only when
        // the config set yields no numeric evaluations.
        if (summary.evaluations.length > 0) {
          measurement.overallStatus = summary.overallStatus;
          measurement.summary = summary;
          measurement.hasAlarm = summary.criticalCount > 0;
        }

        entities.push(measurement);
      }

      saved = await queryRunner.manager.save(WaterQualityMeasurement, entities);

      // Enqueue outbox events for each measurement (inside the same transaction)
      for (const measurement of saved) {
        const createdEvent: WaterQualityMeasurementCreatedEvent = {
          ...createBaseEvent<WaterQualityMeasurementCreatedEvent>('WaterQualityMeasurementCreated', tenantId),
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
        await this.outboxPublisher.enqueue(createdEvent, queryRunner.manager);

        // LIFE-SAFETY: Critical alert event for alert-service
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
            // ARCH-C01: Serialize criticalParameters to JSON string — flat-object contract
            const criticalEvent: WaterQualityCriticalEvent = {
              ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantId),
              measurementId: measurement.id,
              equipmentId: measurement.equipmentId ?? null,
              tankId: measurement.tankId ?? null,
              criticalParametersJson: JSON.stringify(criticalParams),
              criticalParameterCount: criticalParams.length,
              measuredAt: measurement.measuredAt.toISOString(),
            };
            await this.outboxPublisher.enqueue(criticalEvent, queryRunner.manager);
          }
        }
      }

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
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

    if (input.dynamicParameters) {
      // SINGLE-INGRESS (Tier-1): merge the incoming dynamic parameters onto the
      // existing measurement, then validate the MERGED set against the
      // measurement's stored equipment mappings BEFORE persisting — identical
      // strict gate to create. Rejects on !valid exactly like create.
      const mergedParameters = {
        ...measurement.parameters,
        ...input.dynamicParameters,
      };

      const validation = await this.validationService.validate(
        tenantId,
        mergedParameters as Record<string, number | string | boolean>,
        measurement.equipmentId,
      );
      if (!validation.valid) {
        throw new BadRequestException({
          message: 'Dynamic parameter validation failed',
          errors: validation.errors,
        });
      }

      measurement.parameters = mergedParameters;
    }

    if (input.notes !== undefined) {
      measurement.notes = input.notes;
    }

    if (input.weatherConditions !== undefined) {
      measurement.weatherConditions = input.weatherConditions;
    }

    // Config-driven evaluation is the SOLE evaluator (the entity's hardcoded
    // evaluateParameters() was removed). UNKNOWN remains only when the config
    // set yields no numeric evaluations.
    const summary = await this.evaluationService.evaluate(tenantId, measurement.parameters);
    if (summary.evaluations.length > 0) {
      measurement.overallStatus = summary.overallStatus;
      measurement.summary = summary;
      measurement.hasAlarm = summary.criticalCount > 0;
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
