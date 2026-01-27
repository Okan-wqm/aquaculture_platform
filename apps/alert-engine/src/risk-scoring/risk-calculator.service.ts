import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertRule, AlertSeverity } from '../database/entities/alert-rule.entity';
import { ImpactAnalyzerService, ImpactAnalysisResult } from './impact-analyzer.service';
import { SeverityClassifierService } from './severity-classifier.service';

/**
 * Risk factor categories
 */
export enum RiskFactorCategory {
  FREQUENCY = 'FREQUENCY',
  SEVERITY = 'SEVERITY',
  IMPACT = 'IMPACT',
  HISTORY = 'HISTORY',
  CONTEXT = 'CONTEXT',
  TREND = 'TREND',
}

/**
 * Risk factor definition
 */
export interface RiskFactor {
  category: RiskFactorCategory;
  name: string;
  value: number; // 0-100
  weight: number; // 0-1
  description?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Risk calculation context
 */
export interface RiskCalculationContext {
  tenantId: string;
  ruleId: string;
  sensorId?: string;
  farmId?: string;
  currentValue: number;
  thresholdValue?: number;
  historicalValues?: number[];
  previousIncidents?: number;
  lastIncidentDate?: Date;
  environmentalFactors?: Record<string, unknown>;
}

/**
 * Risk score result
 */
export interface RiskScoreResult {
  totalScore: number; // 0-100
  normalizedScore: number; // 0-1
  factors: RiskFactor[];
  severity: AlertSeverity;
  confidence: number; // 0-1
  recommendations: string[];
  calculatedAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Risk threshold configuration
 */
export interface RiskThresholds {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Default risk thresholds
 */
const DEFAULT_THRESHOLDS: RiskThresholds = {
  critical: 85,
  high: 65,
  medium: 40,
  low: 20,
};

/**
 * Default factor weights
 */
const DEFAULT_WEIGHTS: Record<RiskFactorCategory, number> = {
  [RiskFactorCategory.FREQUENCY]: 0.15,
  [RiskFactorCategory.SEVERITY]: 0.25,
  [RiskFactorCategory.IMPACT]: 0.25,
  [RiskFactorCategory.HISTORY]: 0.15,
  [RiskFactorCategory.CONTEXT]: 0.10,
  [RiskFactorCategory.TREND]: 0.10,
};

@Injectable()
export class RiskCalculatorService {
  private readonly logger = new Logger(RiskCalculatorService.name);
  private thresholds: RiskThresholds = DEFAULT_THRESHOLDS;
  private weights: Record<RiskFactorCategory, number> = { ...DEFAULT_WEIGHTS };

  constructor(
    @InjectRepository(AlertRule)
    private readonly alertRuleRepository: Repository<AlertRule>,
    private readonly impactAnalyzer: ImpactAnalyzerService,
    private readonly severityClassifier: SeverityClassifierService,
  ) {}

  /**
   * Calculate risk score for given context
   */
  async calculateRiskScore(context: RiskCalculationContext): Promise<RiskScoreResult> {
    this.logger.debug(`Calculating risk score for rule ${context.ruleId}`);

    const factors: RiskFactor[] = [];

    // Get rule for additional context
    const rule = await this.alertRuleRepository.findOne({
      where: { id: context.ruleId, tenantId: context.tenantId },
    });

    // Calculate frequency factor
    const frequencyFactor = this.calculateFrequencyFactor(context);
    factors.push(frequencyFactor);

    // Calculate severity factor
    const severityFactor = this.calculateSeverityFactor(context, rule);
    factors.push(severityFactor);

    // Calculate impact factor
    const impactResult = await this.impactAnalyzer.analyzeImpact({
      tenantId: context.tenantId,
      ruleId: context.ruleId,
      farmId: context.farmId,
      sensorId: context.sensorId,
      currentValue: context.currentValue,
    });
    const impactFactor = this.createImpactFactor(impactResult);
    factors.push(impactFactor);

    // Calculate history factor
    const historyFactor = this.calculateHistoryFactor(context);
    factors.push(historyFactor);

    // Calculate context factor
    const contextFactor = this.calculateContextFactor(context);
    factors.push(contextFactor);

    // Calculate trend factor
    const trendFactor = this.calculateTrendFactor(context);
    factors.push(trendFactor);

    // Calculate total weighted score
    const totalScore = this.calculateWeightedScore(factors);
    const normalizedScore = totalScore / 100;

    // Determine severity based on score
    const severity = this.severityClassifier.classifyBySCore(totalScore, this.thresholds);

    // Calculate confidence
    const confidence = this.calculateConfidence(factors, context);

    // Generate recommendations
    const recommendations = this.generateRecommendations(totalScore, factors, rule);

    return {
      totalScore,
      normalizedScore,
      factors,
      severity,
      confidence,
      recommendations,
      calculatedAt: new Date(),
      metadata: {
        ruleId: context.ruleId,
        thresholds: this.thresholds,
        weights: this.weights,
      },
    };
  }

