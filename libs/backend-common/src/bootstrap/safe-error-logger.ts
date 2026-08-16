/**
 * Safe Error Logger for Bootstrap Failures
 *
 * Sanitizes error messages and stack traces before logging to prevent
 * accidental exposure of connection strings, credentials, or internal
 * architecture details in log aggregation systems (ELK, CloudWatch, etc.).
 *
 * @module bootstrap/safe-error-logger
 */

/** Patterns that indicate sensitive content in error messages/stack traces. */
const SENSITIVE_PATTERNS: RegExp[] = [
  /postgres(ql)?:\/\/[^\s]+/gi, // PostgreSQL connection strings
  /redis:\/\/[^\s]+/gi, // Redis connection strings
  /mongodb(\+srv)?:\/\/[^\s]+/gi, // MongoDB connection strings
  /nats:\/\/[^\s]+/gi, // NATS connection strings
  /mqtt:\/\/[^\s]+/gi, // MQTT connection strings
  /amqp(s)?:\/\/[^\s]+/gi, // RabbitMQ connection strings
  /password[=:]\s*['"]?[^\s'"]+/gi, // Password parameters
  /secret[=:]\s*['"]?[^\s'"]+/gi, // Secret parameters
  /token[=:]\s*['"]?[^\s'"]+/gi, // Token parameters
  /key[=:]\s*['"]?[^\s'"]+/gi, // API key parameters
];

/**
 * Sanitize a string by replacing sensitive patterns with [REDACTED].
 *
 * Scans for database connection URIs, passwords, secrets, tokens, and API
 * keys embedded in error messages or stack traces. Each match is replaced
 * with the literal string `[REDACTED]`.
 *
 * @param text - Raw text to sanitize
 * @returns Sanitized text with sensitive values replaced
 */
export function sanitizeForLogging(text: string): string {
  let sanitized = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Truncate a stack trace to the first N frames to limit information exposure.
 *
 * Full stack traces can reveal internal file paths, module structure, and
 * third-party dependency details. Limiting to the first few frames keeps
 * the most relevant diagnostic information while reducing the attack surface.
 *
 * @param stack  - Full stack trace string
 * @param maxFrames - Maximum number of stack frames to retain (default: 5)
 * @returns Truncated stack trace, or the original if already short enough
 */
export function truncateStack(stack: string, maxFrames = 5): string {
  const lines = stack.split('\n');
  // +1 accounts for the error message line at the top of the stack
  if (lines.length <= maxFrames + 1) return stack;
  return lines.slice(0, maxFrames + 1).join('\n') + '\n    ... (truncated)';
}

/**
 * Log a fatal bootstrap error with sanitized output.
 *
 * Combines sanitization and truncation to produce a structured JSON log
 * entry suitable for container log aggregation. The output is safe to
 * store in systems with broader access than production databases.
 *
 * @param serviceName - Name of the service that failed (e.g. 'sensor-service')
 * @param err         - The caught error (Error instance or unknown)
 * @param context     - Descriptive context label (e.g. 'Bootstrap', 'Module initialization')
 */
export function logBootstrapError(serviceName: string, err: unknown, context = 'Bootstrap'): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const sanitizedMessage = sanitizeForLogging(message);
  const sanitizedStack = stack ? truncateStack(sanitizeForLogging(stack)) : undefined;

  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    service: serviceName,
    message: `${context} failed: ${sanitizedMessage}`,
    ...(sanitizedStack ? { stack: sanitizedStack } : {}),
    context,
  });
  process.stderr.write(`${record}\n`);
}
