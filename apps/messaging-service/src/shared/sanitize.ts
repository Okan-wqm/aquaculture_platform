import sanitizeHtml from 'sanitize-html';

/** Dangerous URL schemes to strip from user-provided content */
const DANGEROUS_SCHEME_PATTERN = /(?:javascript|data|ftp|file):/gi;

/**
 * @module sanitize
 * @description Shared content sanitization utility for the messaging service.
 * Strips all HTML tags and dangerous URL schemes from user-provided content.
 * Used by message send/edit handlers and channel update handler.
 * @see ADR-012 section 8.2 (Input Sanitization)
 */

/**
 * Sanitize user-provided content: strip all HTML tags and dangerous URL schemes.
 *
 * @param raw The raw user input string
 * @returns Sanitized plain text string
 */
export function sanitizeContent(raw: string): string {
  let cleaned = sanitizeHtml(raw, {
    allowedTags: [],
    allowedAttributes: {},
  });
  cleaned = cleaned.replace(DANGEROUS_SCHEME_PATTERN, '');
  return cleaned.trim();
}

/** Allowed URL schemes for content validation */
const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

/**
 * Validate that any URLs in content only use allowed schemes.
 *
 * @param content The content to validate
 * @returns true if content is safe, false otherwise
 */
export function validateUrlSchemes(content: string): boolean {
  const urlPattern = /(\w+):\/\//g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(content)) !== null) {
    const scheme = `${match[1]}:`;
    if (!ALLOWED_URL_SCHEMES.includes(scheme.toLowerCase())) {
      return false;
    }
  }
  return true;
}
