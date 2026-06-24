/**
 * @aquaculture/backend-common/compliance
 *
 * Cross-cutting compliance primitives. Currently exposes the canonical
 * LegalHold registry; future additions land here so callers have one
 * obvious import path for compliance concerns.
 */

export * from './legal-hold';
export * from './tenant-erasure';
