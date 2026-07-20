import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import cmemsResolvedSelectionLock from '../catalog/cmems-resolved-selection-lock.v2.generated.json';
import { AUTH_EVENT_SCHEMAS, type AuthEventType } from './auth-events.schema';
import { FARM_EVENT_SCHEMAS, type FarmEventType } from './farm-events.schema';
import { FINANCE_EVENT_SCHEMAS, type FinanceEventType } from './finance-events.schema';
import {
  INGEST_BACKEND_POLICY_EVENT_SCHEMAS,
  type IngestBackendPolicyEventType,
} from './ingest-backend-policy.schema';
import { MESSAGING_EVENT_SCHEMAS, type MessagingEventType } from './messaging-events.schema';
import { MARINE_EVENT_SCHEMAS, type MarineEventType } from './marine-events.schema';
import {
  MARINE_WORKER_CONTROL_REPLY_SCHEMAS,
  MARINE_WORKER_CONTROL_REQUEST_SCHEMAS,
} from './marine-worker-control.schema';
import { SENSOR_EVENT_SCHEMAS, type SensorEventType } from './sensor-events.schema';
import { TENANT_EVENT_SCHEMAS, type TenantEventType } from './tenant-events.schema';
import {
  MARINE_ARTIFACT_FILE_NAMES,
  MARINE_MAX_CLOCK_SKEW_SECONDS,
  MARINE_WORKER_CONTROL_SUBJECTS,
  type MarineWorkerControlSubject,
} from '../marine-worker-control';
import { sha256Utf8Hex } from '../portable-sha256';

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

const utf8Encoder = new TextEncoder();
const MAX_MARINE_GEOJSON_BYTES = 262_144;
const MAX_ARTIFACT_CAPABILITY_URL_BYTES = 4_096;

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

const marineEventValidators = new Map<MarineEventType, ValidateFunction>();

for (const [eventType, schema] of Object.entries(MARINE_EVENT_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  marineEventValidators.set(eventType as MarineEventType, validator);
}

const marineWorkerControlRequestValidators = new Map<
  MarineWorkerControlSubject,
  ValidateFunction
>();

for (const [subject, schema] of Object.entries(MARINE_WORKER_CONTROL_REQUEST_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  marineWorkerControlRequestValidators.set(subject as MarineWorkerControlSubject, validator);
}

const marineWorkerControlReplyValidators = new Map<MarineWorkerControlSubject, ValidateFunction>();

for (const [subject, schema] of Object.entries(MARINE_WORKER_CONTROL_REPLY_SCHEMAS)) {
  const validator = ajv.compile(schema as AnySchema);
  marineWorkerControlReplyValidators.set(subject as MarineWorkerControlSubject, validator);
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

export type MarineContractValidationResult = { valid: true } | { valid: false; errors: string };

/** Validate the durable Marine event before publish or consumption. */
export function validateMarineEvent(
  eventType: string,
  payload: unknown,
): MarineContractValidationResult {
  const validator = marineEventValidators.get(eventType as MarineEventType);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown marine event type: ${eventType}`,
    };
  }
  const schemaResult = validateMarinePayload(validator, payload);
  if (!schemaResult.valid) {
    return schemaResult;
  }
  if (
    eventType === 'MarineAnalysisRequested' &&
    isJsonObject(payload) &&
    payload['aggregateId'] !== payload['analysisJobId']
  ) {
    return {
      valid: false,
      errors: 'MarineAnalysisRequested aggregateId must equal analysisJobId',
    };
  }
  return { valid: true };
}

/**
 * Validate a Core NATS request before the responder mutates authoritative
 * state, including semantic lineage that one JSON Schema cannot compare.
 */
export function validateMarineWorkerControlRequest(
  subject: string,
  payload: unknown,
): MarineContractValidationResult {
  const validator = marineWorkerControlRequestValidators.get(subject as MarineWorkerControlSubject);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown marine worker control request subject: ${subject}`,
    };
  }
  const schemaResult = validateMarinePayload(validator, payload);
  if (!schemaResult.valid) {
    return schemaResult;
  }
  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE) {
    return validateExecutionFinalizeManifestLineage(payload);
  }
  return { valid: true };
}

