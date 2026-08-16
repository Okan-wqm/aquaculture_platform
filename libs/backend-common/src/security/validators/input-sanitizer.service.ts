import { Injectable, Logger } from '@nestjs/common';

import { stripNullCharacters } from './string-safety';

/**
 * Input Sanitizer Service
 *
 * Provides input sanitization utilities:
 * - HTML escaping
 * - SQL identifier sanitization
 * - JSON sanitization
 * - Path traversal prevention
 *
 * SOLID Principles:
 * - Single Responsibility: Only handles input sanitization
 */
@Injectable()
export class InputSanitizerService {
  private readonly logger = new Logger(InputSanitizerService.name);

  /**
   * Escape HTML special characters
   */
  escapeHtml(input: string): string {
    if (typeof input !== 'string') return '';

    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;')
      .replace(/\//g, '&#x2F;');
  }

  /**
   * Strip HTML tags from input
   */
  stripHtml(input: string): string {
    if (typeof input !== 'string') return '';

    // Simple tag stripping - for complex HTML use a proper library
    return input.replace(/<[^>]*>/g, '');
  }

  /**
   * Sanitize SQL identifier (table/column name)
   * Only allows alphanumeric and underscores
   */
  sanitizeSqlIdentifier(input: string): string | null {
    if (typeof input !== 'string') return null;

    // Remove all characters except alphanumeric and underscore
    const sanitized = input.replace(/[^a-zA-Z0-9_]/g, '');

    // Must start with letter or underscore
    if (!/^[a-zA-Z_]/.test(sanitized)) {
      return null;
    }

    // Max length for PostgreSQL
    if (sanitized.length > 63) {
      return sanitized.substring(0, 63);
    }

    return sanitized;
  }

  /**
   * Validate and sanitize schema name
   */
  sanitizeSchemaName(input: string): string | null {
    const sanitized = this.sanitizeSqlIdentifier(input);
    if (!sanitized) return null;

    // Additional schema-specific validation
    const reserved = ['pg_', 'information_schema', 'pg_catalog'];
    for (const prefix of reserved) {
      if (sanitized.toLowerCase().startsWith(prefix)) {
        this.logger.warn(`Attempted use of reserved schema prefix: ${sanitized}`);
        return null;
      }
    }

    return sanitized;
  }

  /**
   * Prevent path traversal attacks
   */
  sanitizePath(input: string): string {
    if (typeof input !== 'string') return '';

    // Remove path traversal sequences
    let sanitized = input
      .replace(/\.\./g, '')
      .replace(/\.\//g, '')
      .replace(/\/\//g, '/')
      .replace(/\\/g, '/');

    // Remove null bytes
    sanitized = stripNullCharacters(sanitized);

    // Remove leading slashes
    sanitized = sanitized.replace(/^\/+/, '');

    return sanitized;
  }

  /**
   * Sanitize filename for storage
   */
  sanitizeFilename(input: string): string {
    if (typeof input !== 'string') return '';

    // Allow only safe characters
    let sanitized = input.replace(/[^a-zA-Z0-9._-]/g, '_');

    // Remove consecutive dots (prevents .htaccess etc.)
    sanitized = sanitized.replace(/\.{2,}/g, '.');

    // Remove leading dots
    sanitized = sanitized.replace(/^\.+/, '');

    // Limit length
    if (sanitized.length > 255) {
      const ext = sanitized.split('.').pop() || '';
      const name = sanitized.substring(0, 255 - ext.length - 1);
      sanitized = `${name}.${ext}`;
    }

    return sanitized || 'unnamed';
  }

  /**
   * Sanitize for JSON stringification
   * Prevents JSON injection
   */
  sanitizeForJson(input: string): string {
    if (typeof input !== 'string') return '';

    return input
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  /**
   * Sanitize URL parameter
   */
  sanitizeUrlParam(input: string): string {
    if (typeof input !== 'string') return '';

    return encodeURIComponent(input);
  }

  /**
   * Normalize whitespace
   */
  normalizeWhitespace(input: string): string {
    if (typeof input !== 'string') return '';

    return input
      .replace(/[\t\n\r\f\v]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim();
  }

  /**
   * Remove null bytes (used in null byte injection attacks)
   */
  removeNullBytes(input: string): string {
    if (typeof input !== 'string') return '';

    return stripNullCharacters(input);
  }

  /**
   * Truncate string safely (respecting UTF-8)
   */
  truncate(input: string, maxLength: number): string {
    if (typeof input !== 'string') return '';

    if (input.length <= maxLength) return input;

    // Use Array.from to properly handle Unicode characters
    const chars = Array.from(input);
    return chars.slice(0, maxLength).join('');
  }

  /**
   * Validate and sanitize tenant ID
   */
  sanitizeTenantId(input: string): string | null {
    if (typeof input !== 'string') return null;

    // UUID format check
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const trimmed = input.trim().toLowerCase();
    if (!uuidRegex.test(trimmed)) {
      return null;
    }

    return trimmed;
  }

  /**
   * Deep sanitize object
   * Recursively sanitizes all string values in an object
   */
  deepSanitize<T extends Record<string, unknown>>(
    obj: T,
    options: {
      escapeHtml?: boolean;
      removeNullBytes?: boolean;
      normalizeWhitespace?: boolean;
      maxStringLength?: number;
    } = {},
  ): T {
    const {
      escapeHtml = false,
      removeNullBytes = true,
      normalizeWhitespace = false,
      maxStringLength,
    } = options;

    const sanitizeValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let result = value;

        if (removeNullBytes) {
          result = this.removeNullBytes(result);
        }

        if (escapeHtml) {
          result = this.escapeHtml(result);
        }

        if (normalizeWhitespace) {
          result = this.normalizeWhitespace(result);
        }

        if (maxStringLength && result.length > maxStringLength) {
          result = this.truncate(result, maxStringLength);
        }

        return result;
      }

      if (Array.isArray(value)) {
        return value.map(sanitizeValue);
      }

      if (value !== null && typeof value === 'object') {
        return this.deepSanitize(value as Record<string, unknown>, options);
      }

      return value;
    };

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeValue(value);
    }

    return result as T;
  }
}
