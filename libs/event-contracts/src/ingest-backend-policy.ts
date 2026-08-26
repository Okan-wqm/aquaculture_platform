import { BaseEvent } from './base-event';

/**
 * Ingest backend policy wire contracts (ADR-031).
 *
 * These shapes mirror the Rust
 * `apps/sensor-ingestion/src/ingest_backend.rs` types
 * (IngestBackendSnapshot, IngestBackendChange) byte-for-byte. The
 * pair defines the authoritative cross-language surface for the
 * per-tenant IngestBackend rollout gate (ADR-025 / ADR-027):
 * admin-api-service publishes, the Rust sidecar subscribes +
 * hot-swaps its ArcSwap<IngestBackendSnapshot> on every event.
 *
 * WHY this file is separate from sensor-events.ts — the rollout
 * policy is a control-plane concern (admin-api-service owns it),
 * not a telemetry event (sensor-service owns those). Keeping them
 * separate makes the policy surface navigable from the admin-api
 * side without dragging in every sensor reading shape, and lets
 * the Rust sidecar publish telemetry changes independently from
 * rollout changes.
 *
 * Wire-shape drift discipline:
 *   - The `backend` values are the literal strings "node" / "rust"
 *     (lowercase) — the Rust side uses `#[serde(rename_all =
 *     "lowercase")]` on the enum, so ANY other casing breaks the
 *     round trip silently.
 *   - The `tenantId` values are lower-case hyphenated UUIDs —
 *     matches the Rust `TenantId`'s `Display`, which is
 *     `Uuid::Hyphenated`.
 *   - The `action` tag on every change event is snake_case
 *     ("set_global", "set_tenant", "remove_tenant") — mirrors the
 *     Rust `#[serde(tag = "action", rename_all = "snake_case")]`.
 *   - The `sensor_ingestion_policy_change_decode_failed_total`
 *     counter on the sidecar surfaces any drift at runtime, but
 *     this file is the compile-time pin.
 */

/**
 * Canonical backend-selector token. Matches the Rust
 * `IngestBackend` enum serialised via `rename_all = "lowercase"`.
 */
export type IngestBackendKind = 'node' | 'rust';

export type IngressOwner = 'NESTJS' | 'RUST';

export type IngressOwnerPolicyState = 'PREPARING' | 'ACTIVE' | 'DRAINING';

/**
 * Exclusive, versioned per-tenant MQTT owner decision. Unknown or transitional
 * state is intentionally not represented as an implicit default on consumers.
 */
export interface IngressOwnerPolicy {
  tenantId: string;
  version: number;
  owner: IngressOwner;
  effectiveEpoch: string;
  state: IngressOwnerPolicyState;
}

/**
 * Immutable snapshot of the per-tenant IngestBackend routing
 * decision at a point in time.
 *
 * Wire shape of the `policy.ingest_backend.snapshot` responder
 * reply; also the shape the sidecar persists to its disk fallback
 * file (`/var/lib/sensor-ingestion/last-known-policy.json`) so the
 * next cold boot has durable state.
 *
 * `overrides` keys are UUID strings (not branded `TenantId`) on
 * the wire because JSON objects only key on strings. The consumer
 * (Rust sidecar) re-brands via `TenantId::from_uuid(parse(...))`
 * at deserialize time.
 */
export interface IngestBackendSnapshot {
  /**
   * Default backend every tenant NOT named in `overrides` routes
   * to. Starts as `"node"` during pilot (safe rollout — no Rust
   * processing); flips to `"rust"` at Faz-3 cut-over.
   */
  defaultBackend: IngestBackendKind;

  /**
   * Per-tenant override map: UUID string → backend selector.
   * A tenant present here bypasses `defaultBackend`. During pilot
   * the present-entries set grows one tenant at a time; at cut-
   * over the map is replaced wholesale with `defaultBackend =
   * "rust"` + an empty override set.
   */
  overrides: Record<string, IngestBackendKind>;
}

/**
 * Discriminator tag on every `IngestBackendPolicyChange` variant.
 * snake_case matches the Rust `#[serde(tag = "action", rename_all
 * = "snake_case")]` attribute on `IngestBackendChange`.
 */
export type IngestBackendPolicyAction = 'set_global' | 'set_tenant' | 'remove_tenant';

/**
 * Base shape for every change variant. The `action` discriminator
 * carries the transition kind; the per-variant shape adds its
 * operands.
 *
 * Exposed as a tagged union so callers can narrow on `action`
 * without runtime type-checks against raw `record` fields.
 */