/** Validate a Core NATS reply against the schema selected by its request subject. */
export function validateMarineWorkerControlReply(
  subject: string,
  payload: unknown,
): MarineContractValidationResult {
  const validator = marineWorkerControlReplyValidators.get(subject as MarineWorkerControlSubject);
  if (!validator) {
    return {
      valid: false,
      errors: `Unknown marine worker control reply subject: ${subject}`,
    };
  }
  const schemaResult = validateMarinePayload(validator, payload);
  if (!schemaResult.valid) {
    return schemaResult;
  }
  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE) {
    return validateExecutionLeaseReplySemantics(payload);
  }
  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE) {
    const capabilityUrlResult = validateArtifactCapabilityUrl(payload);
    if (!capabilityUrlResult.valid) {
      return capabilityUrlResult;
    }
    return validateBoundedLeaseWindow(payload);
  }
  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE) {
    return validateBoundedLeaseWindow(payload);
  }
  if (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW &&
    isJsonObject(payload) &&
    payload['decision'] === 'CONTINUE'
  ) {
    return validateBoundedLeaseWindow(payload);
  }
  return { valid: true };
}

/**
 * Validate a reply and its freshness at a caller-supplied instant. Workers
 * MUST use this deterministic boundary immediately before consuming any
 * execution, credential, or artifact capability.
 */
export function validateMarineWorkerControlReplyAt(
  subject: string,
  payload: unknown,
  now: Date | string,
): MarineContractValidationResult {
  const replyResult = validateMarineWorkerControlReply(subject, payload);
  if (!replyResult.valid) {
    return replyResult;
  }
  if (!isExpiringMarineWorkerReply(subject, payload)) {
    return { valid: true };
  }
  if (!isJsonObject(payload)) {
    return { valid: false, errors: 'Fresh lease reply must be a JSON object' };
  }
  const nowTimestamp = now instanceof Date ? now.getTime() : Date.parse(now);
  const issuedAt = parseContractTimestamp(payload['issuedAt']);
  const expiresAt = parseContractTimestamp(payload['expiresAt']);
  if (
    !Number.isFinite(nowTimestamp) ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= nowTimestamp ||
    issuedAt > nowTimestamp + MARINE_MAX_CLOCK_SKEW_SECONDS * 1_000
  ) {
    return {
      valid: false,
      errors: 'Lease reply is expired or issued beyond the allowed clock skew',
    };
  }
  return { valid: true };
}

function isExpiringMarineWorkerReply(subject: string, payload: unknown): boolean {
  if (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE ||
    subject === MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE ||
    subject === MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE
  ) {
    return true;
  }
  return (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW &&
    isJsonObject(payload) &&
    payload['decision'] === 'CONTINUE'
  );
}

/**
 * Validate request/reply semantics that cannot be expressed by either wire
 * schema in isolation. Farm-service and the worker MUST call this after their
 * individual trust-boundary request/reply validation and before using a lease.
 */
