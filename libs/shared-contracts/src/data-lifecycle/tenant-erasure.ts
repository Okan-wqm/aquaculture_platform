/**
 * Stable storage coordinate for per-service tenant-erasure proof ledgers.
 *
 * This zero-dependency contract is consumed by both backend schema discovery
 * and the outbox DDL projection. It must not live in either implementation
 * library, otherwise importing the coordinate creates a dependency cycle.
 */
export const TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE = 'tenant_erasure_target_proofs' as const;
