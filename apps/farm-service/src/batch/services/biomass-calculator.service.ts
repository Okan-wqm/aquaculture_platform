/**
 * Biomass Calculator Service
 *
 * Biyokütle hesaplamalarını yapar.
 * Biomass (kg) = Quantity * Average Weight (g) / 1000
 *
 * @module Batch/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from '../entities/batch.entity';
import { TankBatch } from '../entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';

/**
 * Biomass hesaplama sonucu
 */
export interface BiomassResult {
  biomassKg: number;
  quantity: number;
  avgWeightG: number;
  method: 'calculated' | 'measured' | 'estimated';
  confidence: 'high' | 'medium' | 'low';
  lastMeasurementDate?: Date;
}

/**
 * Tank yoğunluk analizi
 */
export interface TankDensityAnalysis {
  tankId: string;
  tankCode: string;
  volumeM3: number;
  currentBiomassKg: number;
  currentDensityKgM3: number;
  maxDensityKgM3: number;
  optimalDensityMinKgM3: number;
  optimalDensityMaxKgM3: number;
  utilizationPercent: number;
  status: 'optimal' | 'low' | 'high' | 'critical';
  recommendation?: string;
}

/**
 * Site toplam biyokütle
 */
export interface SiteBiomassReport {
  siteId: string;
  siteName: string;
  totalBiomassKg: number;
  totalQuantity: number;
  avgWeightG: number;
  batchCount: number;
  tankCount: number;
  speciesBreakdown: {
    speciesId: string;
    speciesName: string;
    biomassKg: number;
    quantity: number;
    percentage: number;
  }[];
}

/**
 * Biyokütle projeksiyonu
 */
export interface BiomassProjection {
  currentBiomassKg: number;
  projectedBiomassKg: number;
  daysForward: number;
  projectedDate: Date;
  dailyGrowthKg: number;
  assumptions: {
    survivalRate: number;
    dailyGrowthG: number;
    fcr: number;
  };
}

@Injectable()
export class BiomassCalculatorService {
  private readonly logger = new Logger(BiomassCalculatorService.name);

  constructor(
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(TankBatch)
    private readonly tankBatchRepository: Repository<TankBatch>,
    @InjectRepository(Tank)
    private readonly tankRepository: Repository<Tank>,
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
  ) {}

  /**
   * Temel biomass hesaplama
   */
  calculateBiomass(quantity: number, avgWeightG: number): number {
    if (quantity <= 0 || avgWeightG <= 0) return 0;
    return (quantity * avgWeightG) / 1000;
  }

