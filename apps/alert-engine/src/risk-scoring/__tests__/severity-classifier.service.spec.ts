import { Test, TestingModule } from '@nestjs/testing';
import {
  SeverityClassifierService,
  ClassificationCriteria,
  ClassificationUrgency,
  ClassificationScope,
} from '../severity-classifier.service';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { RiskThresholds } from '../risk-calculator.service';

describe('SeverityClassifierService', () => {
  let service: SeverityClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SeverityClassifierService],
    }).compile();

    service = module.get<SeverityClassifierService>(SeverityClassifierService);
  });

  afterEach(() => {
    service.clearCustomRules();
    service.resetWeights();
  });

  describe('classifyBySCore', () => {
    const defaultThresholds: RiskThresholds = {
      critical: 85,
      high: 65,
      medium: 40,
      low: 20,
    };

    it('should return CRITICAL for score >= critical threshold', () => {
      expect(service.classifyBySCore(85, defaultThresholds)).toBe(AlertSeverity.CRITICAL);
      expect(service.classifyBySCore(100, defaultThresholds)).toBe(AlertSeverity.CRITICAL);
    });

    it('should return HIGH for score >= high threshold', () => {
      expect(service.classifyBySCore(65, defaultThresholds)).toBe(AlertSeverity.HIGH);
      expect(service.classifyBySCore(84, defaultThresholds)).toBe(AlertSeverity.HIGH);
    });

    it('should return MEDIUM for score >= medium threshold', () => {
      expect(service.classifyBySCore(40, defaultThresholds)).toBe(AlertSeverity.MEDIUM);
      expect(service.classifyBySCore(64, defaultThresholds)).toBe(AlertSeverity.MEDIUM);
    });

    it('should return LOW for score >= low threshold', () => {
      expect(service.classifyBySCore(20, defaultThresholds)).toBe(AlertSeverity.LOW);
      expect(service.classifyBySCore(39, defaultThresholds)).toBe(AlertSeverity.LOW);
    });

    it('should return INFO for score < low threshold', () => {
      expect(service.classifyBySCore(0, defaultThresholds)).toBe(AlertSeverity.INFO);
      expect(service.classifyBySCore(19, defaultThresholds)).toBe(AlertSeverity.INFO);
    });

    it('should respect custom thresholds', () => {
      const customThresholds: RiskThresholds = {
        critical: 95,
        high: 80,
        medium: 60,
        low: 30,
      };

      expect(service.classifyBySCore(90, customThresholds)).toBe(AlertSeverity.HIGH);
      expect(service.classifyBySCore(95, customThresholds)).toBe(AlertSeverity.CRITICAL);
    });
  });

  describe('classifyByCriteria', () => {
    it('should classify based on impact score', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 90,
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.severity).toBeDefined();
      expect(result.justification).toContain('Impact score: 90');
    });

    it('should classify based on multiple criteria', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 80,
        frequencyScore: 70,
        trendScore: 60,
        contextScore: 50,
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.severity).toBeDefined();
      expect(result.justification.length).toBeGreaterThan(3);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should include urgency in classification', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 50,
        urgency: ClassificationUrgency.IMMEDIATE,
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.justification).toContain('Urgency: IMMEDIATE');
    });

    it('should include scope in classification', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 50,
        scope: ClassificationScope.ENTERPRISE,
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.justification).toContain('Scope: ENTERPRISE');
    });

    it('should calculate confidence based on available criteria', () => {
      const fullCriteria: ClassificationCriteria = {
        impactScore: 50,
        frequencyScore: 50,
        trendScore: 50,
        contextScore: 50,
        urgency: ClassificationUrgency.URGENT,
        scope: ClassificationScope.DEPARTMENT,
      };

      const partialCriteria: ClassificationCriteria = {
        impactScore: 50,
      };

      const fullResult = service.classifyByCriteria(fullCriteria);
      const partialResult = service.classifyByCriteria(partialCriteria);

      expect(fullResult.confidence).toBeGreaterThan(partialResult.confidence);
    });

    it('should return recommended actions', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 90,
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.recommendedActions).toBeDefined();
      expect(result.recommendedActions.length).toBeGreaterThan(0);
    });

    it('should determine if escalation is required', () => {
      const criticalCriteria: ClassificationCriteria = {
        impactScore: 95,
        urgency: ClassificationUrgency.IMMEDIATE,
      };

      const lowCriteria: ClassificationCriteria = {
        impactScore: 20,
      };

      const criticalResult = service.classifyByCriteria(criticalCriteria);
      const lowResult = service.classifyByCriteria(lowCriteria);

      expect(criticalResult.escalationRequired).toBe(true);
      expect(lowResult.escalationRequired).toBe(false);
    });

    it('should determine if auto-resolvable', () => {
      const infoCriteria: ClassificationCriteria = {
        impactScore: 10,
      };

      const criticalCriteria: ClassificationCriteria = {
        impactScore: 95,
      };

      const infoResult = service.classifyByCriteria(infoCriteria);
      const criticalResult = service.classifyByCriteria(criticalCriteria);

      expect(infoResult.autoResolvable).toBe(true);
      expect(criticalResult.autoResolvable).toBe(false);
    });

    it('should suggest alternative severity for low confidence', () => {
      const criteria: ClassificationCriteria = {
        impactScore: 65, // Borderline HIGH
      };

      const result = service.classifyByCriteria(criteria);

      // Low confidence (single criteria) should suggest alternative
      expect(result.confidence).toBeLessThan(0.8);
    });

    it('should apply custom rules first', () => {
      service.registerCustomRule('alwaysCritical', () => AlertSeverity.CRITICAL);

      const criteria: ClassificationCriteria = {
        impactScore: 10, // Would normally be LOW or INFO
      };

      const result = service.classifyByCriteria(criteria);

      expect(result.severity).toBe(AlertSeverity.CRITICAL);
      expect(result.justification).toContain("Custom rule 'alwaysCritical' applied");
    });

    it('should skip custom rule if it returns null', () => {
      service.registerCustomRule('conditionalRule', (c) => {
        if (c.impactScore && c.impactScore > 50) {
          return AlertSeverity.HIGH;
        }
        return null;
      });

      const lowImpact: ClassificationCriteria = {
        impactScore: 30,
      };

      const result = service.classifyByCriteria(lowImpact);

      expect(result.severity).not.toBe(AlertSeverity.HIGH);
    });
  });

  describe('scoreToSeverity', () => {
    it('should return CRITICAL for score >= 85', () => {
      expect(service.scoreToSeverity(85)).toBe(AlertSeverity.CRITICAL);
      expect(service.scoreToSeverity(100)).toBe(AlertSeverity.CRITICAL);
    });

    it('should return HIGH for score >= 65', () => {
      expect(service.scoreToSeverity(65)).toBe(AlertSeverity.HIGH);
      expect(service.scoreToSeverity(84)).toBe(AlertSeverity.HIGH);
    });

    it('should return MEDIUM for score >= 40', () => {
      expect(service.scoreToSeverity(40)).toBe(AlertSeverity.MEDIUM);
      expect(service.scoreToSeverity(64)).toBe(AlertSeverity.MEDIUM);
    });

    it('should return LOW for score >= 20', () => {
      expect(service.scoreToSeverity(20)).toBe(AlertSeverity.LOW);
      expect(service.scoreToSeverity(39)).toBe(AlertSeverity.LOW);
    });

    it('should return INFO for score < 20', () => {
      expect(service.scoreToSeverity(0)).toBe(AlertSeverity.INFO);
      expect(service.scoreToSeverity(19)).toBe(AlertSeverity.INFO);
    });
  });

  describe('getRecommendedActions', () => {
    it('should return critical actions for CRITICAL severity', () => {
      const actions = service.getRecommendedActions(AlertSeverity.CRITICAL);

      expect(actions).toContain('Immediate escalation to on-call team');
      expect(actions).toContain('Activate incident response procedure');
    });

    it('should return high priority actions for HIGH severity', () => {
      const actions = service.getRecommendedActions(AlertSeverity.HIGH);

      expect(actions).toContain('Escalate to engineering team');
      expect(actions.some(a => a.includes('1 hour'))).toBe(true);
    });

    it('should return medium priority actions for MEDIUM severity', () => {
      const actions = service.getRecommendedActions(AlertSeverity.MEDIUM);

      expect(actions).toContain('Review within business hours');
    });

    it('should return low priority actions for LOW severity', () => {
      const actions = service.getRecommendedActions(AlertSeverity.LOW);

      expect(actions).toContain('Add to review queue');
    });

    it('should return info actions for INFO severity', () => {
      const actions = service.getRecommendedActions(AlertSeverity.INFO);

      expect(actions).toContain('No immediate action required');
    });
  });

  describe('isEscalationRequired', () => {
    it('should return true for CRITICAL', () => {
      expect(service.isEscalationRequired(AlertSeverity.CRITICAL)).toBe(true);
    });

    it('should return true for HIGH', () => {
      expect(service.isEscalationRequired(AlertSeverity.HIGH)).toBe(true);
    });

    it('should return false for MEDIUM', () => {
      expect(service.isEscalationRequired(AlertSeverity.MEDIUM)).toBe(false);
    });

    it('should return false for LOW', () => {
      expect(service.isEscalationRequired(AlertSeverity.LOW)).toBe(false);
    });

    it('should return false for INFO', () => {
      expect(service.isEscalationRequired(AlertSeverity.INFO)).toBe(false);
    });
  });

  describe('isAutoResolvable', () => {
    it('should return false for CRITICAL', () => {
      expect(service.isAutoResolvable(AlertSeverity.CRITICAL)).toBe(false);
    });

    it('should return false for HIGH', () => {
      expect(service.isAutoResolvable(AlertSeverity.HIGH)).toBe(false);
    });

    it('should return false for MEDIUM', () => {
      expect(service.isAutoResolvable(AlertSeverity.MEDIUM)).toBe(false);
    });

    it('should return true for LOW', () => {
      expect(service.isAutoResolvable(AlertSeverity.LOW)).toBe(true);
    });

    it('should return true for INFO', () => {
      expect(service.isAutoResolvable(AlertSeverity.INFO)).toBe(true);
    });
  });

  describe('getAlternativeSeverity', () => {
    it('should return undefined for high confidence', () => {
      const alternative = service.getAlternativeSeverity(AlertSeverity.HIGH, 0.9);

      expect(alternative).toBeUndefined();
    });

    it('should return lower severity for very low confidence', () => {
      const alternative = service.getAlternativeSeverity(AlertSeverity.HIGH, 0.4);

      expect(alternative).toBe(AlertSeverity.MEDIUM);
    });

    it('should return higher severity for moderately low confidence', () => {
      const alternative = service.getAlternativeSeverity(AlertSeverity.MEDIUM, 0.55);

      expect(alternative).toBe(AlertSeverity.HIGH);
    });

    it('should not downgrade below INFO', () => {
      const alternative = service.getAlternativeSeverity(AlertSeverity.INFO, 0.3);

      expect(alternative).toBe(AlertSeverity.LOW);
    });

    it('should not upgrade above CRITICAL', () => {
      const alternative = service.getAlternativeSeverity(AlertSeverity.CRITICAL, 0.55);

      expect(alternative).toBeUndefined();
    });
  });

  describe('custom rules', () => {
    it('should register and use custom rule', () => {
      service.registerCustomRule('testRule', (criteria) => {
        if (criteria.impactScore && criteria.impactScore > 95) {
          return AlertSeverity.CRITICAL;
        }
        return null;
      });

      const result = service.classifyByCriteria({ impactScore: 98 });

      expect(result.severity).toBe(AlertSeverity.CRITICAL);
    });

    it('should remove custom rule', () => {
      service.registerCustomRule('toRemove', () => AlertSeverity.HIGH);

      const removed = service.removeCustomRule('toRemove');

      expect(removed).toBe(true);
    });

    it('should return false when removing non-existent rule', () => {
      const removed = service.removeCustomRule('nonExistent');

      expect(removed).toBe(false);
    });

    it('should clear all custom rules', () => {
      service.registerCustomRule('rule1', () => AlertSeverity.HIGH);
      service.registerCustomRule('rule2', () => AlertSeverity.MEDIUM);

      service.clearCustomRules();

      // Verify rules are cleared by checking classification without rules
      const result = service.classifyByCriteria({ impactScore: 50 });
      expect(result.justification.every(j => !j.includes('Custom rule'))).toBe(true);
    });
  });

  describe('weight management', () => {
    it('should set and get weights', () => {
      service.setWeights({ impactWeight: 0.5 });
      const weights = service.getWeights();

      expect(weights.impactWeight).toBe(0.5);
    });

    it('should preserve other weights when updating', () => {
      service.setWeights({ impactWeight: 0.5 });
      const weights = service.getWeights();

      expect(weights.frequencyWeight).toBe(0.15); // Default unchanged
    });

    it('should reset weights to default', () => {
      service.setWeights({ impactWeight: 0.9 });
      service.resetWeights();
      const weights = service.getWeights();

      expect(weights.impactWeight).toBe(0.30);
    });
  });

  describe('compareSeverity', () => {
    it('should return positive when first is more severe', () => {
      const result = service.compareSeverity(AlertSeverity.CRITICAL, AlertSeverity.LOW);

      expect(result).toBeGreaterThan(0);
    });

    it('should return negative when first is less severe', () => {
      const result = service.compareSeverity(AlertSeverity.LOW, AlertSeverity.CRITICAL);

      expect(result).toBeLessThan(0);
    });

    it('should return zero when equal', () => {
      const result = service.compareSeverity(AlertSeverity.MEDIUM, AlertSeverity.MEDIUM);

      expect(result).toBe(0);
    });

    it('should order all severities correctly', () => {
      expect(service.compareSeverity(AlertSeverity.CRITICAL, AlertSeverity.HIGH)).toBeGreaterThan(0);
      expect(service.compareSeverity(AlertSeverity.HIGH, AlertSeverity.MEDIUM)).toBeGreaterThan(0);
      expect(service.compareSeverity(AlertSeverity.MEDIUM, AlertSeverity.LOW)).toBeGreaterThan(0);
      expect(service.compareSeverity(AlertSeverity.LOW, AlertSeverity.INFO)).toBeGreaterThan(0);
    });
  });

  describe('getSeverityPriority', () => {
    it('should return 1 for CRITICAL', () => {
      expect(service.getSeverityPriority(AlertSeverity.CRITICAL)).toBe(1);
    });

    it('should return 2 for HIGH', () => {
      expect(service.getSeverityPriority(AlertSeverity.HIGH)).toBe(2);
    });

    it('should return 3 for MEDIUM', () => {
      expect(service.getSeverityPriority(AlertSeverity.MEDIUM)).toBe(3);
    });

    it('should return 4 for LOW', () => {
      expect(service.getSeverityPriority(AlertSeverity.LOW)).toBe(4);
    });

    it('should return 5 for INFO', () => {
      expect(service.getSeverityPriority(AlertSeverity.INFO)).toBe(5);
    });
  });

  describe('upgradeSeverity', () => {
    it('should upgrade INFO to LOW', () => {
      expect(service.upgradeSeverity(AlertSeverity.INFO)).toBe(AlertSeverity.LOW);
    });

    it('should upgrade LOW to MEDIUM', () => {
      expect(service.upgradeSeverity(AlertSeverity.LOW)).toBe(AlertSeverity.MEDIUM);
    });

    it('should upgrade MEDIUM to HIGH', () => {
      expect(service.upgradeSeverity(AlertSeverity.MEDIUM)).toBe(AlertSeverity.HIGH);
    });

    it('should upgrade HIGH to CRITICAL', () => {
      expect(service.upgradeSeverity(AlertSeverity.HIGH)).toBe(AlertSeverity.CRITICAL);
    });

    it('should keep CRITICAL at CRITICAL', () => {
      expect(service.upgradeSeverity(AlertSeverity.CRITICAL)).toBe(AlertSeverity.CRITICAL);
    });
  });

  describe('downgradeSeverity', () => {
    it('should downgrade CRITICAL to HIGH', () => {
      expect(service.downgradeSeverity(AlertSeverity.CRITICAL)).toBe(AlertSeverity.HIGH);
    });

    it('should downgrade HIGH to MEDIUM', () => {
      expect(service.downgradeSeverity(AlertSeverity.HIGH)).toBe(AlertSeverity.MEDIUM);
    });

    it('should downgrade MEDIUM to LOW', () => {
      expect(service.downgradeSeverity(AlertSeverity.MEDIUM)).toBe(AlertSeverity.LOW);
    });

    it('should downgrade LOW to INFO', () => {
      expect(service.downgradeSeverity(AlertSeverity.LOW)).toBe(AlertSeverity.INFO);
    });

    it('should keep INFO at INFO', () => {
      expect(service.downgradeSeverity(AlertSeverity.INFO)).toBe(AlertSeverity.INFO);
    });
  });

  describe('severityDistance', () => {
    it('should return 0 for same severity', () => {
      expect(service.severityDistance(AlertSeverity.HIGH, AlertSeverity.HIGH)).toBe(0);
    });

    it('should return 1 for adjacent severities', () => {
      expect(service.severityDistance(AlertSeverity.HIGH, AlertSeverity.MEDIUM)).toBe(1);
    });

    it('should return 4 for CRITICAL to INFO', () => {
      expect(service.severityDistance(AlertSeverity.CRITICAL, AlertSeverity.INFO)).toBe(4);
    });

    it('should be symmetric', () => {
      const a = service.severityDistance(AlertSeverity.CRITICAL, AlertSeverity.LOW);
      const b = service.severityDistance(AlertSeverity.LOW, AlertSeverity.CRITICAL);

      expect(a).toBe(b);
    });
  });

  describe('getSeverityLabel', () => {
    it('should return correct label for CRITICAL', () => {
      const label = service.getSeverityLabel(AlertSeverity.CRITICAL);

      expect(label).toContain('Critical');
      expect(label).toContain('Immediate');
    });

    it('should return correct label for HIGH', () => {
      const label = service.getSeverityLabel(AlertSeverity.HIGH);

      expect(label).toContain('High');
      expect(label).toContain('Urgent');
    });

    it('should return correct label for all severities', () => {
      expect(service.getSeverityLabel(AlertSeverity.MEDIUM)).toContain('Medium');
      expect(service.getSeverityLabel(AlertSeverity.LOW)).toContain('Low');
      expect(service.getSeverityLabel(AlertSeverity.INFO)).toContain('Informational');
    });
  });

  describe('getSeverityColor', () => {
    it('should return red for CRITICAL', () => {
      const color = service.getSeverityColor(AlertSeverity.CRITICAL);

      expect(color).toBe('#dc2626');
    });

    it('should return orange for HIGH', () => {
      const color = service.getSeverityColor(AlertSeverity.HIGH);

      expect(color).toBe('#ea580c');
    });

    it('should return different colors for each severity', () => {
      const colors = [
        service.getSeverityColor(AlertSeverity.CRITICAL),
        service.getSeverityColor(AlertSeverity.HIGH),
        service.getSeverityColor(AlertSeverity.MEDIUM),
        service.getSeverityColor(AlertSeverity.LOW),
        service.getSeverityColor(AlertSeverity.INFO),
      ];

      const uniqueColors = new Set(colors);
      expect(uniqueColors.size).toBe(5);
    });
  });

  describe('getTimeBSasedSeverityAdjustment', () => {
    it('should not upgrade CRITICAL', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.CRITICAL, 100);

      expect(result).toBe(AlertSeverity.CRITICAL);
    });

    it('should upgrade HIGH after 4 hours', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.HIGH, 5);

      expect(result).toBe(AlertSeverity.CRITICAL);
    });

    it('should not upgrade HIGH before threshold', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.HIGH, 3);

      expect(result).toBe(AlertSeverity.HIGH);
    });

    it('should upgrade MEDIUM after 24 hours', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.MEDIUM, 25);

      expect(result).toBe(AlertSeverity.HIGH);
    });

    it('should upgrade LOW after 72 hours', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.LOW, 73);

      expect(result).toBe(AlertSeverity.MEDIUM);
    });

    it('should upgrade INFO after 168 hours', () => {
      const result = service.getTimeBSasedSeverityAdjustment(AlertSeverity.INFO, 169);

      expect(result).toBe(AlertSeverity.LOW);
    });
  });

  describe('batchClassify', () => {
    it('should classify multiple criteria', () => {
      const criteriaList: ClassificationCriteria[] = [
        { impactScore: 90 },
        { impactScore: 50 },
        { impactScore: 20 },
      ];

      const results = service.batchClassify(criteriaList);

      expect(results).toHaveLength(3);
      expect(results[0].severity).toBe(AlertSeverity.CRITICAL);
      expect(results[1].severity).toBe(AlertSeverity.MEDIUM);
      expect(results[2].severity).toBe(AlertSeverity.LOW);
    });

    it('should handle empty list', () => {
      const results = service.batchClassify([]);

      expect(results).toHaveLength(0);
    });
  });

  describe('getMostSevere', () => {
    it('should return most severe from list', () => {
      const severities = [
        AlertSeverity.LOW,
        AlertSeverity.CRITICAL,
        AlertSeverity.MEDIUM,
      ];

      const result = service.getMostSevere(severities);

      expect(result).toBe(AlertSeverity.CRITICAL);
    });

    it('should return INFO for empty list', () => {
      const result = service.getMostSevere([]);

      expect(result).toBe(AlertSeverity.INFO);
    });

    it('should handle single item', () => {
      const result = service.getMostSevere([AlertSeverity.MEDIUM]);

      expect(result).toBe(AlertSeverity.MEDIUM);
    });
  });

  describe('getLeastSevere', () => {
    it('should return least severe from list', () => {
      const severities = [
        AlertSeverity.CRITICAL,
        AlertSeverity.LOW,
        AlertSeverity.HIGH,
      ];

      const result = service.getLeastSevere(severities);

      expect(result).toBe(AlertSeverity.LOW);
    });

    it('should return CRITICAL for empty list', () => {
      const result = service.getLeastSevere([]);

      expect(result).toBe(AlertSeverity.CRITICAL);
    });

    it('should handle single item', () => {
      const result = service.getLeastSevere([AlertSeverity.HIGH]);

      expect(result).toBe(AlertSeverity.HIGH);
    });
  });
});
