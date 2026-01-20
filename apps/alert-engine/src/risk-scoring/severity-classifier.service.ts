import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity } from '../database/entities/alert-rule.entity';
import { RiskThresholds } from './risk-calculator.service';

/**
 * Classification criteria
 */
export interface ClassificationCriteria {
  impactScore?: number;
  frequencyScore?: number;
  trendScore?: number;
  contextScore?: number;
  urgency?: ClassificationUrgency;
  scope?: ClassificationScope;
}

/**
 * Urgency level for classification
 */
export enum ClassificationUrgency {
  IMMEDIATE = 'IMMEDIATE',
  URGENT = 'URGENT',
  SCHEDULED = 'SCHEDULED',
  PLANNED = 'PLANNED',
  LOW = 'LOW',
}

/**
 * Scope of the issue
 */
export enum ClassificationScope {
  ENTERPRISE = 'ENTERPRISE',
  DEPARTMENT = 'DEPARTMENT',
  TEAM = 'TEAM',
  INDIVIDUAL = 'INDIVIDUAL',
  SYSTEM = 'SYSTEM',
}

/**
 * Classification result
 */
export interface ClassificationResult {
  severity: AlertSeverity;
  confidence: number;
  justification: string[];
  alternativeSeverity?: AlertSeverity;
  recommendedActions: string[];
  escalationRequired: boolean;
  autoResolvable: boolean;
}

/**
 * Severity weight configuration
 */
export interface SeverityWeights {
  impactWeight: number;
  frequencyWeight: number;
  trendWeight: number;
  contextWeight: number;
  urgencyWeight: number;
  scopeWeight: number;
}

/**
 * Default severity weights
 */
const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = {
  impactWeight: 0.30,
  frequencyWeight: 0.15,
  trendWeight: 0.15,
  contextWeight: 0.10,
  urgencyWeight: 0.20,
  scopeWeight: 0.10,
};

/**
 * Urgency scores
 */
const URGENCY_SCORES: Record<ClassificationUrgency, number> = {
  [ClassificationUrgency.IMMEDIATE]: 100,
  [ClassificationUrgency.URGENT]: 80,
  [ClassificationUrgency.SCHEDULED]: 50,
  [ClassificationUrgency.PLANNED]: 30,
  [ClassificationUrgency.LOW]: 10,
};

/**
 * Scope scores
 */
const SCOPE_SCORES: Record<ClassificationScope, number> = {
  [ClassificationScope.ENTERPRISE]: 100,
  [ClassificationScope.DEPARTMENT]: 70,
  [ClassificationScope.TEAM]: 50,
  [ClassificationScope.INDIVIDUAL]: 30,
  [ClassificationScope.SYSTEM]: 60,
};

@Injectable()
export class SeverityClassifierService {
  private readonly logger = new Logger(SeverityClassifierService.name);
  private weights: SeverityWeights = { ...DEFAULT_SEVERITY_WEIGHTS };
  private customRules: Map<string, (criteria: ClassificationCriteria) => AlertSeverity | null> = new Map();

  /**
   * Classify severity based on risk score
   */
  classifyBySCore(score: number, thresholds: RiskThresholds): AlertSeverity {
    if (score >= thresholds.critical) {
      return AlertSeverity.CRITICAL;
    }
    if (score >= thresholds.high) {
      return AlertSeverity.HIGH;
    }
    if (score >= thresholds.medium) {
      return AlertSeverity.MEDIUM;
    }
    if (score >= thresholds.low) {
      return AlertSeverity.LOW;
    }
    return AlertSeverity.INFO;
  }

