/**
 * @aquaculture/backend-common/nats
 *
 * NATS connection factory (cert-is-identity mTLS per ADR-015) and the
 * tenant-validating consumer base that enforces cross-tenant isolation.
 */

export { buildNatsConnectionOptions, buildNatsTransportOptions } from './nats-connection.factory';
export type { NatsAuthMode } from './nats-connection.factory';

export { TenantValidatingConsumer, TenantValidationResult } from './tenant-validating-consumer';
