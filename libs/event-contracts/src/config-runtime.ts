import type { BaseEvent } from './base-event';

/**
 * Config-runtime RPC + change-signal contract (Billing Revival Faz C, D6).
 *
 * # Why this contract exists
 *
 * Operator-entered Stripe keys are written (encrypted) to config-service as
 * `service='platform'` rows on the SYSTEM_TENANT_ID row. billing-service must be
 * able to read the *effective* values at runtime WITHOUT a redeploy and WITHOUT
 * ever receiving a plaintext secret over the GraphQL surface (getAll/GraphQL
 * mask secrets as `[ENCRYPTED]`/null by design). This contract defines the two
 * NATS request-reply subjects config-service exposes for that trusted read
 * path, plus the metadata-only `ConfigurationChanged` signal that lets a
 * consumer invalidate its cache the moment a key changes.
 *
 * SECURITY: the GET_SECRET subject is the ONE place a decrypted platform secret
 * crosses the wire. It is defended in depth — NATS cert-CN publish allowlist
 * (only the billing_service CN may publish it), ServiceIdentity HMAC-v2 on the
 * request, a per-caller (service, key) allowlist, nonce-replay rejection, and a
 * mandatory audit row on every fetch (allow AND deny). The value NEVER appears
 * on an audit row, a log line, or this event.
 */

/**
 * Request-reply subjects. Deliberately NOT under the `request.*` platform RPC
 * prefix so the broad `request.{service}.>` grants can never accidentally cover
 * the secret path — the secret subject is granted to exactly one CN.
 */
export const CONFIG_RUNTIME_SUBJECTS = {
  /** Non-secret effective value read. */
  GET: 'config.runtime.get',
  /** Trusted decrypted-secret read (billing_service CN only). */
  GET_SECRET: 'config.runtime.get_secret',
} as const;

export type ConfigRuntimeSubject =
  (typeof CONFIG_RUNTIME_SUBJECTS)[keyof typeof CONFIG_RUNTIME_SUBJECTS];

/**
 * The system-tenant row that carries platform-level config (Stripe keys live
 * here). Mirrors config-service's `SYSTEM_TENANT_ID`; exported here so the
 * cross-service client (backend-common) and the config-service handler bind the
 * SAME tenant into the ServiceIdentity signature without backend-common taking
 * a dependency on config-service. config-service asserts equality at handler
 * construction so the two can never drift.
 */
export const CONFIG_RUNTIME_SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Namespace foot-gun guard. Platform-level config (Stripe keys, feature flags)
 * lives under `service='platform'`, NOT `service='billing'`. A consumer that
 * queries the wrong namespace silently gets nothing; pinning the constant here
 * keeps every caller honest.
 */
export const CONFIG_RUNTIME_SERVICE = 'platform' as const;

/** Canonical platform key names Faz C consumes. */
export const CONFIG_RUNTIME_KEYS = {
  STRIPE_ENABLED: 'billing.stripe_enabled',
  STRIPE_PUBLIC_KEY: 'billing.stripe_public_key',
  STRIPE_SECRET_KEY: 'billing.stripe_secret_key',
} as const;

/**
 * SCOPED reply-inbox prefix for the config-runtime request-reply client
 * (SEC-CRITICAL-001 cure). The decrypted Stripe secret returns on the reply
 * subject; the default `_INBOX.` prefix is subscribed by EVERY service cert, so
 * a compromised non-billing service could passively read it. Routing the reply
 * through a distinct first token — `_INBOXBILLINGCFG.<nuid>` (NO trailing dot:
 * createInbox appends `.nuid`) — means the broad `_INBOX.>` grants can NEVER
 * match it (NATS matching is segment-exact on the first token). Only
 * billing_service subscribes `_INBOXBILLINGCFG.>` and only config_service
 * publishes it; enforced by the NATS ACL SSoT + nats-invariants.
 */
export const CONFIG_RUNTIME_INBOX_PREFIX = '_INBOXBILLINGCFG';

/**
 * Per-caller (service/key) allowlist for the TRUSTED GET_SECRET path — the SSoT
 * the config-service handler enforces AND the nats-invariant cross-checks against
 * the NATS publish grants (a caller here MUST hold a config.runtime.* publish
 * grant in services.yaml). Keys are `${service}/${key}`; the service segment is
 * the ServiceIdentity caller name (matches the apps/ dir → cert-CN map).
 */
export const CONFIG_RUNTIME_SECRET_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'billing-service': ['platform/billing.stripe_secret_key'],
};

/**
 * Per-caller (service/key) allowlist for the NON-secret GET path. A key here can
 * NEVER be a secret key (the nats-invariant asserts the two maps are disjoint),
 * which is the structural guarantee that GET cannot decrypt-and-leak a secret.
 */
