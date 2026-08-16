import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import type {
  AccessTokenInvalidationRequestedEvent,
  UserAccessTokenInvalidationRequestedEvent,
} from '../auth-events';
import { AUTH_EVENT_SCHEMAS, type AuthEventType } from './auth-events.schema';
import { FARM_EVENT_SCHEMAS, type FarmEventType } from './farm-events.schema';
import { FINANCE_EVENT_SCHEMAS, type FinanceEventType } from './finance-events.schema';
import {
  INGEST_BACKEND_POLICY_EVENT_SCHEMAS,
  type IngestBackendPolicyEventType,
} from './ingest-backend-policy.schema';
import { MESSAGING_EVENT_SCHEMAS, type MessagingEventType } from './messaging-events.schema';
import { SENSOR_EVENT_SCHEMAS, type SensorEventType } from './sensor-events.schema';
import { TENANT_EVENT_SCHEMAS, type TenantEventType } from './tenant-events.schema';

/**
 * @module EventContractsValidator
 *
 * AJV-backed runtime validation for domain events crossing a trust
 * boundary (outbox publisher, NATS bridge, external adapters). The
 * validator is built once at module load and returns per-event-type
 * compiled functions so hot paths amortise the schema compilation
 * across every event.
 *
 * # Design constraints
 *
 * 1. **Compile once, run many.** `FarmNatsBridgeService` evaluates this
 *    function on every single NATS message. A fresh `ajv.compile(...)`
 *    per call would dominate the bridge CPU profile. Caching per
 *    event type amortises the cost to the first event only.
 *
 * 2. **Strict mode off, add formats on.** `strict: false` is necessary
 *    because `JSONSchemaType<T>` emits `nullable: true` on optional
 *    fields, which AJV's strict mode flags as ambiguous. Disabling
 *    strict keeps the `nullable` semantics the TypeScript generic
 *    expects. `ajv-formats` provides the `date-time` format that
 *    `common.schema.ts` references for ISO timestamps.
 *
 * 3. **Do NOT removeAdditional.** We want to REJECT events with extra
 *    fields — `additionalProperties: false` in every schema already
 *    does this. Enabling `removeAdditional` would silently strip
 *    extra fields and accept the event, which is the exact behaviour
 *    we're trying to close (H-3 footgun).
 *
 * 4. **allErrors: false.** The bridge does not need to report every
 *    failing field; it only needs a yes/no decision and a first-error
 *    string for operator logging. `false` makes AJV return on the
 *    first failing keyword, which is ~3x faster on invalid input.
 *
 * @see farm-events.schema.ts for the schema catalogue
 */

/**
 * Shared AJV instance. A single instance is correct because each
 * `ajv.compile()` call produces an independent closed-over
 * `ValidateFunction` — the compiled validators do not share mutable
 * state. Keeping one instance avoids redundant meta-schema loading.
 *
 * `strict: false` — see class-level doc for rationale.
 * `allErrors: false` — first-error-only for hot-path speed.
 */
const ajv = new Ajv({
  strict: false,
  allErrors: false,
  removeAdditional: false,
});
addFormats(ajv);

/**
 * Compiled validator cache keyed by event type. Populated at module
 * load — see immediately-invoked loop below.
 */
const farmValidators = new Map<FarmEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(FARM_EVENT_SCHEMAS)) {
  // The schema map carries values typed as plain `object` (see
  // farm-events.schema.ts for the rationale — deep inference would
  // trip TS7056). AJV's compile signature expects `AnySchema`; the
  // cast is safe because every value in the map was built via
  // `JSONSchemaType<T>` at its definition site, which AJV treats as
  // structurally compatible with `AnySchema` at runtime.
  const validator = ajv.compile(schema as AnySchema);
  farmValidators.set(eventType as FarmEventType, validator);
}

/**
 * Sensor-domain validator cache. Same compile-once posture as the
 * farm validators above; populated at module load.
 */
const sensorValidators = new Map<SensorEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(SENSOR_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  sensorValidators.set(eventType as SensorEventType, validator);
}