export function validateMarineWorkerControlExchange(
  subject: string,
  request: unknown,
  reply: unknown,
): MarineContractValidationResult {
  const requestResult = validateMarineWorkerControlRequest(subject, request);
  if (!requestResult.valid) {
    return {
      valid: false,
      errors: `Invalid marine worker control request: ${requestResult.errors}`,
    };
  }
  const replyResult = validateMarineWorkerControlReply(subject, reply);
  if (!replyResult.valid) {
    return {
      valid: false,
      errors: `Invalid marine worker control reply: ${replyResult.errors}`,
    };
  }

  if (!isJsonObject(request) || !isJsonObject(reply)) {
    return { valid: false, errors: 'Marine worker control exchange must contain JSON objects' };
  }

  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW) {
    if (
      request['executionLeaseId'] !== reply['executionLeaseId'] ||
      request['leaseVersion'] !== reply['leaseVersion']
    ) {
      return {
        valid: false,
        errors: 'Execution renewal reply does not match the requested fencing epoch',
      };
    }
  }

  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE) {
    if (
      request['tenantId'] !== reply['tenantId'] ||
      request['jobId'] !== reply['jobId'] ||
      request['executionId'] !== reply['executionId'] ||
      request['requestFingerprint'] !== reply['requestFingerprint'] ||
      parseContractTimestamp(request['requestedAt']) !==
        parseContractTimestamp(reply['requestedAt'])
    ) {
      return {
        valid: false,
        errors: 'Execution lease reply does not match the requested execution lineage',
      };
    }
  }

  if (subject === MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE) {
    const credentialKindMatchesProvider =
      request['provider'] === 'CMEMS' && reply['kind'] === 'CMEMS_USERNAME_PASSWORD';
    if (!credentialKindMatchesProvider || request['credentialGeneration'] !== reply['generation']) {
      return {
        valid: false,
        errors: 'Credential lease reply kind or generation does not match the request',
      };
    }
  }

  if (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE &&
    request['operationId'] !== reply['operationId']
  ) {
    return {
      valid: false,
      errors: 'Usage reservation reply does not match the requested operation',
    };
  }

  if (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE &&
    (request['operationId'] !== reply['operationId'] || request['outcome'] !== reply['state'])
  ) {
    return {
      valid: false,
      errors: 'Usage finalization reply does not match the requested operation outcome',
    };
  }

  if (
    subject === MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE &&
    (request['jobId'] !== reply['jobId'] ||
      request['executionId'] !== reply['executionId'] ||
      request['terminalState'] !== reply['state'])
  ) {
    return {
      valid: false,
      errors: 'Execution finalization reply does not match the requested terminal state',
    };
  }

  if (subject !== MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE) {
    return { valid: true };
  }

  const mode = request['mode'];
  const method = reply['method'];
  if ((mode === 'READ' && method !== 'GET') || (mode === 'WRITE' && method !== 'PUT')) {
    return {
      valid: false,
      errors: 'Artifact lease method does not match the requested mode',
    };
  }

  const artifactKind = request['artifactKind'];
  if (typeof artifactKind !== 'string') {
    return { valid: false, errors: 'Artifact lease kind is missing' };
  }
  const artifactFileName = getMarineArtifactFileName(artifactKind);
  if (!artifactFileName) {
    return { valid: false, errors: 'Artifact lease kind is unknown' };
  }

  const tenantId = request['tenantId'];
  const siteId = request['siteId'];
  const expectedJobId = mode === 'READ' ? request['sourceSnapshotJobId'] : request['jobId'];
  const expectedSha256 = mode === 'READ' ? request['artifactSha256'] : request['contentSha256'];
  const objectKey = reply['objectKey'];
  if (
    typeof tenantId !== 'string' ||
    typeof siteId !== 'string' ||
    typeof expectedJobId !== 'string' ||
    typeof expectedSha256 !== 'string' ||
    typeof objectKey !== 'string'
  ) {
    return { valid: false, errors: 'Artifact lease lineage fields are missing' };
  }
  const keySegments = objectKey.split('/');
  if (
    keySegments.length !== 6 ||
    keySegments[0] !== 'marine' ||
    keySegments[1] !== tenantId ||
    keySegments[2] !== siteId ||
    keySegments[3] !== expectedJobId ||
    keySegments[4] !== expectedSha256 ||
    keySegments[5] !== artifactFileName
  ) {
    return {
      valid: false,
      errors: 'Artifact object key does not match the authoritative request lineage',
    };
  }

  if (mode === 'WRITE') {
    const requiredHeaders = reply['requiredHeaders'];
    if (!isJsonObject(requiredHeaders)) {
      return { valid: false, errors: 'Artifact PUT required headers are missing' };
    }
    if (
      requiredHeaders['content-type'] !== request['mediaType'] ||
      requiredHeaders['content-length'] !== String(request['byteLength']) ||
      requiredHeaders['x-amz-checksum-sha256'] !== sha256HexToBase64(expectedSha256)
    ) {
      return {
        valid: false,
        errors: 'Artifact PUT headers do not match the requested content metadata',
      };
    }
  }

  return { valid: true };
}

function validateExecutionFinalizeManifestLineage(
  payload: unknown,
): MarineContractValidationResult {
  if (!isJsonObject(payload)) {
    return { valid: false, errors: 'Execution finalization request must be a JSON object' };
  }
  if (payload['terminalState'] !== 'SUCCEEDED') {
    return { valid: true };
  }
  const tenantId = payload['tenantId'];
  const jobId = payload['jobId'];
  const manifestSha256 = payload['resultManifestSha256'];
  const manifestKey = payload['resultManifestKey'];
  if (
    typeof tenantId !== 'string' ||
    typeof jobId !== 'string' ||
    typeof manifestSha256 !== 'string' ||
    typeof manifestKey !== 'string'
  ) {
    return { valid: false, errors: 'Successful execution manifest lineage is missing' };
  }
  const keySegments = manifestKey.split('/');
  if (
    keySegments.length !== 6 ||
    keySegments[0] !== 'marine' ||
    keySegments[1] !== tenantId ||
    keySegments[3] !== jobId ||
    keySegments[4] !== manifestSha256 ||
    keySegments[5] !== MARINE_ARTIFACT_FILE_NAMES.MANIFEST
  ) {
    return {
      valid: false,
      errors: 'Successful execution manifest key does not match its tenant, job, and content hash',
    };
  }
  return { valid: true };
}

