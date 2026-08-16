/**
 * @aquaculture/backend-common/nats
 *
 * NATS connection factory (cert-is-identity mTLS per ADR-015) and the
 * tenant-validating consumer base that enforces cross-tenant isolation.
 */

export { buildNatsConnectionOptions, DEFAULT_NATS_URL } from './nats-connection.factory';
export type { NatsAuthMode } from './nats-connection.factory';

export { TenantValidatingConsumer } from './tenant-validating-consumer';
export type { TenantValidationResult } from './tenant-validating-consumer';

// PR-B (PLAT-HIGH-003): platform-owned NATS v3 Nest transport — wire-compatible
// replacement for @nestjs/microservices' JSONCodec-bound Transport.NATS.
export { NatsV3Server } from './nats-v3-server.strategy';
export type { NatsV3ServerOptions } from './nats-v3-server.strategy';
export { NatsV3Client } from './nats-v3-client.proxy';
export type { NatsV3ClientOptions } from './nats-v3-client.proxy';
export {
  NatsV3RequestSerializer,
  NatsV3ResponseSerializer,
  NatsV3RequestDeserializer,
  NatsV3ResponseDeserializer,
  encodeNatsJson,
  decodeNatsJson,
} from './nats-v3-codec';
export type { SerializedNatsPayload } from './nats-v3-codec';

export {
  SERVICE_NATS_RUNTIME_PROFILES,
  SERVICE_NATS_RUNTIME_PROJECTION,
  assertServiceNatsHandlerSet,
  compileServiceNatsRuntimeProjection,
  createTenantOnboardingRequirementSnapshot,
  decodeTenantOnboardingRequirementSnapshot,
  requireServiceNatsRuntimeProfile,
  TENANT_ONBOARDING_REQUIREMENT_PROFILE,
} from './service-nats-runtime-profiles';
export type {
  RuntimeEventHandlerBinding,
  ServiceNatsRuntimeProfileV1,
  ServiceNatsRuntimeProjectionV1,
  ServiceNatsRuntimeSubscriptionV1,
  TenantOnboardingRequirementProfileV1,
  TenantOnboardingRequirementSnapshotV1,
} from './service-nats-runtime-profiles';
export { evaluateTenantOnboardingBarrier } from './tenant-onboarding-barrier';
export type {
  TenantOnboardingBarrierDecision,
  TenantOnboardingRequirementEvidence,
} from './tenant-onboarding-barrier';
