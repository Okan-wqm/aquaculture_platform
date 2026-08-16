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
import { Repository, DataSource, EntityManager } from 'typeorm';
import { Role, roleHasPermission } from '@aquaculture/backend-common/decorators';
import { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { OutboxPublisher } from '@platform/outbox';
import {
  WaterQualityMeasurementCreatedEvent,
  WaterQualityCriticalEvent,
  createBaseEvent,
} from '@platform/event-contracts';
import {
  WaterQualityMeasurement,
  WaterQualityStatus,
  MeasurementSource,
  ParameterStatus,
  type WaterQualitySummary,
} from './entities/water-quality-measurement.entity';
import { resolveTankSiteId, resolveUnitSiteIds } from '../batch/utils/tank-lookup.util';
import { Tank } from '../tank/entities/tank.entity';
import { WaterQualityEvaluationService } from './services/water-quality-evaluation.service';
import { WaterQualityValidationService } from './services/water-quality-validation.service';
import { CreateBatchWaterQualityInput } from './dto/create-batch-water-quality.input';
import {
  WATER_TEMPERATURE_MAX_C,
  WATER_TEMPERATURE_MIN_C,
} from './services/water-temperature.service';
import {
  mutationInstantDateV1,
  readTenantMutationInstantV1,
  runInTenantRead,
  runInTenantTransaction,
  type TenantMutationSession,
} from '@aquaculture/backend-common/database';
import { DayPlanRecalcService } from '../feeding-protocol/services/day-plan-recalc.service';

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

/**
 * SEC-HIGH-051: caller authz context for the object-level site check on WQ
 * create. Threaded from the resolver (JWT claims), never widening tenant scope.
 */
export interface WaterQualityCaller {
  sub: string;
  roles: Role[];
  assignedSiteIds?: string[];
}
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

interface WaterTemperatureRecalcCandidate {
  readonly unitId?: string;
  readonly temperature: unknown;
}

interface WaterTemperatureRecalcTarget {
  readonly unitId: string;
  readonly temperature: number;
}

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
    // SEC-HIGH-051: object-level site authorization SSoT (beneath the role gate).
    private readonly siteAuth: SiteAuthorizationService,
    // P-31/D-4: yeni manuel sıcaklık bugünkü beslenmemiş öğünleri AYNI tx'te
    // yeniden fiyatlar — ayrı yazma yolu AÇILMAZ, mevcut komutlar tetikler.
    private readonly dayPlanRecalc: DayPlanRecalcService,
  ) {}

  /**
   * Object-level site authorization for unit-list reads.
   *
   * Managers own cross-site scope. Every lower role must be assigned to every
   * requested unit's resolved site; an unknown unit/site is a denial rather
   * than an empty-temperature answer. The whole request is rejected if any
   * unit is outside scope so filtering cannot misrepresent authorization as
   * missing telemetry.
   */
  async assertUnitsSiteAuthorized(
    tenantId: string,
    unitIds: readonly string[],
    caller: WaterQualityCaller,
  ): Promise<void> {
    const uniqueUnitIds = [...new Set(unitIds)].sort();
    if (uniqueUnitIds.length === 0) return;
    if (caller.roles.some((role) => roleHasPermission(role, Role.MODULE_MANAGER))) return;

    const siteByUnit = await runInTenantRead(
      this.dataSource,
      'farm',
      tenantId,
      (queryRunner) => resolveUnitSiteIds(queryRunner.manager, uniqueUnitIds, tenantId),
    );
    for (const unitId of uniqueUnitIds) {
      this.siteAuth.assertSiteAssignment({ caller, siteId: siteByUnit.get(unitId) ?? null });
    }
  }

  /**
   * Record a single MANUAL water-temperature observation for a tank.
   *
   * A deliberately lighter path than `create()`: temperature is a standalone
   * reading that drives the feeding-rate calculation, so it is NOT put through
   * the full multi-parameter strict validation (which would reject unless
   * `temperature` is mapped to the equipment and every other required-mapped
   * parameter is also supplied). The measurement still lands in
   * `water_quality_measurements` (source MANUAL) so it appears in water-quality
   * history and is read back by WaterTemperatureService.
   */
  async recordManualTemperature(
    tenantId: string,
    tankId: string,
    celsius: number,
    recordedBy?: string,
  ): Promise<boolean> {
    if (
      !Number.isFinite(celsius) ||
      celsius < WATER_TEMPERATURE_MIN_C ||
      celsius > WATER_TEMPERATURE_MAX_C
    ) {
      throw new BadRequestException(
        `Water temperature ${celsius}°C is outside the plausible range ` +
          `(${WATER_TEMPERATURE_MIN_C}°C to ${WATER_TEMPERATURE_MAX_C}°C).`,
      );
    }

    const measurement = this.repository.create({
      tenantId,
      tankId,
      equipmentId: tankId,
      source: MeasurementSource.MANUAL,
      parameters: { temperature: celsius },
      temperature: celsius,
      measuredBy: recordedBy,
    });
    // Kayıt + gün içi recalc TEK transaction'da (P-31): yeni sıcaklık
    // çarpanı kalan öğünlere hemen yansır, yarını beklemez.
    await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const mutationInstant = await readTenantMutationInstantV1(mutationSession, 'farm');
        measurement.measuredAt = mutationInstantDateV1(mutationInstant);
        await queryRunner.manager.save(measurement);
        await this.dayPlanRecalc.recalcForUnit(
          queryRunner.manager,
          mutationSession,
          tenantId,
          tankId,
          'temperature',
          { mutationInstant, newTemperatureC: celsius },
        );
      },
    );
    return true;
  }

  /**
   * SEC-HIGH-051: resolve the site a water-quality measurement belongs to.
   *
   * A direct `siteId` wins (the measurement is explicitly site-scoped). Else a
   * `tankId` resolves via Department.siteId. A pond-only measurement has no Site
   * linkage in this schema (Pond -> Farm, not Site), so it resolves to `null`
   * and the fail-closed deny restricts pond WQ to MODULE_MANAGER+ — the correct
   * conservative posture (NEVER an implicit allow on an unresolved site).
   */
  private async resolveMeasurementSiteId(
    manager: EntityManager,
    input: Pick<CreateWaterQualityData, 'siteId' | 'tankId'>,
    tenantId: string,
  ): Promise<string | null> {
    if (input.siteId) {
      return input.siteId;
    }
    if (input.tankId) {
      // Reuse the ONE tank site-resolver (checks equipment + legacy tanks tables
      // → Department.siteId) so equipment-table tanks resolve too.
      return resolveTankSiteId(manager, input.tankId, tenantId);
    }
    return null;
  }

  /**
   * One temperature-to-feeding boundary for every water-quality write shape.
   *
   * Batch input can contain several parameters for one equipment. Repricing the
   * same unit twice would make the result depend on array order and would also
   * acquire the aggregate locks more than once. Compile one deterministic,
   * unit-sorted target set instead. Two different temperatures for the same
   * unit at the same batch timestamp are ambiguous and therefore rejected.
   */
  private compileTemperatureTargets(
    candidates: readonly WaterTemperatureRecalcCandidate[],
  ): readonly WaterTemperatureRecalcTarget[] {
    const targets = new Map<string, number>();
    for (const candidate of candidates) {
      if (!candidate.unitId || typeof candidate.temperature !== 'number') continue;

      const existing = targets.get(candidate.unitId);
      if (existing !== undefined && existing !== candidate.temperature) {
        throw new BadRequestException(
          `Batch contains conflicting temperatures for feeding unit ${candidate.unitId}`,
        );
      }
      targets.set(candidate.unitId, candidate.temperature);
    }
    return [...targets]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([unitId, temperature]) => ({ unitId, temperature }));
  }

  private async recalcTemperatureTargets(
    manager: EntityManager,
    mutationSession: TenantMutationSession,
    tenantId: string,
    targets: readonly WaterTemperatureRecalcTarget[],
  ): Promise<void> {
    if (targets.length === 0) return;

    const mutationInstant = await readTenantMutationInstantV1(mutationSession, 'farm');
    for (const { unitId, temperature } of targets) {
      await this.dayPlanRecalc.recalcForUnit(
        manager,
        mutationSession,
        tenantId,
        unitId,
        'temperature',
        { mutationInstant, newTemperatureC: temperature },
      );
    }
  }

  /** Measurement events share the same transactional outbox authority. */
  private async enqueueMeasurementEvents(
    manager: EntityManager,
    tenantId: string,
    measurement: WaterQualityMeasurement,
  ): Promise<void> {
    const createdEvent: WaterQualityMeasurementCreatedEvent = {
      ...createBaseEvent<WaterQualityMeasurementCreatedEvent>(
        'WaterQualityMeasurementCreated',
        tenantId,
      ),
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
    await this.outboxPublisher.enqueue(createdEvent, manager);

    if (!measurement.hasAlarm || !measurement.summary?.evaluations) return;
    const criticalParams = measurement.summary.evaluations
      .filter(
        (evaluation) =>
          evaluation.status === ParameterStatus.CRITICAL_LOW ||
          evaluation.status === ParameterStatus.CRITICAL_HIGH,
      )
      .map((evaluation) => ({
        code: evaluation.parameter,
        name: evaluation.parameter,
        value: evaluation.value,
        threshold:
          evaluation.status === ParameterStatus.CRITICAL_LOW
            ? (evaluation.criticalMin ?? 0)
            : (evaluation.criticalMax ?? 0),
        direction: (evaluation.status === ParameterStatus.CRITICAL_LOW ? 'below' : 'above') as
          | 'above'
          | 'below',
        unit: evaluation.unit,
      }));
    if (criticalParams.length === 0) return;

    const criticalEvent: WaterQualityCriticalEvent = {
      ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantId),
      measurementId: measurement.id,
      equipmentId: measurement.equipmentId ?? null,
      tankId: measurement.tankId ?? null,
      criticalParametersJson: JSON.stringify(criticalParams),
      criticalParameterCount: criticalParams.length,
      measuredAt: measurement.measuredAt.toISOString(),
    };
    await this.outboxPublisher.enqueue(criticalEvent, manager);
  }

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
  async create(
    tenantId: string,
    input: CreateWaterQualityData,
    caller: WaterQualityCaller,
  ): Promise<WaterQualityMeasurement> {
    this.logger.log(`Creating water quality measurement for tenant ${tenantId}`);

    // C3: Idempotency check — return existing if same key within recent window
    if (input.idempotencyKey) {
      const existing = await this.repository.findOne({
        where: { tenantId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        this.logger.debug(
          `Idempotent hit: returning existing measurement ${existing.id} for key ${input.idempotencyKey}`,
        );
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
    const saved = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        // SEC-HIGH-051: object-level site authorization. Resolve the measurement's
        // site inside the transaction and assert the caller is assigned to it
        // BEFORE persisting. MODULE_MANAGER+ bypasses; an unresolved site (e.g. a
        // pond-only measurement, or a site-less department) for a MODULE_USER is
        // DENIED — never an implicit allow.
        const measurementSiteId = await this.resolveMeasurementSiteId(
          queryRunner.manager,
          { siteId: input.siteId, tankId: input.tankId },
          tenantId,
        );
        this.siteAuth.assertSiteAssignment({ caller, siteId: measurementSiteId });

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

        const saved = await queryRunner.manager.save(WaterQualityMeasurement, measurement);

        await this.enqueueMeasurementEvents(queryRunner.manager, tenantId, saved);
        await this.recalcTemperatureTargets(
          queryRunner.manager,
          mutationSession,
          tenantId,
          this.compileTemperatureTargets([
            {
              unitId: saved.tankId ?? saved.equipmentId,
              temperature: saved.temperature ?? saved.parameters?.temperature,
            },
          ]),
        );

        return saved;
      },
    );

    this.logger.log(
      `Created water quality measurement ${saved.id} with status ${saved.overallStatus}`,
    );
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
    caller: WaterQualityCaller,
  ): Promise<WaterQualityMeasurement[]> {
    const userId = caller.sub;
    this.logger.log(
      `Creating batch of ${input.measurements.length} WQ measurements for tenant ${tenantId}`,
    );

    // 1. Validate ALL items first (fail-fast, before transaction)
    for (const item of input.measurements) {
      const result = await this.validationService.validate(
        tenantId,
        item.dynamicParameters,
        item.equipmentId,
      );
      if (!result.valid) {
        throw new BadRequestException({
          message: `Validation failed for equipment ${item.equipmentId}`,
          errors: result.errors,
        });
      }
    }
    const temperatureTargets = this.compileTemperatureTargets(
      input.measurements.map((measurement) => ({
        unitId: measurement.equipmentId,
        temperature: measurement.dynamicParameters['temperature'],
      })),
    );

    // 2. Pre-evaluate thresholds (no DB writes, safe outside transaction)
    const evaluations: WaterQualitySummary[] = [];
    for (const item of input.measurements) {
      const summary = await this.evaluationService.evaluate(
        tenantId,
        item.dynamicParameters as WaterQualityMeasurement['parameters'],
      );
      evaluations.push(summary);
    }

    // 3. One tenant mutation session owns bulk INSERT, outbox and every
    // temperature-driven feeding aggregate mutation.
    const saved = await runInTenantTransaction(
      this.dataSource,
      'farm',
      tenantId,
      async (queryRunner, mutationSession) => {
        const entities: WaterQualityMeasurement[] = [];
        for (let i = 0; i < input.measurements.length; i++) {
          const item = input.measurements[i]!;
          const summary = evaluations[i]!;

          // SEC-HIGH-051: object-level site authorization PER measurement. A batch
          // is keyed by equipmentId (a tank/equipment id) → Department.siteId.
          // MODULE_MANAGER+ bypasses; an unresolved site for a MODULE_USER DENIES
          // the whole batch (the transaction rolls back) — never an implicit allow.
          const itemSiteId = await this.resolveMeasurementSiteId(
            queryRunner.manager,
            { tankId: item.equipmentId },
            tenantId,
          );
          this.siteAuth.assertSiteAssignment({ caller, siteId: itemSiteId });

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

        const persisted = await queryRunner.manager.save(WaterQualityMeasurement, entities);

        // Enqueue outbox events for each measurement (inside the same transaction)
        for (const measurement of persisted) {
          await this.enqueueMeasurementEvents(queryRunner.manager, tenantId, measurement);
        }
        await this.recalcTemperatureTargets(
          queryRunner.manager,
          mutationSession,
          tenantId,
          temperatureTargets,
        );
        return persisted;
      },
    );

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
}
