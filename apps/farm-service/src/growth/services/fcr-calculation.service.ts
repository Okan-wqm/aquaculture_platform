/**
 * FCR Calculation Service
 *
 * Feed Conversion Ratio (FCR) hesaplamalarını yapar.
 * FCR = Verilen Yem (kg) / Canlı Ağırlık Artışı (kg)
 *
 * Düşük FCR daha iyidir (daha az yemle daha fazla büyüme).
 *
 * Özellikler:
 * - Periyodik FCR hesaplama
 * - Kümülatif FCR hesaplama
 * - FCR trend analizi
 * - Performans karşılaştırması
 * - Anomali tespiti
 *
 * @module Growth
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { GrowthMeasurement, FCRAnalysis } from '../entities/growth-measurement.entity';
import { Batch } from '../../batch/entities/batch.entity';

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * FCR hesaplama girdisi
 */
export interface FCRCalculationInput {
  batchId: string;
  tenantId: string;
  startDate: Date;
  endDate: Date;
  targetFCR?: number;
}

/**
 * FCR hesaplama sonucu
 */
export interface FCRCalculationResult {
  periodFCR: number;
  cumulativeFCR: number;
  analysis: FCRAnalysis;
  isValid: boolean;
  warnings: string[];
}

/**
 * FCR trend analizi
 */
export interface FCRTrendAnalysis {
  trend: 'improving' | 'stable' | 'declining';
  slope: number;                     // Günlük değişim oranı
  correlation: number;               // R-squared
  forecast7Days: number;             // 7 günlük tahmin
  recommendations: string[];
}

/**
 * FCR karşılaştırma sonucu
 */
export interface FCRComparison {
  currentFCR: number;
  targetFCR: number;
  industryAvgFCR: number;
  varianceFromTarget: number;        // %
  varianceFromIndustry: number;      // %
  performance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
}

/**
 * Batch FCR özeti
 */
export interface BatchFCRSummary {
  batchId: string;
  batchCode: string;
  speciesName: string;

  // Miktar bilgileri
  totalFeedGiven: number;            // kg
  totalGrowth: number;               // kg
  startBiomass: number;              // kg
  currentBiomass: number;            // kg

  // FCR metrikleri
  currentFCR: number;
  bestFCR: number;
  worstFCR: number;
  avgFCR: number;
  targetFCR: number;

  // Trend
  trend: 'improving' | 'stable' | 'declining';
  measurementCount: number;

  // Performans
  performance: 'excellent' | 'good' | 'average' | 'below_average' | 'poor';
  recommendations: string[];
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class FCRCalculationService {
  private readonly logger = new Logger(FCRCalculationService.name);

  // Endüstri ortalama FCR değerleri (tür bazlı)
  private readonly industryAverageFCR: Record<string, number> = {
    'atlantic_salmon': 1.2,
    'rainbow_trout': 1.1,
    'sea_bass': 1.8,
    'sea_bream': 2.0,
    'tilapia': 1.6,
    'catfish': 1.5,
    'shrimp': 1.8,
    'default': 1.5,
  };

  constructor(
    @InjectRepository(FeedingRecord)
    private readonly feedingRecordRepository: Repository<FeedingRecord>,
    @InjectRepository(GrowthMeasurement)
    private readonly growthMeasurementRepository: Repository<GrowthMeasurement>,
    @InjectRepository(Batch)
    private readonly batchRepository: Repository<Batch>,
  ) {}

  // -------------------------------------------------------------------------
  // ANA HESAPLAMA METODLARİ
  // -------------------------------------------------------------------------

  /**
   * Belirli bir periyot için FCR hesaplar
   */
  async calculatePeriodFCR(input: FCRCalculationInput): Promise<FCRCalculationResult> {
    const { batchId, tenantId, startDate, endDate, targetFCR } = input;
    const warnings: string[] = [];

    // Periyottaki yemleme kayıtlarını al
    const feedingRecords = await this.feedingRecordRepository.find({
      where: {
        tenantId,
        batchId,
        feedingDate: Between(startDate, endDate),
      },
    });

    // Periyot başı ve sonu büyüme ölçümlerini al
    const measurements = await this.growthMeasurementRepository.find({
      where: {
        tenantId,
        batchId,
        measurementDate: Between(startDate, endDate),
      },
      order: { measurementDate: 'ASC' },
    });

    if (measurements.length < 2) {
      warnings.push('Yetersiz büyüme ölçümü - en az 2 ölçüm gerekli');
      return this.createEmptyResult(warnings);
    }

    // Toplam verilen yem (kg)
    const totalFeed = feedingRecords.reduce(
      (sum, record) => sum + Number(record.actualAmount),
      0
    );

    // Büyüme hesabı (başlangıç vs son biomass)
    const startMeasurement = measurements[0];
    const endMeasurement = measurements[measurements.length - 1];

    if (!startMeasurement || !endMeasurement) {
      warnings.push('Yetersiz ölçüm verisi');
      return this.createEmptyResult(warnings);
    }

    const startBiomass = startMeasurement.estimatedBiomass;
    const endBiomass = endMeasurement.estimatedBiomass;
    const growthKg = endBiomass - startBiomass;

    if (growthKg <= 0) {
      warnings.push('Negatif veya sıfır büyüme tespit edildi');
      return this.createEmptyResult(warnings);
    }

    // Periyod FCR
    const periodFCR = totalFeed / growthKg;

    // Kümülatif FCR hesapla
    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId, endDate);

    // FCR trend analizi
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Target FCR varsayılan
    const effectiveTargetFCR = targetFCR || await this.getTargetFCR(batchId);

    // Analiz oluştur
    const analysis: FCRAnalysis = {
      periodFeedGiven: totalFeed,
      periodGrowth: growthKg,
      periodFCR,
      cumulativeFeedGiven: cumulativeResult.totalFeed,
      cumulativeGrowth: cumulativeResult.totalGrowth,
      cumulativeFCR: cumulativeResult.fcr,
      targetFCR: effectiveTargetFCR,
      fcrVariance: ((cumulativeResult.fcr - effectiveTargetFCR) / effectiveTargetFCR) * 100,
      fcrTrend: trendAnalysis.trend,
    };

    // Validasyonlar
    if (periodFCR < 0.5 || periodFCR > 5) {
      warnings.push(`Anormal FCR değeri: ${periodFCR.toFixed(2)} - veri doğruluğunu kontrol edin`);
    }

    return {
      periodFCR,
      cumulativeFCR: cumulativeResult.fcr,
      analysis,
      isValid: warnings.length === 0,
      warnings,
    };
  }