  /**
   * Calculate weighted score from factors
   */
  calculateWeightedScore(factors: RiskFactor[]): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const factor of factors) {
      weightedSum += factor.value * factor.weight;
      totalWeight += factor.weight;
    }

    // Normalize to 0-100
    const score = totalWeight > 0 ? (weightedSum / totalWeight) : 0;
    return Math.min(100, Math.max(0, Math.round(score * 100) / 100));
  }

  /**
   * Calculate frequency factor
   */
  calculateFrequencyFactor(context: RiskCalculationContext): RiskFactor {
    let value = 50; // Default mid-range value

    if (context.previousIncidents !== undefined) {
      // More incidents = higher risk
      if (context.previousIncidents === 0) {
        value = 10;
      } else if (context.previousIncidents <= 2) {
        value = 30;
      } else if (context.previousIncidents <= 5) {
        value = 50;
      } else if (context.previousIncidents <= 10) {
        value = 70;
      } else {
        value = 90;
      }

      // Adjust based on recency
      if (context.lastIncidentDate) {
        const daysSinceLastIncident = Math.floor(
          (Date.now() - context.lastIncidentDate.getTime()) / (1000 * 60 * 60 * 24)
        );

        if (daysSinceLastIncident < 1) {
          value = Math.min(100, value + 20);
        } else if (daysSinceLastIncident < 7) {
          value = Math.min(100, value + 10);
        } else if (daysSinceLastIncident > 30) {
          value = Math.max(0, value - 10);
        }
      }
    }

    return {
      category: RiskFactorCategory.FREQUENCY,
      name: 'Incident Frequency',
      value,
      weight: this.weights[RiskFactorCategory.FREQUENCY],
      description: `Based on ${context.previousIncidents ?? 'unknown'} previous incidents`,
    };
  }

  /**
   * Calculate severity factor
   */
  calculateSeverityFactor(context: RiskCalculationContext, rule?: AlertRule | null): RiskFactor {
    let value = 50;

    if (rule) {
      // Base on rule severity
      switch (rule.severity) {
        case AlertSeverity.CRITICAL:
          value = 100;
          break;
        case AlertSeverity.HIGH:
          value = 75;
          break;
        case AlertSeverity.MEDIUM:
          value = 50;
          break;
        case AlertSeverity.LOW:
          value = 25;
          break;
        case AlertSeverity.INFO:
          value = 10;
          break;
      }
    }

    // Adjust based on threshold deviation
    // SECURITY: Check for zero to prevent division by zero
    if (context.thresholdValue !== undefined && context.thresholdValue !== 0 && context.currentValue !== undefined) {
      const deviation = Math.abs(context.currentValue - context.thresholdValue);
      const deviationPercent = (deviation / context.thresholdValue) * 100;

      if (deviationPercent > 50) {
        value = Math.min(100, value + 15);
      } else if (deviationPercent > 25) {
        value = Math.min(100, value + 10);
      } else if (deviationPercent > 10) {
        value = Math.min(100, value + 5);
      }
    }

    return {
      category: RiskFactorCategory.SEVERITY,
      name: 'Baseline Severity',
      value,
      weight: this.weights[RiskFactorCategory.SEVERITY],
      description: rule ? `Rule severity: ${rule.severity}` : 'Unknown rule severity',
    };
  }

