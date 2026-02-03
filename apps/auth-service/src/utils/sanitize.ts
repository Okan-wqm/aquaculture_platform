/**
 * Security Utilities for Input Sanitization
 *
 * SECURITY: These utilities help prevent XSS and injection attacks
 */

/**
 * HTML entity map for escaping
 */
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Escape HTML special characters to prevent XSS
 *
 * @param input - The string to sanitize
 * @returns The sanitized string with HTML entities escaped
 */
export function escapeHtml(input: string): string {
  if (!input || typeof input !== 'string') {
    return input;
  }
  return input.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] || char);
}

/**
 * Strip all HTML tags from a string
 *
 * @param input - The string to strip HTML from
 * @returns The string with all HTML tags removed
 */
export function stripHtml(input: string): string {
  if (!input || typeof input !== 'string') {
    return input;
  }
  // Remove script tags and their content first
  let result = input.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Remove style tags and their content
  result = result.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Remove all other HTML tags
  result = result.replace(/<[^>]*>/g, '');
  // Decode common HTML entities
  result = result.replace(/&nbsp;/g, ' ');
  result = result.replace(/&amp;/g, '&');
  result = result.replace(/&lt;/g, '<');
  result = result.replace(/&gt;/g, '>');
  result = result.replace(/&quot;/g, '"');
  return result.trim();
}

/**
 * Sanitize a string for safe database storage and display
 * Removes dangerous patterns while preserving readable text
 *
 * @param input - The string to sanitize
 * @param options - Sanitization options
 * @returns The sanitized string
 */
export function sanitizeString(
  input: string,
  options: {
    maxLength?: number;
    stripHtml?: boolean;
    escapeHtml?: boolean;
    trimWhitespace?: boolean;
  } = {},
): string {
  if (!input || typeof input !== 'string') {
    return input;
  }

  const {
    maxLength,
    stripHtml: shouldStripHtml = false,
    escapeHtml: shouldEscapeHtml = true,
    trimWhitespace = true,
  } = options;

  let result = input;

  // Trim whitespace
  if (trimWhitespace) {
    result = result.trim();
  }

  // Strip or escape HTML
  if (shouldStripHtml) {
    result = stripHtml(result);
  } else if (shouldEscapeHtml) {
    result = escapeHtml(result);
  }

  // Truncate if needed
  if (maxLength && result.length > maxLength) {
    result = result.substring(0, maxLength);
  }

  return result;
}

/**
 * Validate and sanitize a SQL identifier (table name, column name, schema name)
 * SECURITY: Prevents SQL injection via identifier manipulation
 *
 * @param identifier - The identifier to validate
 * @returns The validated identifier or throws error
 */
export function validateSqlIdentifier(identifier: string): string {
  if (!identifier || typeof identifier !== 'string') {
    throw new Error('Invalid identifier: must be a non-empty string');
  }

  // Trim and check length
  const trimmed = identifier.trim();
  if (trimmed.length === 0 || trimmed.length > 63) {
    throw new Error('Invalid identifier: must be 1-63 characters');
  }

  // Must start with letter or underscore, contain only alphanumeric and underscores
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  if (!validPattern.test(trimmed)) {
    throw new Error(
      'Invalid identifier: must start with letter/underscore and contain only alphanumeric/underscore',
    );
  }

  // Prevent reserved words (basic list)
  const reservedWords = [
    'select', 'insert', 'update', 'delete', 'drop', 'create', 'alter',
    'table', 'database', 'schema', 'index', 'grant', 'revoke', 'truncate',
  ];
  if (reservedWords.includes(trimmed.toLowerCase())) {
    throw new Error('Invalid identifier: cannot use SQL reserved word');
  }

  return trimmed;
}
