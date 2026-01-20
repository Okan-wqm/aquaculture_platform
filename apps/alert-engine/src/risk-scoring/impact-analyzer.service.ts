import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AlertRule, AlertSeverity } from '../database/entities/alert-rule.entity';

/**
 * Impact category types
 */
export enum ImpactCategory {
  BUSINESS = 'BUSINESS',
  TECHNICAL = 'TECHNICAL',
  FINANCIAL = 'FINANCIAL',
  COMPLIANCE = 'COMPLIANCE',
  OPERATIONAL = 'OPERATIONAL',
  ENVIRONMENTAL = 'ENVIRONMENTAL',
  REPUTATION = 'REPUTATION',
}

/**
 * Impact level
 */
export enum ImpactLevel {
  CRITICAL = 'CRITICAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
  NEGLIGIBLE = 'NEGLIGIBLE',
}

/**
 * Impact context for analysis
 */
export interface ImpactAnalysisContext {
  tenantId: string;
  ruleId: string;
  farmId?: string;
  sensorId?: string;
  currentValue: number;
  affectedAssets?: string[];
  affectedProcesses?: string[];
}

/**
 * Category impact result
 */
export interface CategoryImpact {
  category: ImpactCategory;
  level: ImpactLevel;
  score: number; // 0-100
  factors: string[];
  mitigation?: string;
}

/**
 * Impact analysis result
 */
export interface ImpactAnalysisResult {
  totalImpactScore: number; // 0-100
  businessImpact: CategoryImpact;
  technicalImpact: CategoryImpact;
  financialImpact: CategoryImpact;
  complianceImpact: CategoryImpact;
  operationalImpact?: CategoryImpact;
  environmentalImpact?: CategoryImpact;
  reputationImpact?: CategoryImpact;
  affectedSystems: string[];
  estimatedDowntime?: number; // minutes
  estimatedCost?: number;
  summary: string;
  analyzedAt: Date;
}

/**
 * Asset configuration for impact calculation
 */
export interface AssetConfiguration {
  id: string;
  name: string;
  criticality: number; // 1-5
  dependencies: string[];
  businessValue: number; // monetary value
  slaRequirements?: {
    uptime: number; // percentage
    responseTime: number; // ms
  };
}

/**
 * Impact weights by severity
 */
const SEVERITY_IMPACT_WEIGHTS: Record<AlertSeverity, number> = {
  [AlertSeverity.CRITICAL]: 1.0,
  [AlertSeverity.HIGH]: 0.75,
  [AlertSeverity.MEDIUM]: 0.5,
  [AlertSeverity.WARNING]: 0.4,
  [AlertSeverity.LOW]: 0.25,
  [AlertSeverity.INFO]: 0.1,
};

/**
 * Category weights for total impact calculation
 */
const CATEGORY_WEIGHTS: Record<ImpactCategory, number> = {
  [ImpactCategory.BUSINESS]: 0.25,
  [ImpactCategory.TECHNICAL]: 0.15,
  [ImpactCategory.FINANCIAL]: 0.20,
  [ImpactCategory.COMPLIANCE]: 0.15,
  [ImpactCategory.OPERATIONAL]: 0.10,
  [ImpactCategory.ENVIRONMENTAL]: 0.10,
  [ImpactCategory.REPUTATION]: 0.05,
};

@Injectable()
export class ImpactAnalyzerService {
  private readonly logger = new Logger(ImpactAnalyzerService.name);
  private assetConfigurations: Map<string, AssetConfiguration> = new Map();

  constructor(
    @InjectRepository(AlertRule)
    private readonly alertRuleRepository: Repository<AlertRule>,
  ) {}