export type IngestBackendPolicyChange =
  | {
      action: 'set_global';
      /** New global default. Applies to every tenant without an override. */
      backend: IngestBackendKind;
    }
  | {
      action: 'set_tenant';
      /** Tenant UUID the override applies to (lower-case hyphenated). */
      tenantId: string;
      /** Backend the tenant routes to from this event onward. */
      backend: IngestBackendKind;
    }
  | {
      action: 'remove_tenant';
      /** Tenant UUID whose override is being removed. */
      tenantId: string;
    };

/**
 * Domain event published by admin-api-service on every rollout
 * decision change. The Rust sidecar's
 * `policy.ingest_backend.changed` subscriber decodes the `change`
 * payload + applies it to its in-memory policy via
 * `DynamicBackendPolicy::apply_change`.
 *
 * WHY the change is embedded rather than shaped as three distinct
 * events (one per action) — the Rust side consumes a single
 * `IngestBackendChange` enum whose tagged JSON shape is the
 * source of truth for state-transition semantics. Splitting into
 * three event types on this side would force a translator at the
 * boundary; keeping the inner `change` field mirrors the Rust
 * enum exactly so the wire contract is shape-preserving.
 */
export interface IngestBackendPolicyChangedEvent extends BaseEvent {
  eventType: 'IngestBackendPolicyChanged';

  /**
   * The change payload the sidecar applies to its atomic
   * snapshot. Shape matches the Rust `IngestBackendChange`
   * tagged enum byte-for-byte.
   */
  change: IngestBackendPolicyChange;

  /**
   * Operator-supplied change reason for audit trails. Free-form
   * short text ("Phase-1 tenant opt-in", "rollback after incident
   * 2026-04-22"). Never load-bearing for the routing decision.
   */
  reason?: string;

  /**
   * UUID of the operator / service account who drove the change.
   * Populated from the admin-api-service caller's JWT claims at
   * publish time. Used for audit correlation; NOT for authz —
   * authz was already enforced at the admin-api boundary.
   */
  actorId?: string;
}

/**
 * Canonical NATS subjects for the policy wire. Centralised so the
 * TS publisher, the TS responder, and the Rust subscriber all
 * point at the same literal string; a refactor that mistypes any
 * of them fails the invariant tests the admin-api-service +
 * sensor-ingestion sides pin.
 */
export const INGEST_BACKEND_POLICY_SUBJECTS = {
  /**
   * Request-reply subject for cold-start snapshot fetch. Mirror
   * of `policy::SNAPSHOT_SUBJECT` on the Rust side.
   */
  snapshot: 'policy.ingest_backend.snapshot',

  /**
   * Event publish subject — admin-api-service publishes here on
   * every rollout decision change. Sidecar subscribes via the
   * `policy.ingest_backend.>` wildcard so future fan-outs
   * (`policy.ingest_backend.health`, etc.) join without a
   * subscriber code change.
   */
  changed: 'policy.ingest_backend.changed',

  /**
   * Subscription filter the sidecar uses. `>` captures the
   * `changed` subject + any sibling subject under the namespace.
   */
  subjectFilter: 'policy.ingest_backend.>',

  /** Request-reply snapshot of every current per-tenant owner row. */
  ownerSnapshot: 'policy.ingress_owner.snapshot',

  /** Prefix for a tenant-specific, versioned owner update. */
  ownerChangedPrefix: 'policy.ingress_owner.changed',

  /** Versioned owner updates, one tenant token below the root. */
  ownerSubjectFilter: 'policy.ingress_owner.changed.*',
} as const;

/**
 * Request body for `policy.ingest_backend.snapshot`. Intentionally
 * empty — the subject disambiguates the intent. Caller authorization is
 * enforced by the broker's mTLS account/certificate ACL for this subject.
 * NATS does not project peer-certificate identity into an individual message;
 * application headers are caller-controlled and must never be trusted as
 * authentication evidence. No per-caller parameter adds information.
 *
 * Export the type so admin-api-service + Rust sidecar both pin
 * the same wire shape; the empty-object literal is canonical.
 */
export type IngestBackendSnapshotRequest = Record<string, never>;

/**
 * Responder reply shape for `policy.ingest_backend.snapshot`.
 * Matches the Rust `IngestBackendSnapshot` serde form — a shared
 * alias keeps the two sides literally identical at the type
 * level.
 */
export type IngestBackendSnapshotReply = IngestBackendSnapshot;
