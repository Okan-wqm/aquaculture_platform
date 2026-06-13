# Messaging-service unit-test suite restoration (2026-06-13)

## MSG-HIGH-001 — 52 messaging unit tests (10 suites) were RED on main, invisibly

**Severity:** HIGH · **Layer:** test integrity / CI · **Owner:** messaging-expert
**Cycle:** 2026-06-10-round3

### Observation
The messaging-service unit suite was **10 suites / 52 tests failing on main** — and
nobody knew, because the platform has no required status checks, so a red `test` job
never blocks a merge. The breakage was pure **test-setup drift**: as services were
refactored (constructor deps added, transaction/outbox patterns changed, the
`createMockDataSource` factory API changed), their specs were not updated. nx affected
is project-level, so ANY messaging PR ran the whole broken suite and went red — which
silently **blocked the entire Round-3 messaging Wave 2**.

Discovered while building the AI-egress-gate slice; root-caused across all 10 suites.

### Drift classes (per spec)
- **Missing provider** (constructor gained a dep, spec not updated): create-channel
  (TenantUserAdmissionService), add-member (TenantUserAdmissionService), sentiment
  (OutboxPublisher), ai-chat-bridge (ChannelMember + 7 more), storage-quota
  (DataSource + OutboxPublisher).
- **createMockDataSource API drift** (factory now opens a real QueryRunner): data-export.
- **Stale expectation** (behaviour changed): retention-policy (channel-scoped policy
  takes the row-DELETE slow path, not drop_chunks), embedding (commit-per-item via
  dataSource.query, batch queryRunner removed), sentiment (SentimentAlert moved to the
  durable outbox), create-channel (idempotent DM early-returns before any transaction).
- **Tenant-context drift**: channel-member.guard (now requires request.user.tenantId
  and folds it into the membership lookup), tenant-isolation (GetMessagesHandler
  refactored to a single DataSource + runInTenantTransaction; UUID validation now
  rejects the opaque Redis-key test constants).

### Fix
**TEST-ONLY** across all 11 specs (create-channel fixed first as the reference pattern;
the remaining 9 in parallel). No service/runtime behaviour was changed; where a failure
reflected correct new SUT behaviour, the stale assertion was updated to match (never the
SUT to match a stale test). No SUT bugs were found to mask. Banned-construct-clean
(including comments). Full suite firsthand-verified: **28 suites / 198 tests pass, 0
fail** (was 52 fail).

### Tier
Tier-3 (make-it-detectable): the suite is green again so the `test` job is once more a
truthful signal. The deeper gap — that no required status check gates merges, which let
this rot — is an org/branch-protection decision tracked separately (operator-level).