export const CONFIG_RUNTIME_NONSECRET_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'billing-service': ['platform/billing.stripe_enabled', 'platform/billing.stripe_public_key'],
};

/**
 * Atomic CDSE credential bundle owned by config-service.
 *
 * Company defaults use CONFIG_RUNTIME_SYSTEM_TENANT_ID. Existing tenant
 * overrides can only enter through the one-shot legacy cutover; farm-service
 * exposes no tenant credential management API. Individual secret fields are
 * never stored separately, which prevents mixed-generation credentials.
 */
export const MARINE_PROVIDER_CREDENTIAL_SERVICE = 'farm-service' as const;
export const MARINE_PROVIDER_CREDENTIAL_RUNTIME_ACTOR_ID = 'farm-service:runtime' as const;
export const MARINE_PROVIDER_CREDENTIAL_CUTOVER_ACTOR_ID =
  'farm-service:sentinel-credential-cutover' as const;

export const MARINE_PROVIDER_CREDENTIAL_KEYS = {
  CDSE: 'marine.cdse.credentials',
} as const;

export const MARINE_PROVIDER_CREDENTIAL_MAX_BUNDLE_BYTES = 8 * 1024;

export interface MarineProviderCdseCredentialBundle {
  clientId: string;
  clientSecret: string;
  instanceId?: string;
}

const MARINE_PROVIDER_CDSE_FIELDS: ReadonlySet<string> = new Set([
  'clientId',
  'clientSecret',
  'instanceId',
]);

/**
 * Canonical CDSE bundle validator shared by the config trust boundary and the
 * farm runtime. Unknown fields, partial bundles, empty fields, oversized
 * values and oversized UTF-8 JSON are rejected identically on both sides.
 */
export function parseMarineProviderCdseCredentialBundle(
  value: string,
): MarineProviderCdseCredentialBundle | null {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MARINE_PROVIDER_CREDENTIAL_MAX_BUNDLE_BYTES
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).some((field) => !MARINE_PROVIDER_CDSE_FIELDS.has(field)) ||
      !isBoundedString(parsed['clientId'], 1, 512) ||
      !isBoundedString(parsed['clientSecret'], 1, 4096) ||
      (parsed['instanceId'] !== undefined && !isBoundedString(parsed['instanceId'], 1, 512))
    ) {
      return null;
    }
    return {
      clientId: parsed['clientId'],
      clientSecret: parsed['clientSecret'],
      ...(parsed['instanceId'] === undefined ? {} : { instanceId: parsed['instanceId'] }),
    };
  } catch {
    return null;
  }
}

export function serializeMarineProviderCdseCredentialBundle(
  bundle: MarineProviderCdseCredentialBundle,
): string {
  const value = JSON.stringify({
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    ...(bundle.instanceId === undefined ? {} : { instanceId: bundle.instanceId }),
  });
  if (parseMarineProviderCdseCredentialBundle(value) === null) {
    throw new TypeError('Invalid CDSE credential bundle');
  }
  return value;
}

export type MarineProviderCredentialProvider = keyof typeof MARINE_PROVIDER_CREDENTIAL_KEYS;

export function marineProviderCredentialKey(
  provider: MarineProviderCredentialProvider,
): (typeof MARINE_PROVIDER_CREDENTIAL_KEYS)[MarineProviderCredentialProvider] {
  return MARINE_PROVIDER_CREDENTIAL_KEYS[provider];
}

/**
 * Exact request-reply subjects. They deliberately live outside config.runtime
 * so the billing-only grants on that namespace cannot accidentally authorize
 * farm-service credential lifecycle operations.
 */
export const MARINE_PROVIDER_CREDENTIAL_SUBJECTS = {
  RESOLVE: 'config.marine_credentials.resolve',
  UPSERT: 'config.marine_credentials.upsert',
} as const;

export type MarineProviderCredentialSubject =
  (typeof MARINE_PROVIDER_CREDENTIAL_SUBJECTS)[keyof typeof MARINE_PROVIDER_CREDENTIAL_SUBJECTS];

/**
 * Dedicated first-token reply inbox. Only farm_service may subscribe and only
 * config_service may publish, so plaintext resolve replies never traverse the
 * platform-wide `_INBOX.>` namespace.
 */
export const MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX = '_INBOXFARMMARINECFG';

/**
 * Handler-side caller/resource allowlist. Keys use the application identity
 * spelling carried by ServiceIdentity; the NATS invariant maps that identity
 * to its cert CN and verifies the matching exact broker grants.
 */
export const MARINE_PROVIDER_CREDENTIAL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  'farm-service': [`${MARINE_PROVIDER_CREDENTIAL_SERVICE}/${MARINE_PROVIDER_CREDENTIAL_KEYS.CDSE}`],
};

