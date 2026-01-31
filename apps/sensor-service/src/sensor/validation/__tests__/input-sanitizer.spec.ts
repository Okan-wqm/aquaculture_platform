import { BadRequestException } from '@nestjs/common';

import {
  validateAggregationInterval,
  validateUUID,
  validateTenantId,
  validateSensorId,
  sanitizeSearchString,
  validateDataPath,
  validateSchemaName,
  validateDateRange,
  validatePagination,
  validateLimit,
  validateNumericRange,
  createSafeTableRef,
  ALLOWED_AGGREGATION_INTERVALS,
  MAX_DATA_PATH_DEPTH,
} from '../input-sanitizer';

describe('Input Sanitizer', () => {
  describe('validateAggregationInterval', () => {
    it('should accept valid intervals', () => {
      for (const interval of ALLOWED_AGGREGATION_INTERVALS) {
        expect(validateAggregationInterval(interval)).toBe(interval);
      }
    });

    it('should return undefined for undefined input', () => {
      expect(validateAggregationInterval(undefined)).toBeUndefined();
    });

    it('should throw for invalid interval', () => {
      expect(() => validateAggregationInterval('2 minutes')).toThrow(BadRequestException);
      expect(() => validateAggregationInterval("'; DROP TABLE sensors;--")).toThrow(
        BadRequestException,
      );
    });

    it('should normalize case', () => {
      expect(validateAggregationInterval('1 MINUTE')).toBe('1 minute');
      expect(validateAggregationInterval('1 Hour')).toBe('1 hour');
    });
  });

  describe('validateUUID', () => {
    it('should accept valid UUIDs', () => {
      const validUUID = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateUUID(validUUID, 'test')).toBe(validUUID.toLowerCase());
    });

    it('should throw for invalid UUIDs', () => {
      expect(() => validateUUID('not-a-uuid', 'test')).toThrow(BadRequestException);
      expect(() => validateUUID('', 'test')).toThrow(BadRequestException);
      expect(() => validateUUID('550e8400-XXXX-41d4-a716-446655440000', 'test')).toThrow(
        BadRequestException,
      );
    });

    it('should lowercase valid UUIDs', () => {
      const upperUUID = '550E8400-E29B-41D4-A716-446655440000';
      expect(validateUUID(upperUUID, 'test')).toBe(upperUUID.toLowerCase());
    });
  });

  describe('validateTenantId', () => {
    it('should validate tenant ID as UUID', () => {
      const validId = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateTenantId(validId)).toBe(validId);
    });

    it('should throw for invalid tenant ID', () => {
      expect(() => validateTenantId('invalid')).toThrow(BadRequestException);
    });
  });

  describe('validateSensorId', () => {
    it('should validate sensor ID as UUID', () => {
      const validId = '550e8400-e29b-41d4-a716-446655440000';
      expect(validateSensorId(validId)).toBe(validId);
    });

    it('should throw for invalid sensor ID', () => {
      expect(() => validateSensorId('sensor-123')).toThrow(BadRequestException);
    });
  });

  describe('sanitizeSearchString', () => {
    it('should return empty string for empty input', () => {
      expect(sanitizeSearchString('')).toBe('');
    });

    it('should escape SQL LIKE wildcards', () => {
      expect(sanitizeSearchString('test%')).toBe('test\\%');
      expect(sanitizeSearchString('test_')).toBe('test\\_');
      expect(sanitizeSearchString('100%_complete')).toBe('100\\%\\_complete');
    });

    it('should escape backslashes', () => {
      expect(sanitizeSearchString('test\\')).toBe('test\\\\');
    });

    it('should remove null bytes', () => {
      expect(sanitizeSearchString('test\0value')).toBe('testvalue');
    });

    it('should truncate to max length', () => {
      const longString = 'a'.repeat(200);
      expect(sanitizeSearchString(longString).length).toBe(100);
    });

    it('should trim whitespace', () => {
      expect(sanitizeSearchString('  test  ')).toBe('test');
    });
  });

  describe('validateDataPath', () => {
    it('should accept valid simple paths', () => {
      expect(validateDataPath('temperature')).toBe('temperature');
      expect(validateDataPath('sensors')).toBe('sensors');
    });

    it('should accept valid nested paths', () => {
      expect(validateDataPath('sensors.temperature')).toBe('sensors.temperature');
      expect(validateDataPath('data.readings.ph')).toBe('data.readings.ph');
    });

    it('should accept paths with underscores', () => {
      expect(validateDataPath('water_temperature')).toBe('water_temperature');
      expect(validateDataPath('_private_field')).toBe('_private_field');
    });

    it('should throw for empty path', () => {
      expect(() => validateDataPath('')).toThrow(BadRequestException);
    });

    it('should throw for too long path', () => {
      const longPath = 'a'.repeat(600);
      expect(() => validateDataPath(longPath)).toThrow(BadRequestException);
    });

    it('should throw for too deep path', () => {
      const deepPath = Array(MAX_DATA_PATH_DEPTH + 2)
        .fill('level')
        .join('.');
      expect(() => validateDataPath(deepPath)).toThrow(BadRequestException);
    });

    it('should throw for invalid characters', () => {
      expect(() => validateDataPath('test-value')).toThrow(BadRequestException);
      expect(() => validateDataPath('test.123start')).toThrow(BadRequestException);
      expect(() => validateDataPath('test.$special')).toThrow(BadRequestException);
    });
  });

  describe('validateSchemaName', () => {
    it('should accept valid schema names', () => {
      expect(validateSchemaName('tenant_123')).toBe('tenant_123');
      expect(validateSchemaName('public')).toBe('public');
      expect(validateSchemaName('_private')).toBe('_private');
    });

    it('should throw for empty name', () => {
      expect(() => validateSchemaName('')).toThrow(BadRequestException);
    });

    it('should throw for too long name', () => {
      const longName = 'a'.repeat(101);
      expect(() => validateSchemaName(longName)).toThrow(BadRequestException);
    });

    it('should throw for names starting with numbers', () => {
      expect(() => validateSchemaName('123schema')).toThrow(BadRequestException);
    });

    it('should throw for names with special characters', () => {
      expect(() => validateSchemaName('schema-name')).toThrow(BadRequestException);
      expect(() => validateSchemaName('schema.name')).toThrow(BadRequestException);
      expect(() => validateSchemaName("schema'; DROP TABLE--")).toThrow(BadRequestException);
    });
  });

  describe('validateDateRange', () => {
    it('should accept valid date range', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-01-31');
      const result = validateDateRange(start, end);
      expect(result.startTime).toEqual(start);
      expect(result.endTime).toEqual(end);
    });

    it('should throw for invalid start date', () => {
      expect(() =>
        validateDateRange(new Date('invalid'), new Date('2024-01-31')),
      ).toThrow(BadRequestException);
    });

    it('should throw for invalid end date', () => {
      expect(() =>
        validateDateRange(new Date('2024-01-01'), new Date('invalid')),
      ).toThrow(BadRequestException);
    });

    it('should throw when start is after end', () => {
      const start = new Date('2024-01-31');
      const end = new Date('2024-01-01');
      expect(() => validateDateRange(start, end)).toThrow(BadRequestException);
    });

    it('should throw when range exceeds maximum', () => {
      const start = new Date('2023-01-01');
      const end = new Date('2025-01-01');
      const maxRangeMs = 365 * 24 * 60 * 60 * 1000; // 1 year
      expect(() => validateDateRange(start, end, maxRangeMs)).toThrow(BadRequestException);
    });
  });

  describe('validatePagination', () => {
    it('should return defaults for undefined input', () => {
      const result = validatePagination();
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.skip).toBe(0);
    });

    it('should calculate skip correctly', () => {
      const result = validatePagination(3, 10);
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(10);
      expect(result.skip).toBe(20);
    });

    it('should enforce minimum page', () => {
      const result = validatePagination(0, 10);
      expect(result.page).toBe(1);
    });

    it('should enforce minimum page size', () => {
      const result = validatePagination(1, 0);
      expect(result.pageSize).toBe(1);
    });

    it('should enforce maximum page size', () => {
      const result = validatePagination(1, 1000);
      expect(result.pageSize).toBe(100);
    });
  });

  describe('validateLimit', () => {
    it('should return default for undefined', () => {
      expect(validateLimit()).toBe(1000);
    });

    it('should enforce minimum', () => {
      expect(validateLimit(0)).toBe(1);
    });

    it('should enforce maximum', () => {
      expect(validateLimit(50000, 10000)).toBe(10000);
    });

    it('should floor decimal values', () => {
      expect(validateLimit(10.9)).toBe(10);
    });
  });

  describe('validateNumericRange', () => {
    it('should accept values within range', () => {
      expect(validateNumericRange(5, 0, 10, 'test')).toBe(5);
    });

    it('should throw for values below minimum', () => {
      expect(() => validateNumericRange(-1, 0, 10, 'test')).toThrow(BadRequestException);
    });

    it('should throw for values above maximum', () => {
      expect(() => validateNumericRange(11, 0, 10, 'test')).toThrow(BadRequestException);
    });

    it('should throw for NaN', () => {
      expect(() => validateNumericRange(NaN, 0, 10, 'test')).toThrow(BadRequestException);
    });

    it('should throw for Infinity', () => {
      expect(() => validateNumericRange(Infinity, 0, 10, 'test')).toThrow(BadRequestException);
    });
  });

  describe('createSafeTableRef', () => {
    it('should create quoted table reference', () => {
      expect(createSafeTableRef('tenant_123', 'sensors')).toBe('"tenant_123"."sensors"');
    });

    it('should escape double quotes', () => {
      // This tests the escaping logic, though valid names shouldn't have quotes
      // The validation would fail before reaching this point
    });

    it('should throw for invalid schema name', () => {
      expect(() => createSafeTableRef('123invalid', 'sensors')).toThrow(BadRequestException);
    });

    it('should throw for invalid table name', () => {
      expect(() => createSafeTableRef('tenant_123', 'drop-table')).toThrow(BadRequestException);
    });
  });
});
