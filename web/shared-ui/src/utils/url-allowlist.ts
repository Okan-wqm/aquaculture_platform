/**
 * URL Allowlist Validator
 *
 * SECURITY: FE-HIGH-009 — Push notification click handlers and other
 * navigation entry points must validate destination URLs against an
 * allowlist to prevent open-redirect attacks.
 *
 * This module provides a centralized URL validation primitive that
 * makes open-redirect STRUCTURALLY IMPOSSIBLE by requiring all
 * navigation URLs to pass through a single enforcement point.
 *
 * @see FE-HIGH-009
 */

// ============================================================================
// Allowed Origins
// ============================================================================

/**
 * Allowlist of trusted origins for navigation.
 * Any absolute URL must match one of these origins.
 * Relative URLs (starting with '/') are always allowed.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://app.suderra.com',
  'https://aquamobil.suderra.com',
]);

/**
 * In development, also allow localhost origins.
 */
function getAllowedOrigins(): ReadonlySet<string> {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return new Set([
      ...ALLOWED_ORIGINS,
      'http://localhost:3000',
      'http://localhost:8080',
    ]);
  }
  return ALLOWED_ORIGINS;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a URL against the allowlist.
 *
 * Rules:
 * 1. Relative paths starting with '/' (not '//') are ALWAYS safe.
 * 2. Absolute URLs must have an origin in the allowlist.
 * 3. Protocol-relative URLs ('//evil.com') are BLOCKED.
 * 4. JavaScript/data URIs are BLOCKED.
 * 5. Null/empty returns null (no navigation).
 *
 * @param url - The URL to validate
 * @returns The validated URL if safe, or null if blocked
 *
 * @example
 * validateNavigationUrl('/dashboard')           // => '/dashboard'
 * validateNavigationUrl('https://evil.com/phish') // => null
 * validateNavigationUrl('javascript:alert(1)')    // => null
 * validateNavigationUrl('//evil.com')             // => null
 */
export function validateNavigationUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;

  const trimmed = url.trim();
  if (!trimmed) return null;

  // SECURITY: Block dangerous URI schemes
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }

  // SECURITY: Block protocol-relative URLs (can redirect to any origin)
  if (trimmed.startsWith('//')) {
    return null;
  }

  // Safe: relative path
  if (trimmed.startsWith('/')) {
    // Additional check: no backslash tricks (e.g., '/\evil.com')
    if (trimmed.includes('\\')) return null;
    return trimmed;
  }

  // Absolute URL — must parse and check origin
  try {
    const parsed = new URL(trimmed);
    const allowedOrigins = getAllowedOrigins();

    if (allowedOrigins.has(parsed.origin)) {
      return trimmed;
    }
  } catch {
    // Malformed URL
  }

  return null;
}
