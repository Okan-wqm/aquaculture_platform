/**
 * True when an error declared itself retryable — the event-bus `failureClass`
 * convention (`isTerminalHandlerError` believes a declared class). Every typed
 * delivery failure that a redelivery can fix declares `'transient'`: a
 * recoverable contact lookup, a rate-limit refusal, an unavailable limiter, a
 * receipt still held by a crashed send (V-S1a-6).
 */
export function declaresTransient(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'failureClass' in error &&
    error.failureClass === 'transient'
  );
}