  /**
   * Create impact factor from analysis result
   */
  createImpactFactor(impactResult: ImpactAnalysisResult): RiskFactor {
    return {
      category: RiskFactorCategory.IMPACT,
      name: 'Business Impact',
      value: impactResult.totalImpactScore,
      weight: this.weights[RiskFactorCategory.IMPACT],
      description: impactResult.summary,
      metadata: {
        businessImpact: impactResult.businessImpact,
        technicalImpact: impactResult.technicalImpact,
        financialImpact: impactResult.financialImpact,
        complianceImpact: impactResult.complianceImpact,
      },
    };
  }

  /**
   * Calculate history factor
   */
  calculateHistoryFactor(context: RiskCalculationContext): RiskFactor {
    let value = 50;

    if (context.historicalValues && context.historicalValues.length > 0) {
      const avg = context.historicalValues.reduce((a, b) => a + b, 0) / context.historicalValues.length;
      const currentDeviation = Math.abs(context.currentValue - avg);
      const stdDev = this.calculateStdDev(context.historicalValues);

      // Z-score based risk
      if (stdDev > 0) {
        const zScore = currentDeviation / stdDev;
        if (zScore > 3) {
          value = 95;
        } else if (zScore > 2) {
          value = 80;
        } else if (zScore > 1) {
          value = 60;
        } else {
          value = 30;
        }
      }
    }

    return {
      category: RiskFactorCategory.HISTORY,
      name: 'Historical Pattern',
      value,
      weight: this.weights[RiskFactorCategory.HISTORY],
      description: 'Based on historical value patterns',
    };
  }

  /**
   * Calculate context factor
   */
  calculateContextFactor(context: RiskCalculationContext): RiskFactor {
    let value = 50;

    if (context.environmentalFactors) {
      // Weather risk
      if (context.environmentalFactors['stormWarning']) {
        value += 20;
      }
      if (context.environmentalFactors['extremeTemperature']) {
        value += 15;
      }
      // Operational context
      if (context.environmentalFactors['peakSeason']) {
        value += 10;
      }
      if (context.environmentalFactors['criticalOperation']) {
        value += 15;
      }
      if (context.environmentalFactors['maintenanceScheduled']) {
        value -= 10;
      }
    }

    return {
      category: RiskFactorCategory.CONTEXT,
      name: 'Environmental Context',
      value: Math.min(100, Math.max(0, value)),
      weight: this.weights[RiskFactorCategory.CONTEXT],
      description: 'Based on environmental and operational context',
    };
  }

  /**
   * Calculate trend factor
   */
  calculateTrendFactor(context: RiskCalculationContext): RiskFactor {
    let value = 50;

    if (context.historicalValues && context.historicalValues.length >= 3) {
      const trend = this.calculateTrend(context.historicalValues);

      // Positive trend = increasing values = potentially higher risk
      if (trend > 0.5) {
        value = 90;
      } else if (trend > 0.2) {
        value = 75;
      } else if (trend > 0) {
        value = 60;
      } else if (trend < -0.5) {
        value = 20;
      } else if (trend < -0.2) {
        value = 35;
      } else {
        value = 50;
      }
    }

    return {
      category: RiskFactorCategory.TREND,
      name: 'Value Trend',
      value,
      weight: this.weights[RiskFactorCategory.TREND],
      description: 'Based on value trend analysis',
    };
  }

