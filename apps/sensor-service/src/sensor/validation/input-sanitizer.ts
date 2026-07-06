/**
 * Input Sanitizer
 * Security utility for sanitizing user inputs
 * Prevents SQL injection, pattern injection, and other attacks
 */

import { BadRequestException } from '@nestjs/common';

/**
 * Aggregation interval whitelist
 * Only these values are allowed for TimescaleDB time_bucket
 */
export const ALLOWED_AGGREGATION_INTERVALS = [
  '1 minute',
  '5 minutes',
  '15 minutes',
  '1 hour',
  '4 hours',
  '1 day',
  '1 week',
] as const;

export type SafeAggregationInterval = (typeof ALLOWED_AGGREGATION_INTERVALS)[number];

/**
 * Maximum allowed depth for JSON path parsing
 * Prevents DoS attacks with deeply nested paths
 */
export const MAX_DATA_PATH_DEPTH = 10;

/**
 * Maximum string lengths for various inputs
 */
export const MAX_LENGTHS = {
  sensorName: 200,
  serialNumber: 100,
  description: 2000,
  search: 100,
  dataPath: 500,
  schemaName: 100,
} as const;

/**
 * Validate and sanitize aggregation interval
 * @throws BadRequestException if interval is not in whitelist
 */
export function validateAggregationInterval(
  interval: string | undefined,
): SafeAggregationInterval | undefined {
  if (!interval) return undefined;

  const normalized = interval.toLowerCase().trim();

  if (!ALLOWED_AGGREGATION_INTERVALS.includes(normalized as SafeAggregationInterval)) {
    throw new BadRequestException(
      `Invalid aggregation interval: ${interval}. ` +
        `Allowed values: ${ALLOWED_AGGREGATION_INTERVALS.join(', ')}`,
    );
  }

  return normalized as SafeAggregationInterval;
}

/**
 * Validate UUID format
 * @throws BadRequestException if not a valid UUID
 */
export function validateUUID(value: string, fieldName: string): string {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  if (!uuidRegex.test(value)) {
    throw new BadRequestException(`Invalid UUID format for ${fieldName}: ${value}`);
  }

  return value.toLowerCase();
}

/**
 * Validate tenant ID (UUID format)
 */
export function validateTenantId(tenantId: string): string {
  return validateUUID(tenantId, 'tenantId');
}

/**
 * Validate sensor ID (UUID format)
 */
export function validateSensorId(sensorId: string): string {
  return validateUUID(sensorId, 'sensorId');
}

/**
 * Sanitize search string for LIKE queries
 * Escapes SQL wildcards and special characters
 */