export type MarineProviderCredentialOperation = 'resolve' | 'upsert';

export interface MarineProviderCredentialRequest {
  tenantId: string;
  service: string;
  key: string;
  actorId: string;
  /**
   * Present only for upsert. This is the complete deterministic JSON bundle,
   * never an individual secret field.
   */
  bundleJson?: string;
  identity: ConfigRuntimeIdentity;
}

export interface MarineProviderCredentialCanonicalInput {
  operation: MarineProviderCredentialOperation;
  tenantId: string;
  service: string;
  key: string;
  actorId: string;
  bundleJson?: string;
}

/**
 * Exact HMAC body shared by signer and verifier. The bundle occupies the last
 * line (empty for non-write operations), binding every credential byte to the
 * tenant, actor, key and requested operation.
 */
export function canonicalMarineProviderCredentialBody(
  input: MarineProviderCredentialCanonicalInput,
): string {
  return [
    input.operation,
    input.tenantId,
    input.service,
    input.key,
    input.actorId,
    input.bundleJson ?? '',
  ].join('\n');
}

/**
 * Sanitized credential-resolution outcome. `UNAVAILABLE` carries no provider,
 * persistence, replay-ledger, or secret detail; it exists solely so a trusted
 * runtime consumer cannot mistake an infrastructure failure for an absent
 * company credential.
 */
export enum MarineProviderCredentialResolveOutcome {
  RESOLVED = 'RESOLVED',
  NOT_FOUND = 'NOT_FOUND',
  UNAVAILABLE = 'UNAVAILABLE',
}

export interface MarineProviderCredentialResolvedResult {
  outcome: MarineProviderCredentialResolveOutcome.RESOLVED;
  found: true;
  bundleJson: string;
  sourceTenantId: string;
  configVersion: number;
}

export interface MarineProviderCredentialNotFoundResult {
  outcome: MarineProviderCredentialResolveOutcome.NOT_FOUND;
  found: false;
  bundleJson: null;
  sourceTenantId: string | null;
  configVersion: number | null;
}

export interface MarineProviderCredentialUnavailableResult {
  outcome: MarineProviderCredentialResolveOutcome.UNAVAILABLE;
  found: false;
  bundleJson: null;
  sourceTenantId: null;
  configVersion: null;
}

export type MarineProviderCredentialResolveResult =
  | MarineProviderCredentialResolvedResult
  | MarineProviderCredentialNotFoundResult
  | MarineProviderCredentialUnavailableResult;

const MARINE_PROVIDER_CREDENTIAL_RESOLVE_FIELDS: ReadonlySet<string> = new Set([
  'outcome',
  'found',
  'bundleJson',
  'sourceTenantId',
  'configVersion',
]);

/**
 * Runtime parser for the secret-bearing NATS reply boundary. It returns a new
 * exact object so an upstream implementation cannot append internal failure
 * details to the supposedly sanitized `UNAVAILABLE` outcome.
 */
export function parseMarineProviderCredentialResolveResult(
  value: unknown,
): MarineProviderCredentialResolveResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => !MARINE_PROVIDER_CREDENTIAL_RESOLVE_FIELDS.has(field))
  ) {
    return null;
  }
  const outcome = value['outcome'];
  const found = value['found'];
  const bundleJson = value['bundleJson'];
  const sourceTenantId = value['sourceTenantId'];
  const configVersion = value['configVersion'];

  if (outcome === MarineProviderCredentialResolveOutcome.RESOLVED) {
    if (
      found !== true ||
      typeof bundleJson !== 'string' ||
      parseMarineProviderCdseCredentialBundle(bundleJson) === null ||
      !isBoundedString(sourceTenantId, 1, 64) ||
      !isPositiveSafeInteger(configVersion)
    ) {
      return null;
    }
    return { outcome, found, bundleJson, sourceTenantId, configVersion };
  }

  if (outcome === MarineProviderCredentialResolveOutcome.NOT_FOUND) {
    const hasNoSource = sourceTenantId === null && configVersion === null;
    const hasValidSource =
      isBoundedString(sourceTenantId, 1, 64) && isPositiveSafeInteger(configVersion);
    if (found !== false || bundleJson !== null || (!hasNoSource && !hasValidSource)) {
      return null;
    }
    return { outcome, found, bundleJson, sourceTenantId, configVersion };
  }

  if (
    outcome === MarineProviderCredentialResolveOutcome.UNAVAILABLE &&
    found === false &&
    bundleJson === null &&
    sourceTenantId === null &&
    configVersion === null
  ) {
    return { outcome, found, bundleJson, sourceTenantId, configVersion };
  }

  return null;
}

