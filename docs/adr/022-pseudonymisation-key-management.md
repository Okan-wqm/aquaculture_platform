# ADR-022: Pseudonymisation Key Management (HMAC Pepper)

**Status**: Proposed (2026-04-21) — lands in Phase 0 of the db-migrate enterprise refactor plan
**Plan reference**: `docs/plans/2026-04-21-db-migrate-enterprise-refactor.md` §v3 R3
**Related**: ADR-011 (schema ownership), ADR-014/015 (NATS mTLS), ADR-024 (compliance retention matrix)
**Supersedes**: nothing (new contract)

## Context

Plan v2 proposed `tenant_id_hash = sha256(tenant_schema)` for GDPR Art 17 cascade coverage of `observability.migration_events`. The compliance-expert audit (v3) found this invertible: `tenant_schema` follows a predictable pattern (`tenant_<16 hex>`); any actor holding the list of tenant names can precompute a rainbow table in <1s and reverse the hash. Per GDPR Recital 26, pseudonymised data attributable with "additional information" remains personal data. A 90-day retention window therefore becomes a 90-day Art-17-violation window.

## Decision

Replace raw `sha256` with keyed HMAC-SHA256 using a per-environment pepper stored in Vault.

```
tenant_id_hash = HMAC_SHA256(pepper=TENANT_HASH_PEPPER, message=tenant_schema)
```

### Pepper properties

- Length: 256 bits (32 bytes), random
- Storage: HashiCorp Vault (prod), env file with file-mode 600 (dev)
- Env variable: `TENANT_HASH_PEPPER`
- Rotation cadence: 12 months, or on Vault compromise suspected
- Zeroisation: on tenant-environment decommission, pepper is destroyed + all HMACs indirectly erased

### Rotation flow (forward-only)

1. Generate new pepper `P_new`; add to Vault under versioned path
2. Deploy observability-service consumer with dual-pepper support (reads rows hashed with `P_old` OR `P_new`)
3. Over next 30 days, `recompute-tenant-hash` batch job re-hashes all active `migration_events` + `schema_object_history` rows from `P_old` → `P_new`
4. Verify 100% of rows re-hashed
5. Remove `P_old` from Vault; redeploy consumer without dual-pepper support

### Erasure cascade contract

On `TenantErased` event (GDPR Art 17 request fulfilled):
1. Resolve tenant → canonical `tenant_schema`
2. Compute `tenant_id_hash = HMAC_SHA256(pepper, tenant_schema)`
3. `DELETE FROM observability.migration_events WHERE tenant_id_hash = $1` (indexed delete, <100ms for millions of rows)
4. `DELETE FROM observability.schema_object_history WHERE tenant_id_hash = $1`
5. Emit `TenantErasureCompleted` event with service=`observability`
6. Legal-hold precedence: if `compliance_audit_log.legal_hold = true` for tenant, REFUSE deletion and emit `ErasureBlockedByLegalHold`

## Consequences

**Positive**:
- Rainbow-table attack infeasible without Vault compromise (~2^256 brute force)
- Art-17 cascade is explicit + immediate (not time-bounded via retention)
- SOC2 CC6.1 attestation demonstrable: "pepper rotation log + erasure event log"

**Negative**:
- Operational overhead: Vault integration + pepper rotation runbook
- Dual-pepper window (30 days) adds consumer complexity
- Pepper compromise = all tenant-hash records must be recomputed (degradation path documented)

## Alternatives Considered

1. **Raw sha256 with 30-day retention**: violates SOC2 12-month minimum.
2. **Encryption at rest with KMS key**: heavier; HMAC is purpose-fit for pseudonymisation.
3. **Tenant UUID with explicit erasure cascade only (no hash)**: GDPR "data minimisation" prefers hash-based indirection.

## Validation

- Unit test: `libs/backend-common/src/utils/__tests__/hmac-tenant-hash.spec.ts` — HMAC output matches RFC 2104 test vectors; rejects missing pepper
- Integration: `e2e/tests/integration/tenant-erasure-cascade.spec.ts` — emit `TenantErased`, verify zero rows remaining in `migration_events` + `schema_object_history`
- Audit: compliance-expert mandatory blocker on Phase 0; auth-security-expert reviews pepper handling

## References

- GDPR Recital 26 — pseudonymisation vs anonymisation
- NIST SP 800-108 — key derivation recommendations
- HashiCorp Vault — KV v2 path versioning
