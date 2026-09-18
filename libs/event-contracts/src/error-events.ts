import type { BaseEvent } from './base-event';

/**
 * Error-capture contract (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` / `admin.error_occurrences` had a reader
 * (`ErrorTrackingPage`) and no writer: the only way into
 * `ErrorTrackingService.reportError` was `POST /system/errors/report`, a route
 * behind `PlatformAdminGuard` + `@RequiresCapability('security-ops')` that
 * nothing has ever called. A service that crashes cannot authenticate as a
 * platform admin, so the route could never have been the ingress.
 *
 * This event is that ingress. Every service publishes one when a request or a
 * message handler throws something that is genuinely a defect; admin-api
 * consumes the stream and folds each into its group.
 *
 * # Relationship to Prometheus
 *
 * `http_requests_total{status_code="5.."}` already counts every 5xx, on
 * `res.on('finish')`, in every service that imports `ServiceMetricsModule`.
 * This stream is NOT a second count of the same thing and the two WILL
 * disagree by construction — the metrics middleware sees responses that were
 * produced without a thrown exception (a handler returning a 500 body, a
 * proxied upstream 502, a client-aborted response), and a capture point sees
 * thrown exceptions whose response may never finish.
 *
 * The contract is therefore: `http_requests_total` is the SSoT for the 5xx
 * RATE; `error_groups` is the SSoT for distinct DEFECT SIGNATURES and is never
 * summed as a request count. Two divergent "number of 5xx" figures is how
 * operators learn to distrust both dashboards, so the split is stated here and
 * on the dashboard rather than discovered.
 */
export interface ServiceErrorCapturedEvent extends BaseEvent {
  eventType: 'ServiceErrorCaptured';

  /** The exception's message, PII-masked and truncated by the publisher. */
  message: string;

  /** Constructor name of the thrown value, e.g. `QueryFailedError`. */
  errorType: string;

  /** Masked and truncated; absent when the thrown value carried no stack. */
  stackTrace?: string;

  /** The publishing service's `SERVICE_NAME`. */
  service: string;

  /** `NODE_ENV` / `AQUA_ENV` at the moment of capture. */
  environment?: string;

  /** Deployed build identifier, when the process was given one. */
  release?: string;

  severity: 'error' | 'critical';

  /** The status the exception maps to; 0 when it is not an HTTP exception. */
  statusCode: number;

  /** Which execution context threw — an HTTP request or a NATS handler. */
  transport: 'http' | 'rpc';

  httpMethod?: string;

  /**
   * The route with dynamic segments collapsed (`/tenants/:id/farms/:id`), using
   * the same normaliser Prometheus labels use, so a group can be joined to its
   * RED series without a second convention.
   */
  httpRoute?: string;

  /** The NATS subject or message pattern, when `transport` is `'rpc'`. */
  rpcPattern?: string;
}
