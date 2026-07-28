// Base event contract and shared types
export * from './base-event';

// Cross-service shared enums (DBR-HIGH-003 cure — single source of truth
// for values that are persisted to the DB and round-tripped via events).
export * from './enums/tenant-plan.enum';
// Per-plan resource limits SSoT (SSOT-C-13 cure) — the single catalog every
// service projects its plan limits from; replaces 5 hand-copied catalogs.
export * from './billing/plan-catalog';
// Billing/admin sellable-tier enum SSoT (Faz D — D8 cure). Distinct from the
// entitlement `TenantPlan`: no `trial`, plus a negotiated `custom` tier. The
// billing + admin entities re-export this; the FE literals are pinned to it.
export * from './billing/billing-plan-tier';
export * from './enums/tenant-status.enum';
// Tenant lifecycle transition authority (auth-audit HIGH-007). Pure,
// dependency-free logic that gates every status change + login + erasure.
export * from './enums/tenant-status.machine';
export * from './tenant-erasure-targets';
// Config-runtime RPC subjects + ConfigurationChanged signal (Billing Revival Faz C).
export * from './config-runtime';

// Domain events by module
export * from './auth-events';
export * from './tenant-events';
export * from './tenant-commands';
export * from './farm-events';
export * from './sensor-events';
export * from './alert-events';
export * from './notification-events';
export * from './notification-commands';
export * from './hr-events';
// Tenant-internal operational finance (farm OPEX/revenue + HR labour cost).
// NOT platform SaaS billing — that stays in billing-events.ts.
export * from './finance-events';
export * from './billing-events';
export * from './billing-admin-commands';
export * from './ai-events';
export * from './task-events';
export * from './edge-device-events';
export * from './water-quality-events';
export * from './messaging-events';
export * from './messaging-event-registry';
// Socket.IO wire envelopes (gateway → client) — SSoT for hydrated WS payloads.
export * from './websocket-envelopes';
export * from './platform-event-registry';
export * from './storage-events';
// W7 / D-B5: "swallow vs rethrow" is a property of the EVENT, not a per-handler
// comment. Must be exported after farm-events + storage-events (it types the
// registry over their interfaces).
export * from './event-delivery-semantics';

// Automation domain events (sensor-service compiler / programming).
// ORPHAN-EVENT-CONTRACT-015..018 cure.
export * from './automation-events';

// Security events (auth failures, rate limit, CSP violations, etc.)
export * from './security';

// Compliance events (legal-hold lifecycle: applied/released/expired).
export * from './compliance-events';

// Schema-migration events (Phase 6 NATS event-bridge). Emitted by each
// service's MigrationRunnerService via NatsMigrationEventSink; the
// observability-service consumer persists via RecordMigrationEventCommand.
export * from './schema-migration-events';

// Ingest-backend policy (ADR-031). Contracts for the admin-api ↔
// sensor-ingestion rollout-decision surface: request-reply snapshot
// + incremental `IngestBackendPolicyChanged` event.
export * from './ingest-backend-policy';

// Event upcasters (v1 → v2 schema migration at deserialization time)
export * from './upcasters';

// Runtime JSON Schema validators for trust-boundary crossing (H-3)
export * from './auth-user-queries';
export * from './auth-credential-queries';
export * from './schemas';

// Re-export all domain union types for convenience
import type { AIEvent } from './ai-events';
import type { AlertEvent } from './alert-events';
import type { AuthEvent } from './auth-events';
import type { AutomationEvent } from './automation-events';
import type { BillingEvent } from './billing-events';
import type { ComplianceEvent } from './compliance-events';
import type { EdgeDeviceEvent } from './edge-device-events';
import type { FarmEvent } from './farm-events';
import type { FinanceEvent } from './finance-events';
import type { HREvent } from './hr-events';
import type { MessagingEvent } from './messaging-events';
import type { NotificationEvent } from './notification-events';
import type { SecurityEvent } from './security';
import type { SensorEvent } from './sensor-events';
import type { StorageEvent } from './storage-events';
import type { TaskEvent } from './task-events';
import type { TenantEvent } from './tenant-events';
import type { WaterQualityEvent } from './water-quality-events';

/**
 * Union type for all platform events.
 * Useful for generic event handlers and middleware.
 */
export type AnyPlatformEvent =
  | AuthEvent
  | TenantEvent
  | FarmEvent
  | SensorEvent
  | AlertEvent
  | NotificationEvent
  | HREvent
  | FinanceEvent
  | BillingEvent
  | AIEvent
  | TaskEvent
  | EdgeDeviceEvent
  | WaterQualityEvent
  | MessagingEvent
  | StorageEvent
  | SecurityEvent
  | ComplianceEvent
  | AutomationEvent;
