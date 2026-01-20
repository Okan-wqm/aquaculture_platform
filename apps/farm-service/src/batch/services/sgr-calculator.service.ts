/**
 * SGR Calculator Service
 *
 * Specific Growth Rate (SGR) hesaplamalarını yapar.
 * SGR = [(ln(Wf) - ln(Wi)) / t] * 100
 *
 * Yüksek SGR daha hızlı büyüme anlamına gelir.
 *
 * @module Batch/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GrowthMeasurement } from '../../growth/entities/growth-measurement.entity';
import { Batch } from '../entities/batch.entity';
import { Species } from '../../species/entities/species.entity';

/**
 * SGR hesaplama sonucu
 */
export interface SGRResult {
  sgr: number;                          // % / gün
  initialWeightG: number;
  finalWeightG: number;
  days: number;
  isValid: boolean;
  warning?: string;
}

/**
 * SGR trend analizi
 */
export interface SGRTrendAnalysis {
  currentSGR: number;
  avgSGR: number;
  minSGR: number;
  maxSGR: number;
  trend: 'improving' | 'stable' | 'declining';
  comparedToTarget: number;              // %
  targetSGR?: number;
  historicalSGR: { date: string; sgr: number }[];
}

/**
 * SGR karşılaştırması
 */
export interface SGRComparison {
  batchId: string;
  batchNumber: string;
  currentSGR: number;
  speciesAvgSGR?: number;
  siteAvgSGR?: number;
  performance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

@Injectable()
export class SGRCalculatorService {
  private readonly logger = new Logger(SGRCalculatorService.name);

  // Tipik SGR değerleri (tür ve ağırlık aralığına göre)
  private readonly speciesSGR: Record<string, Record<string, number>> = {
    'rainbow_trout': {
      'fry': 4.5,        // 0-10g
      'juvenile': 2.5,    // 10-100g
      'grow_out': 1.2,    // 100-500g
      'market': 0.8,      // 500g+
    },
    'atlantic_salmon': {
      'fry': 5.0,
      'juvenile': 3.0,
      'grow_out': 1.5,
      'market': 0.9,
    },
    'sea_bass': {
      'fry': 4.0,
      'juvenile': 2.0,
      'grow_out': 1.0,
      'market': 0.6,
    },
    'default': {
      'fry': 4.0,
      'juvenile': 2.5,
      'grow_out': 1.2,
      'market': 0.7,
    },
  };

  constructor(
    @InjectRepository(GrowthMeasurement)
    private readonly measurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
    @InjectRepository(Species)
    private readonly speciesRepository: Repository<Species>,
  ) {}

  /**
   * İki ağırlık arasında SGR hesaplar
   */
  calculateSGR(initialWeightG: number, finalWeightG: number, days: number): SGRResult {
    if (days <= 0) {
      return {
        sgr: 0,
        initialWeightG,
        finalWeightG,
        days,
        isValid: false,
        warning: 'Gün sayısı 0 veya negatif',
      };
    }

    if (initialWeightG <= 0 || finalWeightG <= 0) {
      return {
        sgr: 0,
        initialWeightG,
        finalWeightG,
        days,
        isValid: false,
        warning: 'Ağırlık değerleri 0 veya negatif olamaz',
      };
    }

    const sgr = ((Math.log(finalWeightG) - Math.log(initialWeightG)) / days) * 100;

    let warning: string | undefined;
    if (sgr < 0) {
      warning = 'Negatif SGR - balıklar ağırlık kaybediyor';
    } else if (sgr > 10) {
      warning = 'Anormal yüksek SGR - veri doğruluğunu kontrol edin';
    }

    return {
      sgr,
      initialWeightG,
      finalWeightG,
      days,
      isValid: sgr >= 0 && sgr <= 10,
      warning,
    };
  }

