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
 * Relative URLs are accepted only when every decoded representation remains
 * same-origin against the trusted navigation base.
 */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://app.suderra.com',
  'https://aquamobil.suderra.com',
]);

const MAX_NAVIGATION_URL_LENGTH = 4096;
const MAX_DECODE_PASSES = 4;
const ENCODED_OCTET_PATTERN = /%[0-9a-f]{2}/i;
const TRUSTED_NAVIGATION_BASE = new URL('https://navigation.suderra.invalid/');

/**
 * In development, also allow localhost origins.
 */
function getAllowedOrigins(): ReadonlySet<string> {
  if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
    return new Set([...ALLOWED_ORIGINS, 'http://localhost:3000', 'http://localhost:8080']);
  }
  return ALLOWED_ORIGINS;
}

// ============================================================================
// Validation
// ============================================================================

function hasUnsafeCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x5c || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Decode only for comparison with browser-normalized URL semantics. The
 * original value is returned to the router after validation so encoded query
 * and fragment content is preserved exactly.
 */
function decodeRepresentationsForValidation(value: string): string[] | null {
  let decoded = value;
  const representations = [decoded];

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    if (!ENCODED_OCTET_PATTERN.test(decoded)) return representations;

    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }

    if (hasUnsafeCharacters(decoded)) return null;
    representations.push(decoded);
  }

  // Fail closed instead of decoding attacker-controlled input without bound.
  return ENCODED_OCTET_PATTERN.test(decoded) ? null : representations;
}

function isSameOriginRelativeRepresentation(candidate: string): boolean {
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return false;

  try {
    return new URL(candidate, TRUSTED_NAVIGATION_BASE).origin === TRUSTED_NAVIGATION_BASE.origin;
  } catch {
    return false;
  }
}

/**
 * Validate a URL against the allowlist.
 *
 * Rules:
 * 1. Relative paths must remain same-origin in raw and decoded forms.
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

  if (url.length > MAX_NAVIGATION_URL_LENGTH || hasUnsafeCharacters(url)) {
    return null;
  }

  const trimmed = url.trim();
  if (!trimmed) return null;

  const representations = decodeRepresentationsForValidation(trimmed);
  if (!representations) return null;
  const decoded = representations[representations.length - 1];

  // SECURITY: Block dangerous URI schemes
  const lower = decoded.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:')
  ) {
    return null;
  }

  // SECURITY: Block protocol-relative URLs (can redirect to any origin)
  if (trimmed.startsWith('//')) {
    return null;
  }

  // Safe: relative path
  if (trimmed.startsWith('/')) {
    if (!representations.every(isSameOriginRelativeRepresentation)) return null;

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