  /**
   * Analyze impact for an alert context
   */
  async analyzeImpact(context: ImpactAnalysisContext): Promise<ImpactAnalysisResult> {
    this.logger.debug(`Analyzing impact for rule ${context.ruleId}`);

    // Get rule for context
    const rule = await this.alertRuleRepository.findOne({
      where: { id: context.ruleId, tenantId: context.tenantId },
    });

    const severity = rule?.severity || AlertSeverity.MEDIUM;
    const severityWeight = SEVERITY_IMPACT_WEIGHTS[severity];

    // Analyze each impact category
    const businessImpact = this.analyzeBusinessImpact(context, severityWeight);
    const technicalImpact = this.analyzeTechnicalImpact(context, severityWeight);
    const financialImpact = this.analyzeFinancialImpact(context, severityWeight);
    const complianceImpact = this.analyzeComplianceImpact(context, severityWeight);
    const operationalImpact = this.analyzeOperationalImpact(context, severityWeight);
    const environmentalImpact = this.analyzeEnvironmentalImpact(context, severityWeight);
    const reputationImpact = this.analyzeReputationImpact(context, severityWeight);

    // Calculate total impact score
    const allImpacts = [
      businessImpact,
      technicalImpact,
      financialImpact,
      complianceImpact,
      operationalImpact,
      environmentalImpact,
      reputationImpact,
    ];

    const totalImpactScore = this.calculateTotalImpactScore(allImpacts);

    // Determine affected systems
    const affectedSystems = this.identifyAffectedSystems(context);

    // Estimate downtime
    const estimatedDowntime = this.estimateDowntime(totalImpactScore, severity);

    // Estimate cost
    const estimatedCost = this.estimateCost(totalImpactScore, context);

    // Generate summary
    const summary = this.generateSummary(totalImpactScore, allImpacts);

    return {
      totalImpactScore,
      businessImpact,
      technicalImpact,
      financialImpact,
      complianceImpact,
      operationalImpact,
      environmentalImpact,
      reputationImpact,
      affectedSystems,
      estimatedDowntime,
      estimatedCost,
      summary,
      analyzedAt: new Date(),
    };
  }

  /**
   * Analyze business impact
   */
  analyzeBusinessImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 50 * severityWeight;

    // Check affected processes
    if (context.affectedProcesses?.length) {
      score += context.affectedProcesses.length * 10;
      factors.push(`${context.affectedProcesses.length} business processes affected`);
    }

    // Check asset criticality
    if (context.affectedAssets?.length) {
      const criticalAssets = context.affectedAssets.filter(assetId => {
        const config = this.assetConfigurations.get(assetId);
        return config && config.criticality >= 4;
      });

      if (criticalAssets.length > 0) {
        score += criticalAssets.length * 15;
        factors.push(`${criticalAssets.length} critical assets at risk`);
      }
    }

