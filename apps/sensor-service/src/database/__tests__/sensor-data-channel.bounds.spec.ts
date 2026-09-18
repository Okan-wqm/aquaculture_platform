/**
 * SensorDataChannel bounds validation tests
 *
 * Regression cover for the NULL-bounds bug: TypeORM hydrates nullable numeric
 * columns as `null` (not `undefined`), and the old `!== undefined` guards made
 * `value > null` (null coerced to 0) fail — marking every positive reading
 * "Above physical maximum" (quality BAD) for channels with unset bounds.
 *
 * Matrix covers: both bounds null, one-sided nulls, exact boundaries, and the
 * validateValue reason strings consumed by alerting.
 */

import { SensorDataChannel } from '../entities/sensor-data-channel.entity';

describe('SensorDataChannel bounds (null-safety)', () => {
  describe('isWithinPhysicalBounds', () => {
    it('accepts any value when both bounds are null (DB-unset columns)', () => {
      const channel = new SensorDataChannel();
      Object.assign(channel, { physicalMin: null, physicalMax: null });

      expect(channel.isWithinPhysicalBounds(25.4)).toBe(true);
      expect(channel.isWithinPhysicalBounds(-3.2)).toBe(true);
      expect(channel.isWithinPhysicalBounds(1000)).toBe(true);
    });

    it('accepts any value when both bounds are undefined', () => {
      const channel = new SensorDataChannel();

      expect(channel.isWithinPhysicalBounds(25.4)).toBe(true);
    });

    it('honours one-sided null bounds', () => {
      const lowerOnly = new SensorDataChannel();
      lowerOnly.physicalMin = -40;
      Object.assign(lowerOnly, { physicalMax: null });
      expect(lowerOnly.isWithinPhysicalBounds(1000)).toBe(true);
      expect(lowerOnly.isWithinPhysicalBounds(-41)).toBe(false);

      const upperOnly = new SensorDataChannel();
      Object.assign(upperOnly, { physicalMin: null });
      upperOnly.physicalMax = 60;
      expect(upperOnly.isWithinPhysicalBounds(-100)).toBe(true);
      expect(upperOnly.isWithinPhysicalBounds(60.1)).toBe(false);
    });

    it('honours both bounds including exact boundary values', () => {
      const channel = new SensorDataChannel();
      channel.physicalMin = -40;
      channel.physicalMax = 100;

      for (const value of [-40, -39.9, 0, 23.5, 99.9, 100]) {
        expect(channel.isWithinPhysicalBounds(value)).toBe(true);
      }
      expect(channel.isWithinPhysicalBounds(-40.1)).toBe(false);
      expect(channel.isWithinPhysicalBounds(100.1)).toBe(false);
    });
  });

  describe('isWithinOperationalBounds', () => {
    it('accepts any value when bounds are null', () => {
      const channel = new SensorDataChannel();
      Object.assign(channel, { operationalMin: null, operationalMax: null });

      expect(channel.isWithinOperationalBounds(7.4)).toBe(true);
    });

    it('honours numeric-string hydration (pg numeric driver values)', () => {
      const channel = new SensorDataChannel();
      Object.assign(channel, { operationalMin: '4', operationalMax: '9' });

      expect(channel.isWithinOperationalBounds(6.5)).toBe(true);
      expect(channel.isWithinOperationalBounds(3.9)).toBe(false);
      expect(channel.isWithinOperationalBounds(9.1)).toBe(false);
    });
  });

  describe('validateValue', () => {
    it('returns valid with no reason when bounds are unset', () => {
      const channel = new SensorDataChannel();
      Object.assign(channel, { physicalMin: null, physicalMax: null });

      const result = channel.validateValue(23.2);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.level).toBeUndefined();
    });

    it('returns invalid "Above physical maximum" when a bound exists and is exceeded', () => {
      const channel = new SensorDataChannel();
      channel.physicalMin = -10;
      channel.physicalMax = 60;

      const result = channel.validateValue(200);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Above physical maximum');
      expect(result.level).toBe('physical');
    });

    it('returns invalid "Below physical minimum" when below an existing bound', () => {
      const channel = new SensorDataChannel();
      channel.physicalMin = -10;

      const result = channel.validateValue(-50);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('Below physical minimum');
      expect(result.level).toBe('physical');
    });

    it('returns valid-but-operational when outside operational range only', () => {
      const channel = new SensorDataChannel();
      channel.operationalMin = 15;
      channel.operationalMax = 30;

      const result = channel.validateValue(35);
      expect(result.valid).toBe(true);
      expect(result.level).toBe('operational');
      expect(result.reason).toBe('Above operational maximum');
    });
  });
});