  /**
   * Classify severity based on multiple criteria
   */
  classifyByCriteria(criteria: ClassificationCriteria): ClassificationResult {
    this.logger.debug('Classifying severity based on criteria');

    const justification: string[] = [];
    let totalScore = 0;
    let totalWeight = 0;

    // Check custom rules first
    for (const [ruleName, ruleFunc] of this.customRules) {
      const result = ruleFunc(criteria);
      if (result !== null) {
        justification.push(`Custom rule '${ruleName}' applied`);
        return this.buildClassificationResult(result, 1.0, justification);
      }
    }

    // Impact score contribution
    if (criteria.impactScore !== undefined) {
      totalScore += criteria.impactScore * this.weights.impactWeight;
      totalWeight += this.weights.impactWeight;
      justification.push(`Impact score: ${criteria.impactScore}`);
    }

    // Frequency score contribution
    if (criteria.frequencyScore !== undefined) {
      totalScore += criteria.frequencyScore * this.weights.frequencyWeight;
      totalWeight += this.weights.frequencyWeight;
      justification.push(`Frequency score: ${criteria.frequencyScore}`);
    }

    // Trend score contribution
    if (criteria.trendScore !== undefined) {
      totalScore += criteria.trendScore * this.weights.trendWeight;
      totalWeight += this.weights.trendWeight;
      justification.push(`Trend score: ${criteria.trendScore}`);
    }

    // Context score contribution
    if (criteria.contextScore !== undefined) {
      totalScore += criteria.contextScore * this.weights.contextWeight;
      totalWeight += this.weights.contextWeight;
      justification.push(`Context score: ${criteria.contextScore}`);
    }

    // Urgency contribution
    if (criteria.urgency !== undefined) {
      const urgencyScore = URGENCY_SCORES[criteria.urgency];
      totalScore += urgencyScore * this.weights.urgencyWeight;
      totalWeight += this.weights.urgencyWeight;
      justification.push(`Urgency: ${criteria.urgency}`);
    }

    // Scope contribution
    if (criteria.scope !== undefined) {
      const scopeScore = SCOPE_SCORES[criteria.scope];
      totalScore += scopeScore * this.weights.scopeWeight;
      totalWeight += this.weights.scopeWeight;
      justification.push(`Scope: ${criteria.scope}`);
    }

    // Normalize score
    const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;
    const confidence = totalWeight / this.getTotalPossibleWeight();

    // Determine severity
    const severity = this.scoreToSeverity(normalizedScore);

    return this.buildClassificationResult(severity, confidence, justification);
  }

  /**
   * Convert score to severity
   */
  scoreToSeverity(score: number): AlertSeverity {
    if (score >= 85) return AlertSeverity.CRITICAL;
    if (score >= 65) return AlertSeverity.HIGH;
    if (score >= 40) return AlertSeverity.MEDIUM;
    if (score >= 20) return AlertSeverity.LOW;
    return AlertSeverity.INFO;
  }

  /**
   * Build classification result
   */
  private buildClassificationResult(
    severity: AlertSeverity,
    confidence: number,
    justification: string[],
  ): ClassificationResult {
    const recommendedActions = this.getRecommendedActions(severity);
    const escalationRequired = this.isEscalationRequired(severity);
    const autoResolvable = this.isAutoResolvable(severity);
    const alternativeSeverity = this.getAlternativeSeverity(severity, confidence);

    return {
      severity,
      confidence: Math.round(confidence * 100) / 100,
      justification,
      alternativeSeverity,
      recommendedActions,
      escalationRequired,
      autoResolvable,
    };
  }

  /**
   * Get recommended actions based on severity
   */
  getRecommendedActions(severity: AlertSeverity): string[] {
    switch (severity) {
      case AlertSeverity.CRITICAL:
        return [
          'Immediate escalation to on-call team',
          'Activate incident response procedure',
          'Notify stakeholders immediately',
          'Begin root cause investigation',
          'Prepare status communication',
        ];
      case AlertSeverity.HIGH:
        return [
          'Escalate to engineering team',
          'Begin investigation within 1 hour',
          'Prepare mitigation plan',
          'Monitor for escalation',
        ];
      case AlertSeverity.MEDIUM:
        return [
          'Review within business hours',
          'Assign to appropriate team',
          'Document for trending analysis',
        ];
      case AlertSeverity.LOW:
        return [
          'Add to review queue',
          'Monitor for pattern development',
        ];
      case AlertSeverity.INFO:
        return [
          'Log for historical analysis',
          'No immediate action required',
        ];
      case AlertSeverity.WARNING:
        return [
          'Monitor situation',
          'Review during next scheduled check',
          'Document for trending analysis',
        ];
      default:
        return ['Review and classify appropriately'];
    }
  }