/**
 * Messaging-domain validator cache. Used by gateway bridges and release gates
 * to keep messaging's NATS payload contract in sync with the TypeScript union.
 */
const messagingValidators = new Map<MessagingEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(MESSAGING_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  messagingValidators.set(eventType as MessagingEventType, validator);
}

/**
 * Tenant lifecycle / provisioning validator cache (MEDIUM-007). Drives
 * trust-boundary validation of the durable tenant events the outbox publishes
 * and that messaging / billing / farm / sensor consumers read.
 */
const tenantValidators = new Map<TenantEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(TENANT_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  tenantValidators.set(eventType as TenantEventType, validator);
}

/**
 * Auth-domain validator cache (DATA-MEDIUM-001). Validates the auth events
 * crossing the NATS trust boundary — GDPR cascade (UserDeleted), consent,
 * password-reset, and the auth-published UserInvited delivery event — before a
 * consumer (notification / ai / messaging) acts on them.
 */
const authValidators = new Map<AuthEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(AUTH_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  authValidators.set(eventType as AuthEventType, validator);
}

/**
 * Finance-domain validator cache. Validates tenant-finance events
 * crossing the NATS trust boundary — today the hr-service consumer of
 * `FinanceSettingsUpdated` (currency SSoT projection); tomorrow the
 * standalone finance-service projections. Same compile-once posture
 * as the farm validators above.
 */
const financeValidators = new Map<FinanceEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(FINANCE_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  financeValidators.set(eventType as FinanceEventType, validator);
}

/**
 * Ingest-backend-policy event validator cache. Populated at module
 * load. Drives the ADR-031 NATS wire validation on the admin-api
 * publisher side (defense-in-depth) + on any future TS consumer
 * that subscribes to `policy.ingest_backend.>`.
 */
const ingestBackendPolicyValidators = new Map<IngestBackendPolicyEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(INGEST_BACKEND_POLICY_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  ingestBackendPolicyValidators.set(eventType as IngestBackendPolicyEventType, validator);
}

/**
 * Result of a farm event validation call.
 *
 *   - `{ valid: true }` — payload conforms to the schema for the
 *     requested event type. The bridge may forward it to the gateway.
 *   - `{ valid: false, errors: string }` — payload does not conform,
 *     or the event type has no registered schema. The bridge MUST
 *     drop the event. `errors` is a short human-readable summary
 *     suitable for a single-line warn log.
 */
export type FarmEventValidationResult = { valid: true } | { valid: false; errors: string };

/**
 * Validate a decoded NATS payload against the farm event schema for
 * the given event type. Returns a discriminated result so the caller
 * can branch cleanly without touching AJV internals.
 *
 * # Behaviour
 *
 *   - If `eventType` has no registered schema, the call returns
 *     `{ valid: false }` with a descriptive error. The bridge uses
 *     this branch to drop events it was not told to expect —
 *     defense in depth beyond the subscription-pattern filter.
 *
 *   - If `payload` is not an object, the call returns `{ valid: false }`
 *     without invoking the compiled validator (which would otherwise
 *     throw). This guards against `JSON.parse` results that are
 *     legitimately a number, null, or array at the top level.
 *
 *   - If the compiled validator rejects, the result carries a
 *     compact error string built from the first failing keyword.
 *     The full `ajv.errors` array is intentionally not surfaced
 *     because the bridge logs a single line per drop — more detail
 *     would push operational noise into the log pipeline without
 *     helping triage.
 *
 * @param eventType Discriminator from the NATS subject (already
 *   trusted after CR-1 subject parsing) or from the decoded payload.
 *   Using the subject-derived version is strongly recommended so
 *   validation is anchored to the server-stamped routing key.
 * @param payload Decoded JSON value from the NATS message body.
 *
 * @see FarmNatsBridgeService — the primary caller.
 */