function validateExecutionLeaseReplySemantics(payload: unknown): MarineContractValidationResult {
  const leaseWindowResult = validateBoundedLeaseWindow(payload);
  if (!leaseWindowResult.valid) {
    return leaseWindowResult;
  }
  if (!isJsonObject(payload)) {
    return { valid: false, errors: 'Execution lease reply must be a JSON object' };
  }

  const issuedAt = parseContractTimestamp(payload['issuedAt']);
  const expiresAt = parseContractTimestamp(payload['expiresAt']);
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    typeof payload['renewAfterSeconds'] !== 'number' ||
    issuedAt + payload['renewAfterSeconds'] * 1_000 >= expiresAt
  ) {
    return {
      valid: false,
      errors: 'Execution lease renewal instant must precede lease expiry',
    };
  }

  if (
    typeof payload['marineAreaGeoJson'] !== 'string' ||
    !isCanonicalMarineAreaGeoJson(payload['marineAreaGeoJson']) ||
    sha256Utf8Hex(payload['marineAreaGeoJson']) !== payload['marineAreaSha256']
  ) {
    return {
      valid: false,
      errors:
        'Execution lease marine area is not canonical two-dimensional GeoJSON or its UTF-8 hash differs',
    };
  }

  const selectionResult = validateCmemsSelectionProvenance(payload);
  if (!selectionResult.valid) {
    return selectionResult;
  }

  const sourceSnapshotIsValid =
    (payload['jobKind'] === 'SNAPSHOT' && payload['sourceSnapshotJobId'] === null) ||
    ((payload['jobKind'] === 'AOI_STATS' || payload['jobKind'] === 'TIME_SERIES') &&
      typeof payload['sourceSnapshotJobId'] === 'string');
  if (!sourceSnapshotIsValid) {
    return {
      valid: false,
      errors: 'Execution lease source snapshot does not match its job kind',
    };
  }

  const minimumDepth = payload['depthMinMeters'];
  const maximumDepth = payload['depthMaxMeters'];
  const depthRangeIsValid =
    (minimumDepth === null && maximumDepth === null) ||
    (typeof minimumDepth === 'number' &&
      typeof maximumDepth === 'number' &&
      minimumDepth <= maximumDepth);
  if (!depthRangeIsValid) {
    return {
      valid: false,
      errors: 'Execution lease depth endpoints must form one ordered range',
    };
  }

  const timeStart = parseContractTimestamp(payload['timeStart']);
  const timeEnd = parseContractTimestamp(payload['timeEnd']);
  if (timeStart === undefined || timeEnd === undefined || timeStart > timeEnd) {
    return {
      valid: false,
      errors: 'Execution lease acquisition time range is reversed',
    };
  }

  const providerCoverageStart = parseContractTimestamp(payload['providerCoverageStart']);
  const providerCoverageEnd = parseContractTimestamp(payload['providerCoverageEnd']);
  if (
    providerCoverageStart === undefined ||
    providerCoverageEnd === undefined ||
    providerCoverageStart > providerCoverageEnd ||
    timeStart < providerCoverageStart ||
    timeEnd > providerCoverageEnd
  ) {
    return {
      valid: false,
      errors: 'Execution lease time range is outside the observed provider coverage',
    };
  }

  const requestedAt = parseContractTimestamp(payload['requestedAt']);
  const boundaryValue = payload['temporalPartitionBoundaryAt'];
  if (payload['dataRole'] === 'ANALYSIS' || payload['dataRole'] === 'FORECAST') {
    const boundaryAt = parseContractTimestamp(boundaryValue);
    if (requestedAt === undefined || boundaryAt === undefined || boundaryAt !== requestedAt) {
      return {
        valid: false,
        errors: 'Execution lease temporal partition boundary does not match requestedAt',
      };
    }
    if (payload['dataRole'] === 'ANALYSIS' && timeEnd > boundaryAt) {
      return {
        valid: false,
        errors: 'Analysis selection crosses its immutable temporal partition boundary',
      };
    }
    if (payload['dataRole'] === 'FORECAST' && timeStart <= boundaryAt) {
      return {
        valid: false,
        errors: 'Forecast selection does not start after its immutable temporal boundary',
      };
    }
  } else if (
    (payload['dataRole'] === 'REANALYSIS' || payload['dataRole'] === 'HINDCAST') &&
    boundaryValue !== null
  ) {
    return {
      valid: false,
      errors: 'Execution lease temporal role must not carry a partition boundary',
    };
  }

  const deadlineAt = parseContractTimestamp(payload['deadlineAt']);
  if (
    issuedAt === undefined ||
    deadlineAt === undefined ||
    deadlineAt <= issuedAt ||
    deadlineAt - issuedAt > 600_000
  ) {
    return {
      valid: false,
      errors: 'Execution lease deadline is outside its bounded issuance window',
    };
  }
  return { valid: true };
}

