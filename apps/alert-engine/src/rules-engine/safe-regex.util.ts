/**
 * Safe regex utility: validates, caches, and enforces limits on user-supplied
 * regular expression patterns to prevent ReDoS attacks.
 */

const MAX_PATTERN_LENGTH = 200;

/**
 * Patterns known to cause catastrophic backtracking.
 * This is a simple heuristic; for production-grade protection consider Google RE2.
 */
const DANGEROUS_PATTERNS = [
  /\(.*\+\).*\+/, // nested quantifiers like (a+)+
  /\(.*\*\).*\*/, // nested quantifiers like (a*)*
  /\(.*\+\).*\*/, // mixed nested quantifiers
  /\(.*\*\).*\+/, // mixed nested quantifiers
  /\(\.\*.*\)\{/, // .* inside a counted repetition
];

const regexCache = new Map<string, RegExp>();
const MAX_CACHE_SIZE = 1000;

/**
 * Validate that a pattern is safe to compile into a RegExp.
 * Returns null if safe, or an error message if unsafe.
 */
export function validateRegexPattern(pattern: string): string | null {
  if (!pattern || typeof pattern !== 'string') {
    return 'Pattern must be a non-empty string';
  }

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`;
  }

  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return 'Pattern contains potentially catastrophic backtracking constructs';
    }
  }

  // Verify it compiles
  try {
    new RegExp(pattern);
  } catch {
    return 'Pattern is not a valid regular expression';
  }

  return null;
}

/**
 * Compile a user-supplied pattern into a cached RegExp, with safety validation.
 * Returns null if the pattern is invalid or unsafe.
 */
export function safeRegex(pattern: string): RegExp | null {
  const error = validateRegexPattern(pattern);
  if (error) {
    return null;
  }

  const cached = regexCache.get(pattern);
  if (cached) {
    return cached;
  }

  // Evict oldest entries when cache is full
  if (regexCache.size >= MAX_CACHE_SIZE) {
    const firstKey = regexCache.keys().next().value;
    if (firstKey !== undefined) {
      regexCache.delete(firstKey);
    }
  }

  const regex = new RegExp(pattern);
  regexCache.set(pattern, regex);
  return regex;
}