  /**
   * Determine if escalation is required
   */
  isEscalationRequired(severity: AlertSeverity): boolean {
    return severity === AlertSeverity.CRITICAL || severity === AlertSeverity.HIGH;
  }

  /**
   * Determine if issue can be auto-resolved
   */
  isAutoResolvable(severity: AlertSeverity): boolean {
    return severity === AlertSeverity.INFO || severity === AlertSeverity.LOW;
  }

  /**
   * Get alternative severity suggestion
   */
  getAlternativeSeverity(severity: AlertSeverity, confidence: number): AlertSeverity | undefined {
    if (confidence >= 0.8) return undefined;

    // Suggest adjacent severity levels for low confidence
    const severityOrder = [
      AlertSeverity.INFO,
      AlertSeverity.LOW,
      AlertSeverity.MEDIUM,
      AlertSeverity.HIGH,
      AlertSeverity.CRITICAL,
    ];

    const currentIndex = severityOrder.indexOf(severity);

    if (currentIndex > 0 && confidence < 0.5) {
      return severityOrder[currentIndex - 1];
    }

    if (currentIndex < severityOrder.length - 1 && confidence < 0.6) {
      return severityOrder[currentIndex + 1];
    }

    return undefined;
  }

  /**
   * Get total possible weight
   */
  private getTotalPossibleWeight(): number {
    return Object.values(this.weights).reduce((sum, w) => sum + w, 0);
  }

  /**
   * Register custom classification rule
   */
  registerCustomRule(
    name: string,
    rule: (criteria: ClassificationCriteria) => AlertSeverity | null,
  ): void {
    this.customRules.set(name, rule);
    this.logger.log(`Registered custom classification rule: ${name}`);
  }

  /**
   * Remove custom classification rule
   */
  removeCustomRule(name: string): boolean {
    return this.customRules.delete(name);
  }

  /**
   * Clear all custom rules
   */
  clearCustomRules(): void {
    this.customRules.clear();
  }

  /**
   * Update severity weights
   */
  setWeights(weights: Partial<SeverityWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }

  /**
   * Get current weights
   */
  getWeights(): SeverityWeights {
    return { ...this.weights };
  }

  /**
   * Reset weights to default
   */
  resetWeights(): void {
    this.weights = { ...DEFAULT_SEVERITY_WEIGHTS };
  }

  /**
   * Compare severities
   */
  compareSeverity(a: AlertSeverity, b: AlertSeverity): number {
    const order: Record<AlertSeverity, number> = {
      [AlertSeverity.INFO]: 0,
      [AlertSeverity.LOW]: 1,
      [AlertSeverity.WARNING]: 2,
      [AlertSeverity.MEDIUM]: 3,
      [AlertSeverity.HIGH]: 4,
      [AlertSeverity.CRITICAL]: 5,
    };

    return order[a] - order[b];
  }

  /**
   * Get severity priority
   */
  getSeverityPriority(severity: AlertSeverity): number {
    const priorities: Record<AlertSeverity, number> = {
      [AlertSeverity.CRITICAL]: 1,
      [AlertSeverity.HIGH]: 2,
      [AlertSeverity.MEDIUM]: 3,
      [AlertSeverity.WARNING]: 4,
      [AlertSeverity.LOW]: 5,
      [AlertSeverity.INFO]: 6,
    };

    return priorities[severity];
  }

  /**
   * Upgrade severity by one level
   */
  upgradeSeverity(severity: AlertSeverity): AlertSeverity {
    switch (severity) {
      case AlertSeverity.INFO:
        return AlertSeverity.LOW;
      case AlertSeverity.LOW:
        return AlertSeverity.WARNING;
      case AlertSeverity.WARNING:
        return AlertSeverity.MEDIUM;
      case AlertSeverity.MEDIUM:
        return AlertSeverity.HIGH;
      case AlertSeverity.HIGH:
        return AlertSeverity.CRITICAL;
      case AlertSeverity.CRITICAL:
        return AlertSeverity.CRITICAL;
      default:
        return AlertSeverity.MEDIUM;
    }
  }