export function validateFarmEvent(eventType: string, payload: unknown): FarmEventValidationResult {
  const validator = farmValidators.get(eventType as FarmEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown farm event type: ${eventType}`,
    };
  }

  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }

  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }

  return { valid: true };
}

/**
 * Format the first AJV error into a one-line string safe for a warn
 * log. Intentionally drops the full error list — if deeper debugging
 * is needed, raise the log level and re-validate in isolation with
 * `allErrors: true`.
 *
 * Format: `<instancePath> <message>` e.g. `/reason must be equal to
 * one of the allowed values`. Falls back to a generic message if
 * `errors` is null or empty.
 */
/**
 * Result of a sensor event validation call. Same discriminated shape
 * as [`FarmEventValidationResult`] so callers can branch uniformly.
 */
export type SensorEventValidationResult = { valid: true } | { valid: false; errors: string };

export type MessagingEventValidationResult = { valid: true } | { valid: false; errors: string };

function feedingWindowReadinessSemanticError(
  payload: Readonly<Record<string, unknown>>,
): string | null {
  const batchIndex = payload['batchIndex'];
  const batchCount = payload['batchCount'];
  if (
    typeof batchIndex !== 'number' ||
    typeof batchCount !== 'number' ||
    batchIndex >= batchCount
  ) {
    return 'batchIndex must identify an existing batch';
  }

  const windowStart = Date.parse(String(payload['windowStart']));
  const windowEnd = Date.parse(String(payload['windowEnd']));
  const evaluatedAt = Date.parse(String(payload['evaluatedAt']));
  if (windowStart > windowEnd) {
    return 'windowStart must not be after windowEnd';
  }

  const seenMealIds = new Set<string>();
  const verdicts = payload['verdicts'] as ReadonlyArray<Readonly<Record<string, unknown>>>;
  for (const verdict of verdicts) {
    const mealId = String(verdict['mealId']);
    if (seenMealIds.has(mealId)) {
      return `duplicate verdict for meal ${mealId}`;
    }
    seenMealIds.add(mealId);

    const scheduledAt = Date.parse(String(verdict['scheduledAt']));
    if (scheduledAt < windowStart || scheduledAt > windowEnd) {
      return `meal ${mealId} is outside the declared readiness window`;
    }

    const status = verdict['status'];
    const observed = verdict['observedDissolvedOxygen'];
    const observedAtValue = verdict['observedAt'];
    const hasObservation = typeof observed === 'number' && typeof observedAtValue === 'string';
    if ((status === 'ready' || status === 'low_oxygen') && !hasObservation) {
      return `${String(status)} verdict for meal ${mealId} requires an observation`;
    }
    if ((status === 'no_reading' || status === 'not_instrumented') && hasObservation) {
      return `${String(status)} verdict for meal ${mealId} cannot carry an observation`;
    }
    if (hasObservation && Date.parse(observedAtValue) > evaluatedAt) {
      return `meal ${mealId} observation is newer than the evaluation instant`;
    }

    const floor = verdict['minDissolvedOxygen'];
    if (
      typeof floor === 'number' &&
      typeof observed === 'number' &&
      ((status === 'ready' && observed < floor) || (status === 'low_oxygen' && observed >= floor))
    ) {
      return `${String(status)} verdict for meal ${mealId} contradicts its oxygen values`;
    }
  }

  return null;
}

/**
 * Validate a decoded NATS payload against the sensor event schema for
 * the given event type. Mirrors [`validateFarmEvent`]; the only
 * differences are the validator cache + the error string prefix so
 * operators can grep "sensor event" vs "farm event" in logs.
 *
 * Use this in the NestJS NATS consumer
 * (`apps/sensor-service/src/ingestion/nats-ingestion-consumer.service.ts`)
 * AND in any future cache-miss responder downstream that decodes
 * untrusted JSON before acting on it. The Rust producer's
 * `serde(deny_unknown_fields)` already validates the wire on the
 * publish side; this is the receive-side counterpart.
 */
export function validateSensorEvent(
  eventType: string,
  payload: unknown,
): SensorEventValidationResult {
  const validator = sensorValidators.get(eventType as SensorEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown sensor event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  if (eventType === 'FeedingWindowReadiness') {
    const semanticError = feedingWindowReadinessSemanticError(
      payload as Readonly<Record<string, unknown>>,
    );
    if (semanticError !== null) {
      return { valid: false, errors: semanticError };
    }
  }
  return { valid: true };
}

export function validateMessagingEvent(
  eventType: string,
  payload: unknown,
): MessagingEventValidationResult {
  const validator = messagingValidators.get(eventType as MessagingEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown messaging event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  return { valid: true };
}

export type TenantEventValidationResult = { valid: true } | { valid: false; errors: string };

/**
 * Validate a decoded tenant lifecycle / provisioning event against its schema
 * (MEDIUM-007). Mirrors [`validateMessagingEvent`]; use at trust boundaries that
 * decode untrusted tenant-event JSON (NATS consumers, outbox-adjacent bridges)
 * before acting on it.
 */
export function validateTenantEvent(
  eventType: string,
  payload: unknown,
): TenantEventValidationResult {
  const validator = tenantValidators.get(eventType as TenantEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown tenant event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  return { valid: true };
}

export type FinanceEventValidationResult = { valid: true } | { valid: false; errors: string };

/**
 * Validate a decoded finance-domain event against its schema. Mirrors
 * [`validateTenantEvent`]; use at trust boundaries that decode untrusted
 * finance-event JSON (the hr-service `FinanceSettingsUpdated` consumer,
 * future finance-service projections) before acting on it.
 */
export function validateFinanceEvent(
  eventType: string,
  payload: unknown,
): FinanceEventValidationResult {
  const validator = financeValidators.get(eventType as FinanceEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown finance event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  return { valid: true };
}

export type AuthEventValidationResult = { valid: true } | { valid: false; errors: string };

/**
 * Validate a decoded auth-domain event against its schema (DATA-MEDIUM-001).
 * Mirrors [`validateTenantEvent`]; use at trust boundaries that decode untrusted
 * auth-event JSON (notification / ai / messaging NATS consumers) before acting.
 */
export function validateAuthEvent(eventType: string, payload: unknown): AuthEventValidationResult {
  const validator = authValidators.get(eventType as AuthEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown auth event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  return { valid: true };
}

export function isUserAccessTokenInvalidationRequestedEvent(
  payload: unknown,
): payload is UserAccessTokenInvalidationRequestedEvent {
  return validateAuthEvent('UserAccessTokenInvalidationRequested', payload).valid;
}

export function isAccessTokenInvalidationRequestedEvent(
  payload: unknown,
): payload is AccessTokenInvalidationRequestedEvent {
  return validateAuthEvent('AccessTokenInvalidationRequested', payload).valid;
}

/**
 * Result of an ingest-backend-policy event validation call. Same
 * discriminated shape as [`FarmEventValidationResult`] so callers
 * can branch uniformly across domain validators.
 */
export type IngestBackendPolicyEventValidationResult =
  { valid: true } | { valid: false; errors: string };

/**
 * Validate a decoded NATS payload against the ADR-031 policy event
 * schema for the given event type. Mirrors [`validateFarmEvent`] +
 * [`validateSensorEvent`]; the admin-api-service publisher MAY call
 * this before publishCore(), and any future TS subscriber on
 * `policy.ingest_backend.>` MUST call it before acting on the
 * decoded body.
 *
 * The Rust sidecar's subscriber performs a structurally equivalent
 * validation via `serde_json::from_slice::<IngestBackendChange>()`
 * which rejects missing / extra fields and wrong types. This TS
 * validator is the mirror guarantee for the TS side of the wire.
 */
export function validateIngestBackendPolicyEvent(
  eventType: string,
  payload: unknown,
): IngestBackendPolicyEventValidationResult {
  const validator = ingestBackendPolicyValidators.get(eventType as IngestBackendPolicyEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown ingest-backend-policy event type: ${eventType}`,
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${typeof payload})`,
    };
  }
  const isValid = validator(payload);
  if (!isValid) {
    return {
      valid: false,
      errors: formatFirstError(validator.errors),
    };
  }
  return { valid: true };
}

function formatFirstError(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) {
    return 'validation failed (no error detail available)';
  }
  const first = errors[0];
  if (!first) return 'validation failed (first error missing)';
  const path = first.instancePath || '(root)';
  return `${path} ${first.message ?? 'failed validation'}`;
}