  /**
   * Kümülatif FCR hesaplar (batch başından bugüne)
   */
  async calculateCumulativeFCR(
    batchId: string,
    tenantId: string,
    endDate?: Date
  ): Promise<{ fcr: number; totalFeed: number; totalGrowth: number }> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      return { fcr: 0, totalFeed: 0, totalGrowth: 0 };
    }

    // Tüm yemleme kayıtlarını al
    const feedQuery = this.feedingRecordRepository.createQueryBuilder('fr')
      .where('fr.tenantId = :tenantId', { tenantId })
      .andWhere('fr.batchId = :batchId', { batchId });

    if (endDate) {
      feedQuery.andWhere('fr.feedingDate <= :endDate', { endDate });
    }

    const feedResult = await feedQuery
      .select('SUM(fr.actualAmount)', 'totalFeed')
      .getRawOne();

    const totalFeed = Number(feedResult?.totalFeed || 0);

    // Son ölçümü al
    const measurementQuery = this.growthMeasurementRepository.createQueryBuilder('gm')
      .where('gm.tenantId = :tenantId', { tenantId })
      .andWhere('gm.batchId = :batchId', { batchId });

    if (endDate) {
      measurementQuery.andWhere('gm.measurementDate <= :endDate', { endDate });
    }

    const latestMeasurement = await measurementQuery
      .orderBy('gm.measurementDate', 'DESC')
      .getOne();

    // Başlangıç biomass (initialQuantity * initial avgWeight)
    const initialWeight = batch.weight?.initial?.avgWeight || 0;
    const startBiomass = (batch.initialQuantity * initialWeight) / 1000; // kg
    const currentBiomass = latestMeasurement?.estimatedBiomass || startBiomass;
    const totalGrowth = currentBiomass - startBiomass;

    const fcr = totalGrowth > 0 ? totalFeed / totalGrowth : 0;

    return { fcr, totalFeed, totalGrowth };
  }

  /**
   * FCR trend analizi yapar
   */
  async analyzeFCRTrend(batchId: string, tenantId: string): Promise<FCRTrendAnalysis> {
    // Son 10 ölçümü al
    const measurements = await this.growthMeasurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'DESC' },
      take: 10,
    });

    if (measurements.length < 3) {
      return {
        trend: 'stable',
        slope: 0,
        correlation: 0,
        forecast7Days: 0,
        recommendations: ['Yeterli veri yok - daha fazla ölçüm gerekli'],
      };
    }

    // FCR değerlerini çıkar
    const fcrValues = measurements
      .filter(m => m.fcrAnalysis?.periodFCR)
      .map((m, index) => ({
        x: index,
        y: m.fcrAnalysis!.periodFCR,
      }))
      .reverse(); // Kronolojik sıra

    if (fcrValues.length < 3) {
      return {
        trend: 'stable',
        slope: 0,
        correlation: 0,
        forecast7Days: measurements[0]?.fcrAnalysis?.cumulativeFCR || 0,
        recommendations: ['FCR verileri eksik'],
      };
    }

    // Lineer regresyon
    const { slope, correlation } = this.linearRegression(fcrValues);

    // Trend belirleme
    let trend: 'improving' | 'stable' | 'declining';
    if (slope < -0.01) {
      trend = 'improving'; // FCR düşüyor = iyi
    } else if (slope > 0.01) {
      trend = 'declining'; // FCR artıyor = kötü
    } else {
      trend = 'stable';
    }

    // 7 günlük tahmin
    const lastFcrValue = fcrValues[fcrValues.length - 1];
    const lastFCR = lastFcrValue?.y ?? 0;
    const forecast7Days = lastFCR + (slope * 7);

    // Öneriler
    const recommendations = this.generateTrendRecommendations(trend, slope, lastFCR);

    return {
      trend,
      slope,
      correlation,
      forecast7Days: Math.max(0.5, forecast7Days), // Minimum 0.5
      recommendations,
    };
  }

  /**
   * FCR karşılaştırması yapar
   */
  async compareFCR(
    batchId: string,
    tenantId: string,
    speciesType?: string
  ): Promise<FCRComparison> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const currentFCR = cumulativeResult.fcr;

    // Target FCR (batch'ten veya varsayılan)
    const targetFCR = await this.getTargetFCR(batchId) || 1.5;

    // Endüstri ortalaması
    const industryAvgFCR = this.industryAverageFCR[speciesType || 'default'] || 1.5;

    // Varyanslar
    const varianceFromTarget = ((currentFCR - targetFCR) / targetFCR) * 100;
    const varianceFromIndustry = ((currentFCR - industryAvgFCR) / industryAvgFCR) * 100;

    // Performans değerlendirmesi
    let performance: FCRComparison['performance'];
    if (varianceFromTarget <= -10) {
      performance = 'excellent';
    } else if (varianceFromTarget <= 0) {
      performance = 'good';
    } else if (varianceFromTarget <= 10) {
      performance = 'average';
    } else if (varianceFromTarget <= 20) {
      performance = 'below_average';
    } else {
      performance = 'poor';
    }

    return {
      currentFCR,
      targetFCR,
      industryAvgFCR,
      varianceFromTarget,
      varianceFromIndustry,
      performance,
    };
  }

  /**
   * Batch FCR özeti oluşturur
   */
  async getBatchFCRSummary(batchId: string, tenantId: string): Promise<BatchFCRSummary | null> {
    const batch = await this.batchRepository.findOne({
      where: { id: batchId, tenantId },
    });

    if (!batch) {
      return null;
    }

    // Tüm ölçümleri al
    const measurements = await this.growthMeasurementRepository.find({
      where: { tenantId, batchId },
      order: { measurementDate: 'ASC' },
    });

    // Kümülatif hesapla
    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);

    // FCR değerlerini çıkar
    const fcrValues = measurements
      .filter(m => m.fcrAnalysis?.periodFCR)
      .map(m => m.fcrAnalysis!.periodFCR);

    const bestFCR = fcrValues.length > 0 ? Math.min(...fcrValues) : 0;
    const worstFCR = fcrValues.length > 0 ? Math.max(...fcrValues) : 0;
    const avgFCR = fcrValues.length > 0
      ? fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length
      : 0;

    // Trend analizi
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Karşılaştırma
    const comparison = await this.compareFCR(batchId, tenantId);

    // Başlangıç biomass
    const initialWeightG = batch.weight?.initial?.avgWeight || 0;
    const startBiomass = (batch.initialQuantity * initialWeightG) / 1000;

    // Son ölçümden güncel biomass
    const latestMeasurement = measurements[measurements.length - 1];
    const currentBiomass = latestMeasurement?.estimatedBiomass || startBiomass;

    return {
      batchId,
      batchCode: batch.batchNumber,
      speciesName: '', // Species'ten alınacak
      totalFeedGiven: cumulativeResult.totalFeed,
      totalGrowth: cumulativeResult.totalGrowth,
      startBiomass,
      currentBiomass,
      currentFCR: cumulativeResult.fcr,
      bestFCR,
      worstFCR,
      avgFCR,
      targetFCR: comparison.targetFCR,
      trend: trendAnalysis.trend,
      measurementCount: measurements.length,
      performance: comparison.performance,
      recommendations: trendAnalysis.recommendations,
    };
  }

  // -------------------------------------------------------------------------
  // ANOMALY DETECTION
  // -------------------------------------------------------------------------

  /**
   * FCR anomalileri tespit eder
   */
  async detectFCRAnomalies(
    batchId: string,
    tenantId: string
  ): Promise<{ hasAnomaly: boolean; anomalies: string[] }> {
    const anomalies: string[] = [];

    const cumulativeResult = await this.calculateCumulativeFCR(batchId, tenantId);
    const comparison = await this.compareFCR(batchId, tenantId);
    const trendAnalysis = await this.analyzeFCRTrend(batchId, tenantId);

    // Çok yüksek FCR
    if (cumulativeResult.fcr > 3) {
      anomalies.push(`Kritik: FCR çok yüksek (${cumulativeResult.fcr.toFixed(2)}) - yemleme veya ölçüm hatası olabilir`);
    }

    // Çok düşük FCR (şüpheli)
    if (cumulativeResult.fcr < 0.7 && cumulativeResult.fcr > 0) {
      anomalies.push(`Uyarı: FCR çok düşük (${cumulativeResult.fcr.toFixed(2)}) - veri doğruluğunu kontrol edin`);
    }

    // Hedeften %30+ sapma
    if (Math.abs(comparison.varianceFromTarget) > 30) {
      anomalies.push(`Önemli sapma: FCR hedeften %${comparison.varianceFromTarget.toFixed(1)} farklı`);
    }

    // Hızlı kötüleşme
    if (trendAnalysis.trend === 'declining' && trendAnalysis.slope > 0.05) {
      anomalies.push(`Uyarı: FCR hızla kötüleşiyor (günlük +${(trendAnalysis.slope * 100).toFixed(2)}%)`);
    }

    return {
      hasAnomaly: anomalies.length > 0,
      anomalies,
    };
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Target FCR'ı getirir
   */
  private async getTargetFCR(batchId: string): Promise<number> {
    // Önce batch'in feeding table'ından al
    // Yoksa species'ten al
    // Yoksa varsayılan döndür
    return 1.5; // Varsayılan
  }

  /**
   * Boş sonuç oluşturur
   */
  private createEmptyResult(warnings: string[]): FCRCalculationResult {
    return {
      periodFCR: 0,
      cumulativeFCR: 0,
      analysis: {
        periodFeedGiven: 0,
        periodGrowth: 0,
        periodFCR: 0,
        cumulativeFeedGiven: 0,
        cumulativeGrowth: 0,
        cumulativeFCR: 0,
        targetFCR: 1.5,
        fcrVariance: 0,
        fcrTrend: 'stable',
      },
      isValid: false,
      warnings,
    };
  }

  /**
   * Lineer regresyon hesaplar
   */
  private linearRegression(points: { x: number; y: number }[]): { slope: number; correlation: number } {
    const n = points.length;

    const sumX = points.reduce((sum, p) => sum + p.x, 0);
    const sumY = points.reduce((sum, p) => sum + p.y, 0);
    const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
    const sumX2 = points.reduce((sum, p) => sum + p.x * p.x, 0);
    const sumY2 = points.reduce((sum, p) => sum + p.y * p.y, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // R-squared hesaplama
    const meanY = sumY / n;
    const ssTotal = points.reduce((sum, p) => sum + Math.pow(p.y - meanY, 2), 0);
    const intercept = (sumY - slope * sumX) / n;
    const ssResidual = points.reduce((sum, p) => {
      const predicted = slope * p.x + intercept;
      return sum + Math.pow(p.y - predicted, 2);
    }, 0);

    const correlation = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;

    return { slope: isNaN(slope) ? 0 : slope, correlation };
  }

  /**
   * Trend bazlı öneriler oluşturur
   */
  private generateTrendRecommendations(
    trend: 'improving' | 'stable' | 'declining',
    slope: number,
    currentFCR: number
  ): string[] {
    const recommendations: string[] = [];

    if (trend === 'declining') {
      recommendations.push('Yemleme programını gözden geçirin');
      recommendations.push('Su kalitesi parametrelerini kontrol edin');
      recommendations.push('Balık sağlığını değerlendirin');

      if (slope > 0.03) {
        recommendations.push('ACİL: Hızlı FCR artışı - detaylı inceleme gerekli');
      }
    } else if (trend === 'improving') {
      recommendations.push('Mevcut yemleme stratejisini sürdürün');

      if (currentFCR > 2) {
        recommendations.push('FCR hala yüksek - iyileştirme potansiyeli var');
      }
    } else {
      if (currentFCR > 1.8) {
        recommendations.push('FCR optimizasyonu için yem kalitesini değerlendirin');
      } else {
        recommendations.push('Performans stabil - mevcut protokolü sürdürün');
      }
    }

    return recommendations;
  }
}