  /**
   * Batch için güncel biomass hesaplar
   */
  async getBatchBiomass(batchId: string, tenantId: string): Promise<BiomassResult> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      throw new Error(`Batch ${batchId} bulunamadı`);
    }

    // Son ölçümü kontrol et
    const latestMeasurement = await this.measurementRepository.findOne({
      where: { tenantId, batchId },
      order: { measurementDate: 'DESC' },
    });

    const quantity = batch.currentQuantity;
    let avgWeightG: number;
    let method: BiomassResult['method'];
    let confidence: BiomassResult['confidence'];
    let lastMeasurementDate: Date | undefined;

    if (latestMeasurement) {
      const daysSinceMeasurement = this.daysBetween(latestMeasurement.measurementDate, new Date());

      if (daysSinceMeasurement <= 7) {
        // Son 7 gün içinde ölçüm var - yüksek güven
        avgWeightG = latestMeasurement.averageWeight;
        method = 'measured';
        confidence = 'high';
        lastMeasurementDate = latestMeasurement.measurementDate;
      } else if (daysSinceMeasurement <= 21) {
        // 7-21 gün arası - tahmini büyüme ile güncelle
        const dailyGrowth = batch.species?.growthParameters?.avgDailyGrowth || 1;
        avgWeightG = latestMeasurement.averageWeight + (dailyGrowth * daysSinceMeasurement);
        method = 'estimated';
        confidence = 'medium';
        lastMeasurementDate = latestMeasurement.measurementDate;
      } else {
        // 21 günden eski - düşük güven
        const dailyGrowth = batch.species?.growthParameters?.avgDailyGrowth || 1;
        avgWeightG = latestMeasurement.averageWeight + (dailyGrowth * daysSinceMeasurement);
        method = 'estimated';
        confidence = 'low';
        lastMeasurementDate = latestMeasurement.measurementDate;
      }
    } else {
      // Hiç ölçüm yok - batch ağırlığını kullan
      avgWeightG = batch.getCurrentAvgWeight();
      method = 'calculated';
      confidence = 'low';
    }

    const biomassKg = this.calculateBiomass(quantity, avgWeightG);

    return {
      biomassKg,
      quantity,
      avgWeightG,
      method,
      confidence,
      lastMeasurementDate,
    };
  }

  /**
   * Tank yoğunluk analizi yapar
   */
  async analyzeTankDensity(tankId: string, tenantId: string): Promise<TankDensityAnalysis> {
    const tank = await this.tankRepository.findOne({
      where: { id: tankId, tenantId, isActive: true },
    });

    if (!tank) {
      throw new Error(`Tank ${tankId} bulunamadı`);
    }

    // TankBatch'i bul
    const tankBatch = await this.tankBatchRepository.findOne({
      where: { tenantId, tankId },
    });

    const currentBiomassKg = tankBatch?.currentBiomassKg ?? tankBatch?.totalBiomassKg ?? 0;
    const volumeM3 = Number(tank.waterVolume || tank.volume) || 1;
    const currentDensityKgM3 = currentBiomassKg / volumeM3;

    const maxDensityKgM3 = Number(tank.maxDensity) || 25;
    // Tank entity'de optimal density property'leri yok, default değerler kullanıyoruz
    const optimalDensityMinKgM3 = maxDensityKgM3 * 0.4; // %40
    const optimalDensityMaxKgM3 = maxDensityKgM3 * 0.8; // %80

    const utilizationPercent = (currentDensityKgM3 / maxDensityKgM3) * 100;

    // Status belirleme
    let status: TankDensityAnalysis['status'];
    let recommendation: string | undefined;

    if (currentDensityKgM3 >= maxDensityKgM3) {
      status = 'critical';
      recommendation = 'ACİL: Tank kapasitesi aşıldı. Transfer veya hasat yapılmalı.';
    } else if (currentDensityKgM3 > optimalDensityMaxKgM3) {
      status = 'high';
      recommendation = 'Yoğunluk optimal aralığın üzerinde. Yakın zamanda transfer planlanmalı.';
    } else if (currentDensityKgM3 < optimalDensityMinKgM3 && currentDensityKgM3 > 0) {
      status = 'low';
      recommendation = 'Yoğunluk düşük. Daha fazla balık transfer edilebilir.';
    } else {
      status = 'optimal';
    }

    return {
      tankId,
      tankCode: tank.code,
      volumeM3,
      currentBiomassKg,
      currentDensityKgM3,
      maxDensityKgM3,
      optimalDensityMinKgM3,
      optimalDensityMaxKgM3,
      utilizationPercent,
      status,
      recommendation,
    };
  }

  /**
   * Site için toplam biyokütle raporu
   * Site'daki department'lar üzerinden tank'lara ulaşır
   *
   * OPTIMIZED: N+1 query problemi düzeltildi
   * - Tüm batch'ler ve measurements tek sorguda alınıyor
   * - JavaScript'te filtreleme yerine SQL IN clause kullanılıyor
   */
  async getSiteBiomassReport(siteId: string, tenantId: string): Promise<SiteBiomassReport> {
    // Site'daki tank'ları department'lar üzerinden bul
    // Tank -> Department -> Site ilişkisi var
    const tanks = await this.tankRepository
      .createQueryBuilder('tank')
      .innerJoin('tank.department', 'department')
      .where('tank.tenantId = :tenantId', { tenantId })
      .andWhere('department.siteId = :siteId', { siteId })
      .andWhere('tank.isActive = true')
      .getMany();

    const tankIds = tanks.map(t => t.id);

    if (tankIds.length === 0) {
      return {
        siteId,
        siteName: '',
        totalBiomassKg: 0,
        totalQuantity: 0,
        avgWeightG: 0,
        batchCount: 0,
        tankCount: 0,
        speciesBreakdown: [],
      };
    }

    // Bu tank'lardaki TankBatch'leri bul
    const tankBatches = await this.tankBatchRepository
      .createQueryBuilder('tb')
      .where('tb.tenantId = :tenantId', { tenantId })
      .andWhere('tb.tankId IN (:...tankIds)', { tankIds })
      .getMany();

    // Unique batch ID'lerini topla
    const batchIds = new Set<string>();
    for (const tb of tankBatches) {
      if (tb.primaryBatchId) batchIds.add(tb.primaryBatchId);
      if (tb.batchDetails) {
        for (const detail of tb.batchDetails) {
          batchIds.add(detail.batchId);
        }
      }
    }

    if (batchIds.size === 0) {
      return {
        siteId,
        siteName: '',
        totalBiomassKg: 0,
        totalQuantity: 0,
        avgWeightG: 0,
        batchCount: 0,
        tankCount: tankBatches.length,
        speciesBreakdown: [],
      };
    }

    // OPTIMIZED: Batch'leri doğrudan ID filtresi ile al (JavaScript filtresi yerine SQL)
    const batches = await this.batchRepository
      .createQueryBuilder('batch')
      .leftJoinAndSelect('batch.species', 'species')
      .where('batch.id IN (:...batchIds)', { batchIds: Array.from(batchIds) })
      .andWhere('batch.tenantId = :tenantId', { tenantId })
      .andWhere('batch.isActive = true')
      .getMany();

    // OPTIMIZED: Tüm batch'ler için son ölçümleri tek sorguda al (N+1 eliminasyonu)
    const latestMeasurements = await this.measurementRepository
      .createQueryBuilder('m')
      .select([
        'm.batchId',
        'm.averageWeight',
        'm.measurementDate',
      ])
      .where('m.tenantId = :tenantId', { tenantId })
      .andWhere('m.batchId IN (:...batchIds)', { batchIds: Array.from(batchIds) })
      .andWhere((qb) => {
        // Subquery: Her batch için en son ölçüm tarihini bul
        const subQuery = qb.subQuery()
          .select('MAX(m2.measurementDate)')
          .from(GrowthMeasurement, 'm2')
          .where('m2.batchId = m.batchId')
          .andWhere('m2.tenantId = :tenantId')
          .getQuery();
        return `m.measurementDate = ${subQuery}`;
      })
      .getRawMany();

    // Measurement'ları batchId'ye göre map'le
    const measurementMap = new Map<string, { averageWeight: number; measurementDate: Date }>();
    for (const m of latestMeasurements) {
      measurementMap.set(m.m_batchId, {
        averageWeight: Number(m.m_averageWeight),
        measurementDate: new Date(m.m_measurementDate),
      });
    }

    let totalBiomassKg = 0;
    let totalQuantity = 0;
    const speciesMap = new Map<string, {
      speciesId: string;
      speciesName: string;
      biomassKg: number;
      quantity: number;
    }>();

    const now = new Date();

    // OPTIMIZED: Loop içinde database çağrısı yok
    for (const batch of batches) {
      const quantity = batch.currentQuantity;
      let avgWeightG: number;

      const measurement = measurementMap.get(batch.id);
      if (measurement) {
        const daysSinceMeasurement = this.daysBetween(measurement.measurementDate, now);

        if (daysSinceMeasurement <= 7) {
          avgWeightG = measurement.averageWeight;
        } else {
          // Tahmini büyüme ile güncelle
          const dailyGrowth = batch.species?.growthParameters?.avgDailyGrowth || 1;
          avgWeightG = measurement.averageWeight + (dailyGrowth * daysSinceMeasurement);
        }
      } else {
        // Hiç ölçüm yok - batch ağırlığını kullan
        avgWeightG = batch.getCurrentAvgWeight();
      }

      const biomassKg = this.calculateBiomass(quantity, avgWeightG);

      totalBiomassKg += biomassKg;
      totalQuantity += quantity;

      const speciesId = batch.speciesId;
      const speciesName = batch.species?.commonName || batch.species?.scientificName || 'Unknown';

      const existing = speciesMap.get(speciesId);
      if (existing) {
        existing.biomassKg += biomassKg;
        existing.quantity += quantity;
      } else {
        speciesMap.set(speciesId, {
          speciesId,
          speciesName,
          biomassKg,
          quantity,
        });
      }
    }

    const avgWeightG = totalQuantity > 0 ? (totalBiomassKg * 1000) / totalQuantity : 0;

    // Tür dağılımı
    const speciesBreakdown = Array.from(speciesMap.values()).map(s => ({
      ...s,
      percentage: totalBiomassKg > 0 ? (s.biomassKg / totalBiomassKg) * 100 : 0,
    }));

    // Tank sayısı
    const tankCount = tankBatches.length;

    return {
      siteId,
      siteName: '', // Site entity'den alınacak
      totalBiomassKg,
      totalQuantity,
      avgWeightG,
      batchCount: batches.length,
      tankCount,
      speciesBreakdown,
    };
  }

  /**
   * Biyokütle projeksiyonu yapar
   */
  async projectBiomass(
    batchId: string,
    tenantId: string,
    daysForward: number,
  ): Promise<BiomassProjection> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
      relations: ['species'],
    });

    if (!batch) {
      throw new Error(`Batch ${batchId} bulunamadı`);
    }

    const currentBiomass = await this.getBatchBiomass(batchId, tenantId);

    // Büyüme parametreleri
    const dailyGrowthG = batch.species?.growthParameters?.avgDailyGrowth || 1;
    const expectedSurvivalRate = batch.species?.growthParameters?.expectedSurvivalRate || 95;
    const targetFCR = batch.fcr?.target || 1.5;

    // Günlük ölüm oranı
    const dailyMortalityRate = (100 - expectedSurvivalRate) / 100 / 365;

    // Projeksiyon
    let projectedQuantity = currentBiomass.quantity;
    let projectedAvgWeightG = currentBiomass.avgWeightG;

    for (let day = 0; day < daysForward; day++) {
      projectedQuantity = projectedQuantity * (1 - dailyMortalityRate);
      projectedAvgWeightG = projectedAvgWeightG + dailyGrowthG;
    }

    const projectedBiomassKg = this.calculateBiomass(projectedQuantity, projectedAvgWeightG);
    const dailyGrowthKg = (projectedBiomassKg - currentBiomass.biomassKg) / daysForward;

    const projectedDate = new Date();
    projectedDate.setDate(projectedDate.getDate() + daysForward);

    return {
      currentBiomassKg: currentBiomass.biomassKg,
      projectedBiomassKg,
      daysForward,
      projectedDate,
      dailyGrowthKg,
      assumptions: {
        survivalRate: expectedSurvivalRate,
        dailyGrowthG,
        fcr: targetFCR,
      },
    };
  }

  /**
   * Transfer sonrası yoğunluk tahmini
   */
  calculatePostTransferDensity(
    sourceTank: { volumeM3: number; currentBiomassKg: number },
    destinationTank: { volumeM3: number; currentBiomassKg: number },
    transferBiomassKg: number,
  ): {
    sourceDensity: number;
    destinationDensity: number;
    isValid: boolean;
    warnings: string[];
  } {
    const warnings: string[] = [];

    if (transferBiomassKg > sourceTank.currentBiomassKg) {
      warnings.push('Transfer miktarı kaynak tank biyokütlesinden fazla');
    }

    const newSourceBiomass = sourceTank.currentBiomassKg - transferBiomassKg;
    const newDestBiomass = destinationTank.currentBiomassKg + transferBiomassKg;

    const sourceDensity = newSourceBiomass / sourceTank.volumeM3;
    const destinationDensity = newDestBiomass / destinationTank.volumeM3;

    if (destinationDensity > 25) {
      warnings.push(`Hedef tank yoğunluğu kritik seviyeye ulaşacak: ${destinationDensity.toFixed(1)} kg/m³`);
    }

    return {
      sourceDensity,
      destinationDensity,
      isValid: warnings.length === 0,
      warnings,
    };
  }

  /**
   * İki tarih arasındaki gün sayısı
   */
  private daysBetween(start: Date, end: Date): number {
    const startDate = new Date(start);
    const endDate = new Date(end);
    return Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  }
}
