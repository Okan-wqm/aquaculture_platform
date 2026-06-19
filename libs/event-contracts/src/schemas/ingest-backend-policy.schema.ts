import type { JSONSchemaType } from 'ajv';

import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  MAX_FREE_TEXT_LENGTH,
  MAX_SHORT_CODE_LENGTH,
  UUID_PATTERN,
} from './common.schema';

/**
 * @module IngestBackendPolicySchemas
 *
 * JSON Schema definitions for ADR-031 ingest-backend-policy events
 * crossing a trust boundary. Currently validates:
 *   - IngestBackendPolicyChanged (admin-api-service publishes; Rust
 *     sensor-ingestion sidecar subscribes on `policy.ingest_backend.>`).
 *
 * # Why AJV validation on top of the tagged-union TS narrowing
 *
 * The TS publisher (`IngestBackendPolicyService.applyChange`) and
 * the Rust subscriber (`serde_json::from_slice::<IngestBackendChange>`)
 * both type-narrow the `change` field at compile / deserialize time.
 * Neither catches:
 *   - A future producer (different language, different team's test
 *     harness, a malicious caller with NATS publish rights) emitting
 *     a payload with extra fields, missing required fields, or a
 *     wrong-type value.
 *   - A stale publisher running after a contract bump publishing the
 *     old shape.
 * This schema is the defense-in-depth last line, same posture as
 * `sensor-events.schema.ts` closes for the sensor domain.
 *
 * # tenantId — platform-wide sentinel
 *
 * Unlike tenant-scoped events, `IngestBackendPolicyChangedEvent` is
 * a platform-wide admin signal — it has no natural tenant scope.
 * The publisher (`admin-api-service`) sets `tenantId: 'admin'` as
 * the sentinel; the schema enforces the sentinel exactly. A payload
 * with any other tenantId value is rejected. This prevents a caller
 * from silently moving platform-wide events into a tenant namespace
 * (which would leak rollout state into per-tenant read paths).
 */

// ============================================================================
// Wire-format interface — exactly the on-wire JSON shape
// ============================================================================

/** Literal backend-selector shape. Matches the Rust enum's lowercase serde. */
type WireIngestBackendKind = 'node' | 'rust';

/** Tagged-union discriminator matching the Rust #[serde(tag="action")]. */
type WireIngestBackendPolicyAction =
  | 'set_global'
  | 'set_tenant'
  | 'remove_tenant';

/** Internal alias so the JSONSchemaType type lines up with the `change` field. */
type WireIngestBackendPolicyChange =
  | {
      action: Extract<WireIngestBackendPolicyAction, 'set_global'>;
      backend: WireIngestBackendKind;
    }
  | {
      action: Extract<WireIngestBackendPolicyAction, 'set_tenant'>;
      tenantId: string;
      backend: WireIngestBackendKind;
    }
  | {
      action: Extract<WireIngestBackendPolicyAction, 'remove_tenant'>;
      tenantId: string;
    };

interface WireIngestBackendPolicyChanged {
  eventId: string;
  eventType: 'IngestBackendPolicyChanged';
  timestamp: string;
  // Platform-wide sentinel, NOT a tenant UUID. See module-level
  // comment for the rationale.
  tenantId: 'admin';
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
  change: WireIngestBackendPolicyChange;
  reason?: string;
  actorId?: string;
}

// ============================================================================
// Schema fragments
// ============================================================================

const INGEST_BACKEND_KIND_SCHEMA = {
  type: 'string',
  enum: ['node', 'rust'],
} as const;

/**
 * Tagged-union schema for the `change` field — mirrors the Rust
 * `#[serde(tag = "action", rename_all = "snake_case")]` enum.
 *
 * AJV's `oneOf` with explicit `action` const per branch is the
 * canonical way to encode a tagged union. An incoming payload
 * matching zero branches → rejected; matching multiple (impossible
 * given const+required action) → rejected too. Keeps the wire
 * contract shape-preserving with the Rust decoder.
 */
const INGEST_BACKEND_POLICY_CHANGE_SCHEMA: JSONSchemaType<WireIngestBackendPolicyChange> = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'set_global' },
        backend: INGEST_BACKEND_KIND_SCHEMA,
      },
      required: ['action', 'backend'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'set_tenant' },
        tenantId: { type: 'string', pattern: UUID_PATTERN },
        backend: INGEST_BACKEND_KIND_SCHEMA,
      },
      required: ['action', 'tenantId', 'backend'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        action: { type: 'string', const: 'remove_tenant' },
        tenantId: { type: 'string', pattern: UUID_PATTERN },
      },
      required: ['action', 'tenantId'],
      additionalProperties: false,
    },
  ],
};

const INGEST_BACKEND_POLICY_CHANGED_SCHEMA: JSONSchemaType<WireIngestBackendPolicyChanged> = {
  type: 'object',
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: {
      type: 'string',
      const: 'IngestBackendPolicyChanged',
    } as const,
    // Platform-wide sentinel — overrides BASE_EVENT_PROPERTIES.tenantId
    // (which requires UUID_PATTERN). The publisher sets 'admin'
    // deterministically; the schema pins it so a consumer-side
    // attacker cannot forge a tenant-scoped policy event.
    tenantId: { type: 'string', const: 'admin' } as const,
    change: INGEST_BACKEND_POLICY_CHANGE_SCHEMA,
    reason: {
      type: 'string',
      maxLength: MAX_FREE_TEXT_LENGTH,
      nullable: true,
    } as const,
    actorId: {
      type: 'string',
      maxLength: MAX_SHORT_CODE_LENGTH,
      nullable: true,
    } as const,
  },
  required: [...BASE_EVENT_REQUIRED, 'change'],
  additionalProperties: false,
} as JSONSchemaType<WireIngestBackendPolicyChanged>;

/**
 * Map of every ingest-backend-policy event type the validator
 * knows about. Used by `validator.ts` to compile + cache per-type
 * AJV validators at module load.
 *
 * Adding a new policy event to this map is the workflow that
 * wires it into runtime validation.
 */
export const INGEST_BACKEND_POLICY_EVENT_SCHEMAS = {
  IngestBackendPolicyChanged: INGEST_BACKEND_POLICY_CHANGED_SCHEMA,
} as const;

export type IngestBackendPolicyEventType =
  keyof typeof INGEST_BACKEND_POLICY_EVENT_SCHEMAS;