  /**
   * Calculate trend using linear regression
   */
  calculateTrend(values: number[]): number {
    if (values.length < 2) return 0;

    const n = values.length;
    const indices = values.map((_, i) => i);

    const sumX = indices.reduce((a, b) => a + b, 0);
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = indices.reduce((acc, x, i) => acc + x * values[i]!, 0);
    const sumX2 = indices.reduce((acc, x) => acc + x * x, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Normalize slope relative to average value
    const avgValue = sumY / n;
    return avgValue !== 0 ? slope / avgValue : slope;
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;

    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const squareDiffs = values.map(value => Math.pow(value - avg, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;

    return Math.sqrt(avgSquareDiff);
  }

  /**
   * Calculate confidence level
   */
  calculateConfidence(factors: RiskFactor[], context: RiskCalculationContext): number {
    let confidence = 0.5;

    // More data = higher confidence
    if (context.historicalValues && context.historicalValues.length > 0) {
      confidence += Math.min(0.2, context.historicalValues.length * 0.02);
    }

    // Known incident history
    if (context.previousIncidents !== undefined) {
      confidence += 0.1;
    }

    // Environmental context available
    if (context.environmentalFactors && Object.keys(context.environmentalFactors).length > 0) {
      confidence += 0.1;
    }

    // Factor coverage
    const validFactors = factors.filter(f => f.value > 0 && f.value < 100);
    confidence += (validFactors.length / factors.length) * 0.1;

    return Math.min(1, confidence);
  }

  /**
   * Generate recommendations based on risk score
   */
  generateRecommendations(score: number, factors: RiskFactor[], rule?: AlertRule | null): string[] {
    const recommendations: string[] = [];

    if (score >= this.thresholds.critical) {
      recommendations.push('Immediate attention required - critical risk level');
      recommendations.push('Consider emergency response procedures');
    } else if (score >= this.thresholds.high) {
      recommendations.push('High priority attention needed');
      recommendations.push('Review and address within 24 hours');
    } else if (score >= this.thresholds.medium) {
      recommendations.push('Monitor closely for changes');
      recommendations.push('Schedule review within this week');
    }

    // Factor-specific recommendations
    const frequencyFactor = factors.find(f => f.category === RiskFactorCategory.FREQUENCY);
    if (frequencyFactor && frequencyFactor.value > 70) {
      recommendations.push('High incident frequency - investigate root cause');
    }

    const trendFactor = factors.find(f => f.category === RiskFactorCategory.TREND);
    if (trendFactor && trendFactor.value > 75) {
      recommendations.push('Negative trend detected - implement preventive measures');
    }

    const impactFactor = factors.find(f => f.category === RiskFactorCategory.IMPACT);
    if (impactFactor && impactFactor.value > 80) {
      recommendations.push('High business impact - escalate to management');
    }

    return recommendations;
  }

  /**
   * Update risk thresholds
   */
  setThresholds(thresholds: Partial<RiskThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Get current thresholds
   */
  getThresholds(): RiskThresholds {
    return { ...this.thresholds };
  }

  /**
   * Update factor weights
   */
  setWeights(weights: Partial<Record<RiskFactorCategory, number>>): void {
    for (const [category, weight] of Object.entries(weights)) {
      if (weight >= 0 && weight <= 1) {
        this.weights[category as RiskFactorCategory] = weight;
      }
    }
  }

  /**
   * Get current weights
   */
  getWeights(): Record<RiskFactorCategory, number> {
    return { ...this.weights };
  }

  /**
   * Batch risk calculation
   */
  async calculateBatchRiskScores(contexts: RiskCalculationContext[]): Promise<Map<string, RiskScoreResult>> {
    const results = new Map<string, RiskScoreResult>();

    await Promise.all(
      contexts.map(async (context) => {
        try {
          const result = await this.calculateRiskScore(context);
          results.set(context.ruleId, result);
        } catch (error) {
          this.logger.error(`Failed to calculate risk for rule ${context.ruleId}: ${error}`);
        }
      })
    );

    return results;
  }

  /**
   * Get risk factors by category
   */
  getFactorsByCategory(factors: RiskFactor[], category: RiskFactorCategory): RiskFactor[] {
    return factors.filter(f => f.category === category);
  }

  /**
   * Compare risk scores
   */
  compareRiskScores(score1: RiskScoreResult, score2: RiskScoreResult): number {
    return score1.totalScore - score2.totalScore;
  }
}