function validateCmemsSelectionProvenance(
  payload: Record<string, unknown>,
): MarineContractValidationResult {
  const provenance = payload['selectionProvenance'];
  if (!isJsonObject(provenance)) {
    return { valid: false, errors: 'Execution lease CMEMS selection provenance is missing' };
  }
  if (payload['provider'] !== 'CMEMS' || provenance['provider'] !== payload['provider']) {
    return {
      valid: false,
      errors: 'Execution lease selection provenance does not match its CMEMS provider',
    };
  }

  const catalogEntryId = provenance['catalogEntryId'];
  if (typeof catalogEntryId !== 'string') {
    return { valid: false, errors: 'Execution lease CMEMS catalogue entry is missing' };
  }
  const resolvedSelection = cmemsResolvedSelectionLock.resolvedSelections.find(
    (candidate) => candidate.selectionProvenance.catalogEntryId === catalogEntryId,
  );
  if (!resolvedSelection || resolvedSelection.dataRole !== payload['dataRole']) {
    return {
      valid: false,
      errors: 'Execution lease data role does not match its locked CMEMS catalogue entry',
    };
  }
  if (!areJsonValuesStructurallyEqual(provenance, resolvedSelection.selectionProvenance)) {
    return {
      valid: false,
      errors: 'Execution lease provenance diverges from its resolved CMEMS catalogue lock',
    };
  }

  return { valid: true };
}

function isCanonicalMarineAreaGeoJson(rawGeoJson: string): boolean {
  if (utf8Encoder.encode(rawGeoJson).byteLength > MAX_MARINE_GEOJSON_BYTES) {
    return false;
  }
  if (
    (rawGeoJson.match(/"type"\s*:/g)?.length ?? 0) !== 1 ||
    (rawGeoJson.match(/"coordinates"\s*:/g)?.length ?? 0) !== 1
  ) {
    return false;
  }
  let geometry: unknown;
  try {
    geometry = JSON.parse(rawGeoJson);
  } catch {
    return false;
  }
  if (!isJsonObject(geometry)) {
    return false;
  }
  const keys = Object.keys(geometry);
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('coordinates')) {
    return false;
  }
  const canonicalBytes = JSON.stringify({
    type: geometry['type'],
    coordinates: geometry['coordinates'],
  });
  if (canonicalBytes !== rawGeoJson) {
    return false;
  }
  if (geometry['type'] === 'Polygon') {
    return isMarinePolygonCoordinates(geometry['coordinates']);
  }
  if (geometry['type'] === 'MultiPolygon') {
    return (
      isUnknownArray(geometry['coordinates']) &&
      geometry['coordinates'].length > 0 &&
      geometry['coordinates'].every(isMarinePolygonCoordinates)
    );
  }
  return false;
}

function isMarinePolygonCoordinates(value: unknown): boolean {
  return isUnknownArray(value) && value.length > 0 && value.every(isMarineLinearRing);
}

function isMarineLinearRing(value: unknown): boolean {
  if (!isUnknownArray(value) || value.length < 4) {
    return false;
  }
  const firstPosition = value[0];
  const lastPosition = value[value.length - 1];
  if (!isMarinePosition(firstPosition) || !isMarinePosition(lastPosition)) {
    return false;
  }
  if (!value.every(isMarinePosition)) {
    return false;
  }
  return firstPosition[0] === lastPosition[0] && firstPosition[1] === lastPosition[1];
}

