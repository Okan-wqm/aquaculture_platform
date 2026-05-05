import { DataQualityService, QualityIssue } from '../data-quality.service';
import { SensorReadings } from '../../../database/entities/sensor-reading.entity';

describe('DataQualityService', () => {
  let service: DataQualityService;

  beforeEach(() => {
    service = new DataQualityService();
  });

  describe('calculateQuality', () => {
    it('should return 100 for valid readings within range', () => {
      const readings: SensorReadings = {
        temperature: 25,
        ph: 7.0,
        dissolvedOxygen: 8,
        salinity: 20,
      };
      expect(service.calculateQuality(readings)).toBe(100);
    });

    it('should deduct points for out-of-range values', () => {
      const readings: SensorReadings = {
        temperature: 60, // Out of range (max 50)
        ph: 7.0,
      };
      expect(service.calculateQuality(readings)).toBeLessThan(100);
    });

    it('should return 0 for empty readings', () => {
      const readings: SensorReadings = {};
      expect(service.calculateQuality(readings)).toBe(0);
    });

    it('should handle multiple out-of-range values', () => {
      const readings: SensorReadings = {
        temperature: 60, // Out of range
        ph: 15, // Out of range (max 14)
        dissolvedOxygen: 25, // Out of range (max 20)
      };
      const quality = service.calculateQuality(readings);
      expect(quality).toBeLessThan(50);
    });
  });

  describe('assess', () => {
    it('should identify out-of-range issues', () => {
      const readings: SensorReadings = {
        temperature: -20, // Below min (-10)
      };
      const assessment = service.assess(readings);

      expect(assessment.issues.length).toBeGreaterThan(0);
      const firstIssue = assessment.issues[0];
      // strictNullChecks: array index returns `T | undefined`; the
      // length assertion above narrows logically but not at the type
      // level. Pull the element into a typed local so the rest of
      // the test reads clean without `!` non-null assertions.
      expect(firstIssue).toBeDefined();
      if (!firstIssue) return;
      expect(firstIssue.type).toBe('out_of_range');
      expect(firstIssue.metric).toBe('temperature');
    });

    it('should identify missing readings', () => {
      const assessment = service.assess({});
      expect(assessment.issues.some((i) => i.type === 'missing')).toBe(true);
    });

    it('should identify invalid values (NaN)', () => {
      const readings = { temperature: NaN } as unknown as SensorReadings;
      const assessment = service.assess(readings);
      expect(assessment.issues.some((i) => i.type === 'invalid')).toBe(true);
    });

    it('should identify invalid values (Infinity)', () => {
      const readings = { temperature: Infinity } as unknown as SensorReadings;
      const assessment = service.assess(readings);
      expect(assessment.issues.some((i) => i.type === 'invalid')).toBe(true);
    });

    it('should mark critical metrics with error severity', () => {
      const readings: SensorReadings = {
        ph: 20, // Critical metric, out of range
      };
      const assessment = service.assess(readings);
      const phIssue = assessment.issues.find((i) => i.metric === 'ph');
      expect(phIssue?.severity).toBe('error');
    });

    it('should include expected range in issues', () => {
      const readings: SensorReadings = {
        temperature: 60,
      };
      const assessment = service.assess(readings);
      const issue = assessment.issues[0];
      expect(issue).toBeDefined();
      if (!issue) return;
      expect(issue.expectedRange).toEqual({ min: -10, max: 50 });
    });
  });

  describe('validate', () => {
    it('should return valid for good readings', () => {
      const readings: SensorReadings = {
        temperature: 25,
        ph: 7.0,
      };
      const result = service.validate(readings);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should return invalid with error messages', () => {
      const readings = { temperature: NaN } as unknown as SensorReadings;
      const result = service.validate(readings);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('hasValidMetrics', () => {
    it('should return true for readings with valid metrics', () => {
      const readings: SensorReadings = { temperature: 25 };
      expect(service.hasValidMetrics(readings)).toBe(true);
    });

    it('should return false for empty readings', () => {
      expect(service.hasValidMetrics({})).toBe(false);
    });

    it('should return false for null readings', () => {
      expect(service.hasValidMetrics(null as unknown as SensorReadings)).toBe(false);
    });

    it('should return false for readings with only invalid values', () => {
      const readings = { temperature: NaN } as unknown as SensorReadings;
      expect(service.hasValidMetrics(readings)).toBe(false);
    });
  });

  describe('sanitize', () => {
    it('should keep valid values', () => {
      const readings: SensorReadings = {
        temperature: 25,
        ph: 7.0,
      };
      const { sanitized, removed } = service.sanitize(readings);
      expect(sanitized.temperature).toBe(25);
      expect(sanitized.ph).toBe(7.0);
      expect(removed).toHaveLength(0);
    });

    it('should remove invalid values', () => {
      const readings = {
        temperature: 25,
        ph: NaN,
      } as unknown as SensorReadings;
      const { sanitized, removed } = service.sanitize(readings);
      expect(sanitized.temperature).toBe(25);
      expect(sanitized.ph).toBeUndefined();
      expect(removed).toContain('ph');
    });

    it('should remove non-numeric values', () => {
      const readings = {
        temperature: 'hot' as unknown as number,
      } as SensorReadings;
      const { sanitized, removed } = service.sanitize(readings);
      expect(sanitized.temperature).toBeUndefined();
      expect(removed).toContain('temperature');
    });
  });

  describe('registerConfig', () => {
    it('should allow registering custom metric configs', () => {
      service.registerConfig({
        name: 'customMetric',
        min: 0,
        max: 100,
        penalty: 30,
      });

      const configs = service.getConfigs();
      expect(configs.some((c) => c.name === 'customMetric')).toBe(true);
    });
  });
});