export enum MarineProviderCredentialMutationOutcome {
  APPLIED = 'APPLIED',
  TENANT_ERASED = 'TENANT_ERASED',
  RETRYABLE_FAILURE = 'RETRYABLE_FAILURE',
}

export interface MarineProviderCredentialMutationResult {
  outcome: MarineProviderCredentialMutationOutcome;
  success: boolean;
  sourceTenantId: string | null;
  configVersion: number | null;
}

const MARINE_PROVIDER_CREDENTIAL_MUTATION_FIELDS = new Set([
  'outcome',
  'success',
  'sourceTenantId',
  'configVersion',
]);

/** Exact runtime parser for the secret mutation request-reply boundary. */
export function parseMarineProviderCredentialMutationResult(
  value: unknown,
): MarineProviderCredentialMutationResult | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((field) => !MARINE_PROVIDER_CREDENTIAL_MUTATION_FIELDS.has(field))
  ) {
    return null;
  }
  const outcome = value['outcome'];
  const success = value['success'];
  const sourceTenantId = value['sourceTenantId'];
  const configVersion = value['configVersion'];
  if (
    outcome === MarineProviderCredentialMutationOutcome.APPLIED &&
    success === true &&
    isBoundedString(sourceTenantId, 1, 64) &&
    isPositiveSafeInteger(configVersion)
  ) {
    return { outcome, success, sourceTenantId, configVersion };
  }
  if (
    (outcome === MarineProviderCredentialMutationOutcome.TENANT_ERASED ||
      outcome === MarineProviderCredentialMutationOutcome.RETRYABLE_FAILURE) &&
    success === false &&
    sourceTenantId === null &&
    configVersion === null
  ) {
    return { outcome, success, sourceTenantId, configVersion };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * ServiceIdentity HMAC-v2 headers, carried inside the NATS request payload
 * because core-NATS request-reply has no HTTP header channel. The handler
 * rebuilds a header map from this object and runs the same
 * `verifyServiceIdentityRequest` a GraphQL subgraph guard uses.
 */
export type ConfigRuntimeIdentity = Record<string, string>;

export interface ConfigRuntimeGetRequest {
  /** MUST be CONFIG_RUNTIME_SERVICE for platform config. */
  service: string;
  key: string;
  /** v2 X-Service-* headers minted by the caller for this exact (subject, body). */
  identity: ConfigRuntimeIdentity;
}

/** Secret read carries the same shape; the subject is what elevates trust. */
export type ConfigRuntimeGetSecretRequest = ConfigRuntimeGetRequest;

/**
 * Uniform reply. A denied caller and an absent row both return
 * `{ found: false, value: null }` — fail-closed with no oracle: the caller
 * cannot distinguish "not allowed" from "not set", so nothing leaks.
 */
export interface ConfigRuntimeResult {
  found: boolean;
  value: string | null;
}

/**
 * The exact bytes a config-runtime request signs. Shared by BOTH the client
 * (signer) and the config-service handler (verifier) so the v2 `X-Service-Body-Hash`
 * matches byte-for-byte regardless of JSON key ordering — Tier-1 make-impossible
 * against the sha256(body)-drift class the service-identity util warns about.
 */
export function canonicalConfigRuntimeBody(service: string, key: string): string {
  return `${service}\n${key}`;
}

/**
 * Metadata-only config-change signal (subject `events.{tenantId}.ConfigurationChanged`).
 *
 * Emitted transactionally via config_outbox on every configuration upsert. It
 * carries NO value and NO secret — only enough to let a consumer decide whether
 * a change is relevant (service + key + isSecret) and invalidate a cache. The
 * secret itself is fetched on demand through GET_SECRET, never pushed. TTL-based
 * snapshotting on the consumer side covers a lost signal, so this event is a
 * best-effort accelerator, not a correctness dependency.
 */
export interface ConfigurationChangedEvent extends BaseEvent {
  eventType: 'ConfigurationChanged';
  /** Config namespace, e.g. 'platform'. */
  service: string;
  /** Config key, e.g. 'billing.stripe_secret_key'. */
  key: string;
  /** Config environment scope ('all' | 'development' | ...). */
  environment: string;
  /** Config value type ('string' | 'boolean' | 'secret' | ...). */
  valueType: string;
  /** Whether the changed row is a secret (redaction is enforced by type). */
  isSecret: boolean;
  /**
   * Optimistic-lock version of the config row after the write. Named
   * `configVersion` (not `version`) so it does not shadow BaseEvent.version
   * (the event-schema version). Lets a consumer detect ordering if needed.
   */
  configVersion: number;
  /** ISO 8601 timestamp of the write. */
  changedAt: string;
}
