# ADR-024: Compliance Retention Matrix

**Status**: Accepted (2026-09-05, ADR-0012 in `docs/recommendations/architectural-arbiter/`) — enforced by the single registry-driven `RetentionEnforcementService`; windows are declared entity-typed in each service's retention bootstrap module
**Plan reference**: `docs/plans/2026-04-21-db-migrate-enterprise-refactor.md` §v3 R17
**Related**: ADR-022 (HMAC pepper), ADR-023 (encrypted columns)

## Context

Plan v2 specified disparate retentions across migration-adjacent artifacts (90d for `migration_events`, 30d for `_archive/`, 30d for schema snapshots, unspecified for `schema_object_history`, unlimited for `findings.jsonl`). Compliance-expert audit (v3) flagged:

- 90d for `migration_events` < SOC2 12-month minimum (CC4.1 change-management evidence)
- 30d for `_archive/` disqualifying for SOC2 Type II audit window
- Unspecified `schema_object_history` fails auditor "show me PII column history" question
- Unlimited `findings.jsonl` without PII-scrub gate risks Art 5(e) minimisation concern

GDPR Art 5 (data minimisation — retention only as long as necessary) and SOC2 CC4.1 (change-management evidence — typically 12mo+) create competing pressure. Without a principled policy, retentions drift per-table without traceability.

## Decision

Published retention matrix with dual-column (GDPR max, SOC2 min) and resolution logic.

| Artifact                                                    | GDPR-max                             | SOC2-min                            | **DECISION**                              | Rationale                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------ | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `observability.migration_events`                            | as short as necessary                | ≥ 12mo                              | **13 months**                             | SOC2 window + 1-month buffer; no PII after HMAC + erasure cascade (ADR-022); partition monthly                    |
| `observability.schema_object_history`                       | no PII by design (column names only) | ≥ 12mo, 7y for change-mgmt          | **7 years**                               | Full SOC2 change-mgmt horizon; PII-scrubber CI gate asserts no tenant-identifier strings slip into old/new values |
| `observability.emergency_overrides` (Phase 8 `aqua-ctl`)    | n/a                                  | ≥ 7 years (CC7.1 incident evidence) | **7 years**                               | Emergency override is incident-class; quarterly SRE review                                                        |
| `apps/*/src/database/migrations/_archive/`                  | n/a                                  | ≥ 7 years                           | **7 years**                               | git-LFS + S3 Glacier (cost-effective cold storage); not in live filesystem                                        |
| `s3://aqua-deploy-artifacts-fra1/schema-snapshots/`         | minimise (PII via column names)      | n/a                                 | **30 days**                               | Snapshot is deploy-gate input only; KVKK residency at FRA1 (ADR-024 cross-references R4 of plan)                  |
| `docs/reviews/_registry/findings.jsonl`                     | minimise                             | ≥ 7 years (audit trail)             | **7 years + hash-chain + PII-scrub gate** | Append-only; cryptographic integrity; CI gate prevents PII leakage into audit log                                 |
| `observability.migration_backfill_progress` (Phase 3.5)     | minimise                             | n/a                                 | **90 days after backfill completes**      | Operational/resumability data; stale rows serve no purpose                                                        |
| `s3://aqua-deploy-artifacts-fra1/spaces-access-logs/` (R36) | minimise                             | n/a                                 | **1 year**                                | Forensics window for snapshot access                                                                              |

### PII-scrubber gate for `findings.jsonl`

`tools/gates/findings-pii-scan.ts` — CI gate scans every new registry entry for:

- Email address regex
- Phone number regex (E.164 + Turkish formats)
- Turkish TC Kimlik No regex (11-digit validation algorithm)
- IBAN regex
- Credit card (PAN) regex

On match: PR fails with pointer to the leaking field; author must redact or use HMAC reference.

### Implementation notes

- `migration_events` partitioning: monthly via TimescaleDB retention policy `SELECT add_retention_policy('migration_events', INTERVAL '13 months')`
- `schema_object_history` 7y retention: pg_cron job monthly moves rows older than 13mo to cold-storage schema `observability.archive` (same table shape)
- `_archive/` Glacier transition: GitHub Actions monthly job packages `_archive/*.ts` → tarball → S3 Glacier; index maintained in `docs/compliance/archive-index.md`
- Findings hash-chain: already implemented in `tools/gates/finding-registry.ts`; CI invariant `e2e/tests/integration/registry-hash-chain-intact.spec.ts` ships in Phase 5

## Consequences

**Positive**:

- SOC2 Type II auditor walk-through: retention matrix is the single authoritative answer
- GDPR Art 5 defense: documented rationale for each retention ≥ minimum necessary
- Cross-tenant incidents: emergency_overrides 7y retention supports post-incident review
- Audit trail tamper-evidence: hash-chain + PII-scrub dual enforcement

**Negative**:

- Cold-storage automation (pg_cron + Glacier transition + git-LFS) is additional infra to maintain
- Separate retention per table means migrations must declare retention explicitly going forward
- PII-scrub false-positives may block legitimate finding entries — mitigated by explicit whitelist exceptions

## Alternatives Considered

1. **Uniform 7-year retention for everything**: simplicity, but violates GDPR minimisation for snapshots + operational data
2. **Uniform 90-day retention**: simplicity, but disqualifies SOC2 change-mgmt evidence
3. **External retention-management tool (AWS Macie, Varonis)**: over-engineered for current scale; revisit at >1000 tenants

## Validation

- Unit: `tools/gates/__tests__/findings-pii-scan.spec.ts` — positive (leaking field → fail) + negative (redacted → pass)
- Integration: `e2e/tests/integration/retention-policy-active.spec.ts` — TimescaleDB policy exists per table; cron job configured
- Audit: compliance-expert primary; observability-expert (TimescaleDB retention mechanics); infra-expert (Glacier + git-LFS cost model)
- E2E: auditor walkthrough — "show me all schema changes to PII columns in Q3 2026" → SQL query against `schema_object_history` returns answer

## Exit Criteria

- Matrix published + linked from `docs/compliance/retention-matrix.md` (canonical reference)
- Each artifact's retention enforced via code (not docs)
- PII-scrub gate active on every PR touching `findings.jsonl`
- Quarterly review: compliance-expert re-reads matrix against current regulations

## References

- SOC2 Trust Services Criteria (TSC) — CC4.1 Monitoring, CC7.1 Detection
- GDPR Art 5(e) — storage limitation
- KVKK Art 7 — data retention
- NIST SP 800-88 — media sanitisation (for cold-storage eventual destruction)
