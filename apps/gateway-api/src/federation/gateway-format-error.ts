/**
 * Production error shape of the gateway's GraphQL endpoint (C-4): internal
 * details are stripped, the message the subgraph already chose passes through,
 * and the code survives.
 *
 * A rate limit is the one operational answer that also carries data the client
 * must act on: `retryAfter`, in seconds. It is forwarded for TOO_MANY_REQUESTS
 * only, and only as a number — a client that cannot tell "wait 40 s" from "the
 * server broke" retries at once or, worse, reads a throttled token refresh as a
 * dead session.
 */
export function formatGatewayError(formattedError: {
  message: string;
  extensions?: Record<string, unknown>;
}): { message: string; extensions: { code: unknown; retryAfter?: number } } {
  const code = formattedError.extensions?.['code'] ?? 'INTERNAL_SERVER_ERROR';
  const retryAfter = formattedError.extensions?.['retryAfter'];
  return {
    message: formattedError.message,
    extensions: {
      code,
      ...(code === 'TOO_MANY_REQUESTS' && typeof retryAfter === 'number' ? { retryAfter } : {}),
    },
  };
}