export function sanitizeSearchString(search: string): string {
  if (!search) return '';

  // Truncate to max length
  let sanitized = search.slice(0, MAX_LENGTHS.search);

  // Escape SQL LIKE special characters
  sanitized = sanitized.replace(/[%_\\]/g, (char) => `\\${char}`);

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

/**
 * Validate and sanitize data path for JSON extraction
 * @throws BadRequestException if path is invalid or too deep
 */
export function validateDataPath(dataPath: string): string {
  if (!dataPath) {
    throw new BadRequestException('Data path is required');
  }

  if (dataPath.length > MAX_LENGTHS.dataPath) {
    throw new BadRequestException(
      `Data path exceeds maximum length of ${MAX_LENGTHS.dataPath}`,
    );
  }

  const parts = dataPath.split('.');

  if (parts.length > MAX_DATA_PATH_DEPTH) {
    throw new BadRequestException(
      `Data path depth exceeds maximum of ${MAX_DATA_PATH_DEPTH}`,
    );
  }

  // Validate each part contains only allowed characters
  const validPartRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  for (const part of parts) {
    if (!validPartRegex.test(part)) {
      throw new BadRequestException(
        `Invalid data path segment: ${part}. ` +
          'Segments must start with a letter or underscore and contain only alphanumeric characters and underscores.',
      );
    }
  }

  return dataPath;
}

/**
 * Validate PostgreSQL schema name
 * Prevents SQL injection in dynamic schema queries
 */
export function validateSchemaName(schemaName: string): string {
  if (!schemaName) {
    throw new BadRequestException('Schema name is required');
  }

  if (schemaName.length > MAX_LENGTHS.schemaName) {
    throw new BadRequestException(
      `Schema name exceeds maximum length of ${MAX_LENGTHS.schemaName}`,
    );
  }

  // PostgreSQL schema name rules: letters, digits, underscores
  // Must start with letter or underscore
  const validSchemaRegex = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  if (!validSchemaRegex.test(schemaName)) {
    throw new BadRequestException(
      `Invalid schema name: ${schemaName}. ` +
        'Schema names must start with a letter or underscore and contain only alphanumeric characters and underscores.',
    );
  }

  return schemaName;
}

/**
 * Validate date range
 * @throws BadRequestException if range is invalid
 */
export function validateDateRange(
  startTime: Date,
  endTime: Date,
  maxRangeMs?: number,
): { startTime: Date; endTime: Date } {
  if (!(startTime instanceof Date) || isNaN(startTime.getTime())) {
    throw new BadRequestException('Invalid start time');
  }

  if (!(endTime instanceof Date) || isNaN(endTime.getTime())) {
    throw new BadRequestException('Invalid end time');
  }

  if (startTime >= endTime) {
    throw new BadRequestException('Start time must be before end time');
  }

  // Check maximum range if specified
  if (maxRangeMs) {
    const rangeMs = endTime.getTime() - startTime.getTime();
    if (rangeMs > maxRangeMs) {
      const maxRangeDays = Math.round(maxRangeMs / (1000 * 60 * 60 * 24));
      throw new BadRequestException(
        `Date range exceeds maximum of ${maxRangeDays} days`,
      );
    }
  }

  return { startTime, endTime };
}

/**
 * Validate pagination parameters
 */
export function validatePagination(
  page?: number,
  limit?: number,
): { page: number; limit: number; skip: number } {
  // Use nullish coalescing so an explicit limit/page of 0 clamps UP to the
  // minimum (1) rather than being conflated with "unspecified" and silently
  // replaced by the default — enforcing the minimum is the intended contract.
  const validPage = Math.max(1, Math.floor(page ?? 1));
  const validLimit = Math.min(100, Math.max(1, Math.floor(limit ?? 20)));
  const skip = (validPage - 1) * validLimit;

  return { page: validPage, limit: validLimit, skip };
}

/**
 * Validate limit parameter
 */
export function validateLimit(limit?: number, maxLimit = 10000): number {
  if (limit === undefined || limit === null) {
    return 1000; // Default
  }

  return Math.min(maxLimit, Math.max(1, Math.floor(limit)));
}

/**
 * Sanitize string for logging (remove sensitive data patterns)
 */
export function sanitizeForLogging(value: string): string {
  // Remove potential passwords, tokens, etc.
  return value
    .replace(/password[=:]\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token[=:]\s*\S+/gi, 'token=[REDACTED]')
    .replace(/secret[=:]\s*\S+/gi, 'secret=[REDACTED]')
    .replace(/key[=:]\s*\S+/gi, 'key=[REDACTED]');
}

/**
 * Validate numeric value is within bounds
 */
export function validateNumericRange(
  value: number,
  min: number,
  max: number,
  fieldName: string,
): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new BadRequestException(`Invalid numeric value for ${fieldName}`);
  }

  if (value < min || value > max) {
    throw new BadRequestException(
      `${fieldName} must be between ${min} and ${max}, got ${value}`,
    );
  }

  return value;
}

/**
 * Create a safe schema-qualified table name
 * Uses parameterized format to prevent injection
 */
export function createSafeTableRef(schemaName: string, tableName: string): string {
  // Validate both parts
  const safeSchema = validateSchemaName(schemaName);
  const safeTable = validateSchemaName(tableName); // Same rules apply

  // Use quote_ident equivalent - double quotes escape in PostgreSQL
  const quotedSchema = `"${safeSchema.replace(/"/g, '""')}"`;
  const quotedTable = `"${safeTable.replace(/"/g, '""')}"`;

  return `${quotedSchema}.${quotedTable}`;
}
