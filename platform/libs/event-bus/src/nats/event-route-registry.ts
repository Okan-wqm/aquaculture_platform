/**
 * Event route registry (plan Task 2, SENSOR-HIGH-092).
 *
 * The single authority for which JetStream stream owns which subject root:
 *
 *   telemetry.{tenantId}.{eventType} → AQUACULTURE_TELEMETRY (high-rate
 *                                     sensor telemetry; Discard New, sized
 *                                     to the 60-minute outage buffer)
 *   events.{tenantId}.{eventType}    → AQUACULTURE_EVENTS (domain events)
 *
 * WHY: the shared AQUACULTURE_EVENTS stream capped telemetry and domain
 * events together (1.5 GiB / 1 M msgs, Discard Old) — at the locked 2K
 * msg/s envelope the re-published SensorReading alone rotates that stream
 * in ~67 seconds, evicting billing/erasure/commands backlog. Routing by
 * subject root separates the blast radii.
 *
 * `SensorMetricIngested` and `SensorReading` are the two high-rate types
 * the plan names. Adding a type here is a ONE-LINE change every producer,
 * consumer and ACL generator consumes through this module.
 */
import { assertSafeEventType, assertSafeSubjectSegment } from '../subjects/tenant-event-subject';

export type SubjectRoot = 'events' | 'telemetry';

export const TELEMETRY_SUBJECT_ROOT = 'telemetry' as const;
export const DEFAULT_TELEMETRY_STREAM_NAME = 'AQUACULTURE_TELEMETRY' as const;

/** High-rate event types routed to the telemetry stream. */
export const TELEMETRY_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'SensorMetricIngested',
  'SensorReading',
]);

export function subjectRootForEventType(eventType: string): SubjectRoot {
  return TELEMETRY_EVENT_TYPES.has(eventType) ? 'telemetry' : 'events';
}

/** The stream that owns a subject, derived from its first segment. */
export function streamNameForSubjectRoot(
  root: SubjectRoot,
  mainStream: string,
  telemetryStream: string,
): string {
  return root === 'telemetry' ? telemetryStream : mainStream;
}

export function streamNameForSubject(
  subject: string,
  streams: { main: string; telemetry: string },
): string {
  const root = subject.split('.', 1)[0];
  if (root === TELEMETRY_SUBJECT_ROOT) {
    return streams.telemetry;
  }
  return streams.main;
}

/**
 * Canonical routed subject for one event. Segment safety is delegated to
 * the SAME SSoT assertions the events-root builder uses, so a telemetry
 * subject can never smuggle forbidden characters.
 */
export function buildRoutedSubject(tenantId: string, eventType: string): string {
  const safeTenant = assertSafeSubjectSegment(tenantId, 'tenantId');
  const safeType = assertSafeEventType(eventType);
  const root = subjectRootForEventType(eventType);
  return `${root}.${safeTenant}.${safeType}`;
}

/** Routed wildcard subject for subscriptions: `telemetry.*.SensorReading`. */
export function buildRoutedWildcardSubject(eventType: string): string {
  const safeType = assertSafeEventType(eventType);
  const root = subjectRootForEventType(eventType);
  return `${root}.*.${safeType}`;
}

/** Routed per-tenant subject: `telemetry.{tenantId}.>`. */
export function buildRoutedTenantWildcardSubject(tenantId: string): string {
  const safeTenant = assertSafeSubjectSegment(tenantId, 'tenantId');
  return `${TELEMETRY_SUBJECT_ROOT}.${safeTenant}.>`;
}
