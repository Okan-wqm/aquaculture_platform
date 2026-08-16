/** Closed event-code catalog for the admin HTTP transport boundary. */
export const ADMIN_HTTP_LOG_EVENTS = Object.freeze({
  requestFailure: 'admin_http.request_failure.v1',
} as const);

export type AdminHttpLogEventCode =
  (typeof ADMIN_HTTP_LOG_EVENTS)[keyof typeof ADMIN_HTTP_LOG_EVENTS];