  /**
   * Batch için SGR trend analizi yapar
   */
  async analyzeSGRTrend(batchId: string, tenantId: string): Promise<SGRTrendAnalysis> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
      relations: ['species'],
    });

    if (!batch) {
      throw new Error(`Batch ${batchId} bulunamadı`);
    }

    // Ölçümleri al
    const measurements = await this.measurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'ASC' },
    });

    if (measurements.length < 2) {
      return {
        currentSGR: 0,
        avgSGR: 0,
        minSGR: 0,
        maxSGR: 0,
        trend: 'stable',
        comparedToTarget: 0,
        historicalSGR: [],
      };
    }

    // SGR değerlerini hesapla
    const sgrValues: { date: string; sgr: number }[] = [];

    for (let i = 1; i < measurements.length; i++) {
      const prev = measurements[i - 1];
      const curr = measurements[i];

      // Null check for measurement dates
      if (!prev?.measurementDate || !curr?.measurementDate) continue;

      const days = this.daysBetween(prev.measurementDate, curr.measurementDate);

      if (days > 0 && prev.averageWeight && curr.averageWeight) {
        const result = this.calculateSGR(prev.averageWeight, curr.averageWeight, days);
        if (result.isValid && curr.measurementDate) {
          const dateStr: string = curr.measurementDate instanceof Date
            ? curr.measurementDate.toISOString().split('T')[0]!
            : String(curr.measurementDate).split('T')[0]!;
          sgrValues.push({
            date: dateStr,
            sgr: result.sgr,
          });
        }
      }
    }

    if (sgrValues.length === 0) {
      return {
        currentSGR: 0,
        avgSGR: 0,
        minSGR: 0,
        maxSGR: 0,
        trend: 'stable',
        comparedToTarget: 0,
        historicalSGR: [],
      };
    }

    const currentSGR = sgrValues[sgrValues.length - 1]!.sgr;
    const sgrNumbers = sgrValues.map(v => v.sgr);
    const avgSGR = sgrNumbers.reduce((a, b) => a + b, 0) / sgrNumbers.length;
    const minSGR = Math.min(...sgrNumbers);
    const maxSGR = Math.max(...sgrNumbers);

    // Trend belirleme
    const trend = this.determineTrend(sgrValues);

    // Target SGR
    const targetSGR = await this.getTargetSGR(batch);

    const comparedToTarget = targetSGR > 0
      ? ((currentSGR - targetSGR) / targetSGR) * 100
      : 0;

    return {
      currentSGR,
      avgSGR,
      minSGR,
      maxSGR,
      trend,
      comparedToTarget,
      targetSGR,
      historicalSGR: sgrValues,
    };
  }

  /**
   * Birden fazla batch için SGR karşılaştırması yapar
   */
  async compareBatchSGR(
    batchIds: string[],
    tenantId: string,
  ): Promise<SGRComparison[]> {
    const comparisons: SGRComparison[] = [];

    for (const batchId of batchIds) {
      const batch = await this.batchRepository.findOne({
        where: { id: batchId, tenantId },
        relations: ['species'],
      });

      if (!batch) continue;

      const trendAnalysis = await this.analyzeSGRTrend(batchId, tenantId);

      let performance: SGRComparison['performance'];
      if (trendAnalysis.comparedToTarget >= 10) {
        performance = 'excellent';
      } else if (trendAnalysis.comparedToTarget >= -5) {
        performance = 'good';
      } else if (trendAnalysis.comparedToTarget >= -15) {
        performance = 'average';
      } else if (trendAnalysis.comparedToTarget >= -25) {
        performance = 'below_average';
      } else {
        performance = 'poor';
      }

      comparisons.push({
        batchId,
        batchNumber: batch.batchNumber,
        currentSGR: trendAnalysis.currentSGR,
        speciesAvgSGR: trendAnalysis.targetSGR,
        performance,
      });
    }

    // En yüksek SGR'a göre sırala
    return comparisons.sort((a, b) => b.currentSGR - a.currentSGR);
  }

  /**
   * Hedef SGR'ı belirler
   */
  private async getTargetSGR(batch: Batch): Promise<number> {
    const species = batch.species || await this.speciesRepository.findOne({
      where: { id: batch.speciesId },
    });

    // Tür bazlı SGR
    const speciesKey = species?.scientificName?.toLowerCase().replace(' ', '_') || 'default';
    const speciesSGRData = this.speciesSGR[speciesKey] || this.speciesSGR['default'];

    // Mevcut ağırlığa göre stage belirleme
    const currentWeight = batch.getCurrentAvgWeight();
    let stage: string;

    if (currentWeight < 10) {
      stage = 'fry';
    } else if (currentWeight < 100) {
      stage = 'juvenile';
    } else if (currentWeight < 500) {
      stage = 'grow_out';
    } else {
      stage = 'market';
    }

    return speciesSGRData?.[stage as keyof typeof speciesSGRData] as number || 1.5;
  }

  /**
   * Trend belirleme
   */
  private determineTrend(
    sgrValues: { date: string; sgr: number }[],
  ): 'improving' | 'stable' | 'declining' {
    if (sgrValues.length < 3) return 'stable';

    const recent = sgrValues.slice(-3).map(v => v.sgr);
    const older = sgrValues.slice(0, 3).map(v => v.sgr);

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    const diff = recentAvg - olderAvg;

    if (diff > 0.2) return 'improving';
    if (diff < -0.2) return 'declining';
    return 'stable';
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