    // Check farm impact for aquaculture context
    if (context.farmId) {
      score += 10;
      factors.push('Farm operations may be affected');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.BUSINESS,
      level,
      score,
      factors,
      mitigation: this.suggestBusinessMitigation(level),
    };
  }

  /**
   * Analyze technical impact
   */
  analyzeTechnicalImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 40 * severityWeight;

    // Sensor-related impact
    if (context.sensorId) {
      score += 20;
      factors.push('Sensor monitoring affected');
    }

    // Check asset dependencies
    if (context.affectedAssets?.length) {
      const totalDependencies = context.affectedAssets.reduce((count, assetId) => {
        const config = this.assetConfigurations.get(assetId);
        return count + (config?.dependencies?.length || 0);
      }, 0);

      if (totalDependencies > 0) {
        score += Math.min(30, totalDependencies * 5);
        factors.push(`${totalDependencies} system dependencies identified`);
      }
    }

    // Value deviation impact
    if (context.currentValue > 100) {
      score += 10;
      factors.push('Significant value deviation detected');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.TECHNICAL,
      level,
      score,
      factors,
      mitigation: this.suggestTechnicalMitigation(level),
    };
  }

  /**
   * Analyze financial impact
   */
  analyzeFinancialImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 30 * severityWeight;
    let estimatedLoss = 0;

    // Calculate potential loss from affected assets
    if (context.affectedAssets?.length) {
      for (const assetId of context.affectedAssets) {
        const config = this.assetConfigurations.get(assetId);
        if (config?.businessValue) {
          estimatedLoss += config.businessValue * 0.1; // 10% potential loss
        }
      }

      if (estimatedLoss > 0) {
        score += Math.min(50, estimatedLoss / 1000);
        factors.push(`Estimated financial exposure: $${estimatedLoss.toFixed(2)}`);
      }
    }

    // Farm operations financial impact
    if (context.farmId) {
      score += 15;
      factors.push('Potential production losses');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.FINANCIAL,
      level,
      score,
      factors,
      mitigation: this.suggestFinancialMitigation(level),
    };
  }

  /**
   * Analyze compliance impact
   */
  analyzeComplianceImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 20 * severityWeight;

    // SLA violations
    if (context.affectedAssets?.length) {
      const slaRisks = context.affectedAssets.filter(assetId => {
        const config = this.assetConfigurations.get(assetId);
        return config?.slaRequirements?.uptime && config.slaRequirements.uptime >= 99.9;
      });

      if (slaRisks.length > 0) {
        score += slaRisks.length * 20;
        factors.push(`${slaRisks.length} SLA commitments at risk`);
      }
    }

    // Regulatory concerns for aquaculture
    if (context.farmId) {
      score += 10;
      factors.push('Environmental compliance monitoring affected');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.COMPLIANCE,
      level,
      score,
      factors,
      mitigation: this.suggestComplianceMitigation(level),
    };
  }

  /**
   * Analyze operational impact
   */
  analyzeOperationalImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 35 * severityWeight;

    if (context.affectedProcesses?.length) {
      score += context.affectedProcesses.length * 8;
      factors.push('Operational workflows disrupted');
    }

    if (context.sensorId) {
      score += 15;
      factors.push('Real-time monitoring capability affected');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.OPERATIONAL,
      level,
      score,
      factors,
      mitigation: this.suggestOperationalMitigation(level),
    };
  }

  /**
   * Analyze environmental impact
   */
  analyzeEnvironmentalImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 25 * severityWeight;

    // Aquaculture specific environmental concerns
    if (context.farmId) {
      score += 20;
      factors.push('Aquatic ecosystem monitoring affected');
    }

    if (context.sensorId) {
      score += 10;
      factors.push('Environmental sensor data may be compromised');
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.ENVIRONMENTAL,
      level,
      score,
      factors,
      mitigation: this.suggestEnvironmentalMitigation(level),
    };
  }

  /**
   * Analyze reputation impact
   */
  analyzeReputationImpact(context: ImpactAnalysisContext, severityWeight: number): CategoryImpact {
    const factors: string[] = [];
    let score = 15 * severityWeight;

    // Critical assets affect reputation more
    if (context.affectedAssets?.length) {
      const criticalCount = context.affectedAssets.filter(assetId => {
        const config = this.assetConfigurations.get(assetId);
        return config && config.criticality >= 5;
      }).length;

      if (criticalCount > 0) {
        score += criticalCount * 20;
        factors.push('Customer-facing systems potentially affected');
      }
    }

    score = Math.min(100, Math.max(0, score));
    const level = this.scoreToLevel(score);

    return {
      category: ImpactCategory.REPUTATION,
      level,
      score,
      factors,
      mitigation: this.suggestReputationMitigation(level),
    };
  }

  /**
   * Calculate total impact score from all categories
   */
  calculateTotalImpactScore(impacts: CategoryImpact[]): number {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const impact of impacts) {
      const weight = CATEGORY_WEIGHTS[impact.category] || 0.1;
      weightedSum += impact.score * weight;
      totalWeight += weight;
    }

    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    return Math.round(score * 100) / 100;
  }

  /**
   * Convert score to impact level
   */
  scoreToLevel(score: number): ImpactLevel {
    if (score >= 80) return ImpactLevel.CRITICAL;
    if (score >= 60) return ImpactLevel.HIGH;
    if (score >= 40) return ImpactLevel.MEDIUM;
    if (score >= 20) return ImpactLevel.LOW;
    return ImpactLevel.NEGLIGIBLE;
  }

  /**
   * Identify affected systems
   */
  identifyAffectedSystems(context: ImpactAnalysisContext): string[] {
    const systems: Set<string> = new Set();

    if (context.sensorId) {
      systems.add('Sensor Network');
    }

    if (context.farmId) {
      systems.add('Farm Management System');
      systems.add('Environmental Monitoring');
    }

    if (context.affectedAssets?.length) {
      systems.add('Asset Management');
    }

    if (context.affectedProcesses?.length) {
      systems.add('Process Automation');
    }

    return Array.from(systems);
  }

  /**
   * Estimate downtime in minutes
   */
  estimateDowntime(impactScore: number, severity: AlertSeverity): number {
    const baseDowntime: Record<AlertSeverity, number> = {
      [AlertSeverity.CRITICAL]: 240,
      [AlertSeverity.HIGH]: 120,
      [AlertSeverity.MEDIUM]: 60,
      [AlertSeverity.WARNING]: 45,
      [AlertSeverity.LOW]: 30,
      [AlertSeverity.INFO]: 0,
    };

    const base = baseDowntime[severity];
    const multiplier = impactScore / 50; // Scale by impact

    return Math.round(base * multiplier);
  }

  /**
   * Estimate cost impact
   */
  estimateCost(impactScore: number, context: ImpactAnalysisContext): number {
    let baseCost = impactScore * 100; // $100 per impact point

    if (context.affectedAssets?.length) {
      for (const assetId of context.affectedAssets) {
        const config = this.assetConfigurations.get(assetId);
        if (config?.businessValue) {
          baseCost += config.businessValue * (impactScore / 100);
        }
      }
    }

    return Math.round(baseCost * 100) / 100;
  }

  /**
   * Generate impact summary
   */
  generateSummary(totalScore: number, impacts: CategoryImpact[]): string {
    const level = this.scoreToLevel(totalScore);
    const highImpacts = impacts.filter(i => i.score >= 60);

    let summary = `Overall ${level} impact (score: ${totalScore.toFixed(1)})`;

    if (highImpacts.length > 0) {
      const categories = highImpacts.map(i => i.category.toLowerCase()).join(', ');
      summary += `. High concern areas: ${categories}`;
    }

    return summary;
  }

  /**
   * Register asset configuration
   */
  registerAsset(config: AssetConfiguration): void {
    this.assetConfigurations.set(config.id, config);
  }

  /**
   * Get asset configuration
   */
  getAssetConfiguration(assetId: string): AssetConfiguration | undefined {
    return this.assetConfigurations.get(assetId);
  }

  /**
   * Mitigation suggestion methods
   */
  private suggestBusinessMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Activate business continuity plan immediately';
      case ImpactLevel.HIGH:
        return 'Notify business stakeholders and prepare contingency';
      case ImpactLevel.MEDIUM:
        return 'Monitor situation and brief management';
      default:
        return 'Continue normal operations with awareness';
    }
  }

  private suggestTechnicalMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Engage incident response team, consider failover';
      case ImpactLevel.HIGH:
        return 'Escalate to engineering team, prepare rollback';
      case ImpactLevel.MEDIUM:
        return 'Investigate root cause, implement workaround';
      default:
        return 'Log for review, continue monitoring';
    }
  }

  private suggestFinancialMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Alert finance team, document for insurance';
      case ImpactLevel.HIGH:
        return 'Calculate exposure, prepare cost mitigation';
      default:
        return 'Monitor and document potential costs';
    }
  }

  private suggestComplianceMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Notify compliance officer, document incident';
      case ImpactLevel.HIGH:
        return 'Review regulatory requirements, prepare reports';
      default:
        return 'Document for compliance records';
    }
  }

  private suggestOperationalMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Implement emergency procedures';
      case ImpactLevel.HIGH:
        return 'Activate backup processes';
      default:
        return 'Continue with heightened monitoring';
    }
  }

  private suggestEnvironmentalMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Activate environmental emergency response';
      case ImpactLevel.HIGH:
        return 'Increase environmental monitoring frequency';
      default:
        return 'Document environmental observations';
    }
  }

  private suggestReputationMitigation(level: ImpactLevel): string {
    switch (level) {
      case ImpactLevel.CRITICAL:
        return 'Prepare stakeholder communications';
      case ImpactLevel.HIGH:
        return 'Alert PR team, monitor social channels';
      default:
        return 'No immediate action required';
    }
  }
}