  /**
   * Downgrade severity by one level
   */
  downgradeSeverity(severity: AlertSeverity): AlertSeverity {
    switch (severity) {
      case AlertSeverity.CRITICAL:
        return AlertSeverity.HIGH;
      case AlertSeverity.HIGH:
        return AlertSeverity.MEDIUM;
      case AlertSeverity.MEDIUM:
        return AlertSeverity.WARNING;
      case AlertSeverity.WARNING:
        return AlertSeverity.LOW;
      case AlertSeverity.LOW:
        return AlertSeverity.INFO;
      case AlertSeverity.INFO:
        return AlertSeverity.INFO;
      default:
        return AlertSeverity.INFO;
    }
  }

  /**
   * Calculate severity distance
   */
  severityDistance(a: AlertSeverity, b: AlertSeverity): number {
    return Math.abs(this.compareSeverity(a, b));
  }

  /**
   * Get severity label for display
   */
  getSeverityLabel(severity: AlertSeverity): string {
    const labels: Record<AlertSeverity, string> = {
      [AlertSeverity.CRITICAL]: 'Critical - Immediate Action Required',
      [AlertSeverity.HIGH]: 'High - Urgent Attention Needed',
      [AlertSeverity.MEDIUM]: 'Medium - Review Required',
      [AlertSeverity.WARNING]: 'Warning - Attention Recommended',
      [AlertSeverity.LOW]: 'Low - Monitor',
      [AlertSeverity.INFO]: 'Informational',
    };

    return labels[severity];
  }

  /**
   * Get severity color for UI
   */
  getSeverityColor(severity: AlertSeverity): string {
    const colors: Record<AlertSeverity, string> = {
      [AlertSeverity.CRITICAL]: '#dc2626', // red-600
      [AlertSeverity.HIGH]: '#ea580c', // orange-600
      [AlertSeverity.MEDIUM]: '#ca8a04', // yellow-600
      [AlertSeverity.WARNING]: '#eab308', // yellow-500
      [AlertSeverity.LOW]: '#2563eb', // blue-600
      [AlertSeverity.INFO]: '#6b7280', // gray-500
    };

    return colors[severity];
  }

  /**
   * Calculate time-based severity adjustment
   * Severity may increase over time if not addressed
   */
  getTimeBasedSeverityAdjustment(
    originalSeverity: AlertSeverity,
    hoursElapsed: number,
  ): AlertSeverity {
    // No adjustment for critical - already at max
    if (originalSeverity === AlertSeverity.CRITICAL) {
      return AlertSeverity.CRITICAL;
    }

    // Define upgrade thresholds in hours
    const upgradeThresholds: Record<AlertSeverity, number> = {
      [AlertSeverity.INFO]: 168, // 1 week
      [AlertSeverity.LOW]: 72, // 3 days
      [AlertSeverity.WARNING]: 48, // 2 days
      [AlertSeverity.MEDIUM]: 24, // 1 day
      [AlertSeverity.HIGH]: 4, // 4 hours
      [AlertSeverity.CRITICAL]: 0, // N/A
    };

    const threshold = upgradeThresholds[originalSeverity];
    if (hoursElapsed >= threshold) {
      return this.upgradeSeverity(originalSeverity);
    }

    return originalSeverity;
  }

  /**
   * Batch classify multiple criteria
   */
  batchClassify(criteriaList: ClassificationCriteria[]): ClassificationResult[] {
    return criteriaList.map(criteria => this.classifyByCriteria(criteria));
  }

  /**
   * Get most severe from list
   */
  getMostSevere(severities: AlertSeverity[]): AlertSeverity {
    if (severities.length === 0) return AlertSeverity.INFO;

    return severities.reduce((most, current) =>
      this.compareSeverity(current, most) > 0 ? current : most
    );
  }

  /**
   * Get least severe from list
   */
  getLeastSevere(severities: AlertSeverity[]): AlertSeverity {
    if (severities.length === 0) return AlertSeverity.CRITICAL;

    return severities.reduce((least, current) =>
      this.compareSeverity(current, least) < 0 ? current : least
    );
  }
}
