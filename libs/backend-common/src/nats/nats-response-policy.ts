import responsePolicy from './nats-response-policy.json';

// A static JSON import embeds the same policy used by the broker generator in
// the service bundle. Runtime containers do not need a checkout or YAML reader.
export const NATS_MAX_REQUEST_TIMEOUT_MS = responsePolicy.expirySeconds * 1000 - 1;

/** Reject a request configuration that can outlive the broker's reply grant. */
export function parseNatsRequestTimeout(
  configured: unknown,
  defaultMs: number,
  setting: string,
): number {
  const value = configured === undefined || configured === '' ? defaultMs : configured;
  const timeoutMs =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > NATS_MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new Error(
      `[nats-response-policy] ${setting} must be an integer from 1 to ${NATS_MAX_REQUEST_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeoutMs;
}
