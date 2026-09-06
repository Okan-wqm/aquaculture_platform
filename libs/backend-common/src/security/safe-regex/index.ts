/**
 * Safe regex compilation for user-supplied patterns (ReDoS prevention).
 *
 * SSoT for every `new RegExp(<untrusted>)` site in the platform. Promoted
 * from apps/alert-engine/src/rules-engine (dead module) so admin-api's alert
 * rules, audit IP filters and feature-flag conditions share one gate instead
 * of compiling raw client patterns.
 */

const MAX_PATTERN_LENGTH = 200;

/**
 * Heuristics for constructs known to cause catastrophic backtracking.
 * Not a proof — a tripwire that rejects the classic (a+)+ shapes.
 */
const DANGEROUS_PATTERNS = [
  /\(.*\+\).*\+/, // nested quantifiers like (a+)+
  /\(.*\*\).*\*/, // nested quantifiers like (a*)*
  /\(.*\+\).*\*/, // mixed nested quantifiers
  /\(.*\*\).*\+/, // mixed nested quantifiers
  /\(\.\*.*\)\{/, // .* inside a counted repetition
];

const VALID_FLAGS = /^[gimsuy]*$/;

const regexCache = new Map<string, RegExp>();
const MAX_CACHE_SIZE = 1000;

/** Validate that a pattern is safe to compile. Returns null if safe. */
export function validateRegexPattern(pattern: string, flags?: string): string | null {
  if (!pattern || typeof pattern !== 'string') {
    return 'Pattern must be a non-empty string';
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH} characters`;
  }
  if (flags !== undefined && !VALID_FLAGS.test(flags)) {
    return 'Flags must be a subset of gimsuy';
  }
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return 'Pattern contains potentially catastrophic backtracking constructs';
    }
  }
  try {
    new RegExp(pattern, flags);
  } catch {
    return 'Pattern is not a valid regular expression';
  }
  return null;
}

/**
 * Compile a user-supplied pattern into a cached RegExp after safety
 * validation. Returns null when the pattern is invalid or unsafe —
 * callers MUST treat null as "no match" (fail closed).
 */
export function safeRegex(pattern: string, flags?: string): RegExp | null {
  const error = validateRegexPattern(pattern, flags);
  if (error) {
    return null;
  }
  const cacheKey = flags ? `${flags}:${pattern}` : pattern;
  const cached = regexCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (regexCache.size >= MAX_CACHE_SIZE) {
    const firstKey = regexCache.keys().next().value;
    if (firstKey !== undefined) {
      regexCache.delete(firstKey);
    }
  }
  const regex = new RegExp(pattern, flags);
  regexCache.set(cacheKey, regex);
  return regex;
}
