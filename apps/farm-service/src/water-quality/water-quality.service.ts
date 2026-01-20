/**
 * WaterQuality Service
 *
 * Su kalitesi ölçümleri CRUD işlemleri.
 * Tank/batch bazlı sorgulama ve değerlendirme.
 *
 * @module WaterQuality
 */
import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { WaterQualityMeasurement, WaterQualityStatus, MeasurementSource } from './entities/water-quality-measurement.entity';

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
  parameters: {
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
  status?: WaterQualityStatus;
  source?: MeasurementSource;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  offset?: number;
}

export interface WaterQualityListResult {
  items: WaterQualityMeasurement[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
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
  ) {}

  // -------------------------------------------------------------------------
  // CREATE
  // -------------------------------------------------------------------------

  /**
   * Yeni su kalitesi ölçümü oluşturur
   */
  async create(tenantId: string, input: CreateWaterQualityData): Promise<WaterQualityMeasurement> {
    this.logger.log(`Creating water quality measurement for tenant ${tenantId}`);

    const measurement = this.repository.create({
      tenantId,
      tankId: input.tankId,
      pondId: input.pondId,
      siteId: input.siteId,
      batchId: input.batchId,
      measuredAt: input.measuredAt,
      source: input.source,
      measuredBy: input.measuredBy,
      parameters: input.parameters,
      notes: input.notes,
      weatherConditions: input.weatherConditions,
      overallStatus: WaterQualityStatus.UNKNOWN,
      hasAlarm: false,
    });

    // Parametreleri değerlendir
    measurement.evaluateParameters();

    const saved = await this.repository.save(measurement);
    this.logger.log(`Created water quality measurement ${saved.id} with status ${saved.overallStatus}`);

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
      status,
      source,
      fromDate,
      toDate,
      limit = 50,
      offset = 0,
    } = filters;

    const where: FindOptionsWhere<WaterQualityMeasurement> = { tenantId };

    if (tankId) where.tankId = tankId;
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

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
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

    // Yeniden değerlendir
    measurement.evaluateParameters();

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
        `SUM(CASE WHEN wq.overallStatus = '${WaterQualityStatus.CRITICAL}' THEN 1 ELSE 0 END)`,
        'criticalCount',
      )
      .addSelect(
        `SUM(CASE WHEN wq.overallStatus = '${WaterQualityStatus.WARNING}' THEN 1 ELSE 0 END)`,
        'warningCount',
      )
      .where('wq.tenantId = :tenantId', { tenantId })
      .andWhere('wq.tankId = :tankId', { tankId })
      .andWhere('wq.measuredAt >= :fromDate', { fromDate })
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
}
