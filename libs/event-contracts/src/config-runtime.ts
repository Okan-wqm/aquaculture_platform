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