function isMarinePosition(value: unknown): value is [number, number] {
  if (!isUnknownArray(value) || value.length !== 2) {
    return false;
  }
  const longitude = value[0];
  const latitude = value[1];
  return (
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90
  );
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function validateBoundedLeaseWindow(payload: unknown): MarineContractValidationResult {
  if (!isJsonObject(payload)) {
    return { valid: false, errors: 'Lease reply must be a JSON object' };
  }
  const issuedAt = parseContractTimestamp(payload['issuedAt']);
  const expiresAt = parseContractTimestamp(payload['expiresAt']);
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 60_000
  ) {
    return {
      valid: false,
      errors: 'Lease expiry is outside its bounded issuance window',
    };
  }
  return { valid: true };
}

function validateArtifactCapabilityUrl(payload: unknown): MarineContractValidationResult {
  if (!isJsonObject(payload) || typeof payload['url'] !== 'string') {
    return { valid: false, errors: 'Artifact capability URL is missing' };
  }
  const rawUrl = payload['url'];
  if (
    utf8Encoder.encode(rawUrl).byteLength > MAX_ARTIFACT_CAPABILITY_URL_BYTES ||
    !rawUrl.startsWith('https://') ||
    !hasOnlyVisibleAscii(rawUrl)
  ) {
    return {
      valid: false,
      errors: 'Artifact capability must be a bounded raw lowercase HTTPS URL',
    };
  }
  try {
    const capabilityUrl = new URL(rawUrl);
    const rawAuthority = rawUrl.slice('https://'.length).split(/[/?#]/, 1)[0];
    if (
      capabilityUrl.protocol !== 'https:' ||
      capabilityUrl.hostname.length === 0 ||
      rawAuthority === ''
    ) {
      return { valid: false, errors: 'Artifact capability must use HTTPS with a hostname' };
    }
  } catch {
    return { valid: false, errors: 'Artifact capability must use HTTPS with a hostname' };
  }
  return { valid: true };
}

function hasOnlyVisibleAscii(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e) {
      return false;
    }
  }
  return true;
}

function parseContractTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Object key order is immaterial; array order and the complete key set are authoritative. */
function areJsonValuesStructurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (isUnknownArray(left) || isUnknownArray(right)) {
    return (
      isUnknownArray(left) &&
      isUnknownArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areJsonValuesStructurallyEqual(value, right[index]))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        areJsonValuesStructurallyEqual(left[key], right[key]),
    )
  );
}

function getMarineArtifactFileName(kind: string): string | undefined {
  switch (kind) {
    case 'SOURCE_ZARR':
      return MARINE_ARTIFACT_FILE_NAMES.SOURCE_ZARR;
    case 'RASTER_COG':
      return MARINE_ARTIFACT_FILE_NAMES.RASTER_COG;
    case 'DISPLAY_PNG':
      return MARINE_ARTIFACT_FILE_NAMES.DISPLAY_PNG;
    case 'VECTOR_JSON':
      return MARINE_ARTIFACT_FILE_NAMES.VECTOR_JSON;
    case 'STATISTICS_JSON':
      return MARINE_ARTIFACT_FILE_NAMES.STATISTICS_JSON;
    case 'TIME_SERIES_JSON':
      return MARINE_ARTIFACT_FILE_NAMES.TIME_SERIES_JSON;
    case 'MANIFEST':
      return MARINE_ARTIFACT_FILE_NAMES.MANIFEST;
    default:
      return undefined;
  }
}

function sha256HexToBase64(hex: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let offset = 0; offset < hex.length; offset += 6) {
    const byteCount = Math.min(3, (hex.length - offset) / 2);
    const chunk = Number.parseInt(hex.slice(offset, offset + byteCount * 2), 16);
    const paddedChunk = chunk << ((3 - byteCount) * 8);
    encoded += alphabet[(paddedChunk >>> 18) & 63] ?? '';
    encoded += alphabet[(paddedChunk >>> 12) & 63] ?? '';
    encoded += byteCount >= 2 ? (alphabet[(paddedChunk >>> 6) & 63] ?? '') : '=';
    encoded += byteCount === 3 ? (alphabet[paddedChunk & 63] ?? '') : '=';
  }
  return encoded;
}

function validateMarinePayload(
  validator: ValidateFunction,
  payload: unknown,
): MarineContractValidationResult {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      valid: false,
      errors: `Payload must be a JSON object (got ${
        Array.isArray(payload) ? 'array' : typeof payload
      })`,
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

/**
 * Result of an ingest-backend-policy event validation call. Same
 * discriminated shape as [`FarmEventValidationResult`] so callers
 * can branch uniformly across domain validators.
 */
export type IngestBackendPolicyEventValidationResult =
  | { valid: true }
  | { valid: false; errors: string };

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
