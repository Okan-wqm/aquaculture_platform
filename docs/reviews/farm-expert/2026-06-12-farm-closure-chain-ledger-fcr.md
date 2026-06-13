# Farm final-harvest closure chain + ledger-based FCR (Wave 1 port) (2026-06-12)

**Cycle:** 2026-06-10-round3 (4-agent enterprise-grade decision — Agent 1 verdict:
closure-chain MERGE-THEN-IMPROVE, ledger-FCR MERGE-AS-IS) · **Owner:** farm-expert
**Source:** `claude/repository-review-frhfaj@68783cd65` — ported onto current main's
OPTIONAL-isFinal contract (the branch's required-isFinal + field-fabricating upcaster
event-contract files were REJECTED; main #411 optional+identity is authoritative).

## FARM-MEDIUM-002 — final harvest left the batch un-CLOSED with no frozen metrics

### Observation
`BatchHarvested.isFinal` (added in #411) was a wire signal with no backend consumer:
a batch whose stock reached 0 stayed in `HARVESTED` forever — `CLOSED` never reached,
so `finalFCR` / mortality / days-in-production were never frozen into `BatchClosed`.

### Fix (MERGE-THEN-IMPROVE)
`create-harvest-record.handler.ts` dispatches `CloseBatchCommand(HARVEST_COMPLETED)`
**after commit** when `isFinalHarvest` (the same `currentQuantity<=0` value, #411 FARM-LOW-004).
Post-commit is correct, not a workaround: `CloseBatchHandler` opens its own transaction +
`pessimistic_write` lock on the batch row, so nesting would self-deadlock. `CloseBatchHandler`
remains the single owner of the `CLOSED` transition.

**Enterprise-grade improvement over the source branch** (which blanket-ERROR-logged any
close failure): the catch now classifies three cases —
- `BatchWithdrawalBlockedError` → **WARN** (not ERROR): an open medicine-withdrawal period
  makes CloseBatchHandler correctly refuse to auto-close (food-safety, Mattilsynet / EU Reg
  37/2010 — closing hides the open treatment). Expected compliance gate, not a system
  failure; the operator closes manually with `acknowledgeActiveTreatments`. No on-call page.
- `BadRequestException` "zaten kapatılmış" → **DEBUG**: idempotent double-final-harvest race
  (a concurrent close already moved the batch to CLOSED). Benign.
- anything else → **ERROR**: genuine failure; harvest is committed, batch stuck in HARVESTED,
  manual `closeBatch` is the remedy. `isFinal=true` on the wire lets monitoring detect a
  final harvest with no matching `BatchClosed`.

A close failure never fails the already-committed harvest (no rollback).

## FARM-HIGH-007 — cumulative FCR overstated by ignoring exited biomass

### Observation
`fcr-calculation.service.ts` computed realized growth as `currentBiomass − startBiomass`.
Fish that left the system (mortality / cull / harvest / transfer-out) also grew by eating
feed; ignoring them undercounts growth and **overstates FCR**, masking exactly the
herd-health degradation FCR exists to surface.

### Fix (MERGE-AS-IS)
Realized growth now sources the exited biomass from the `TankOperation` ledger:
`growth = (current + net-removed) − start`, where
`net-removed = Σ(mortality+cull+harvest+transfer_out) − Σ(transfer_in)` via a single
`COALESCE(SUM(CASE …)) ` aggregate. Within-batch tank moves (out+in under one batchId) net
to zero. The query is tenant-filtered (`op.tenantId`) as defence-in-depth on top of the
tenant search_path (ADR-011), consistent with every other repo in the service
(`@InjectRepository` + explicit tenant filter — not `getRepository`). One extra aggregate
per call, no N+1.

## FARM-LOW-001 — parseQualityGrade silently upgraded unknown grades to GRADE_A

`parseQualityGrade` returned `GRADE_A` for any unrecognised grade, corrupting grading stats.
Now it throws `BadRequestException`. The GraphQL path is already `@IsEnum`-guarded, so the
throw only affects non-DTO callers — rejecting beats silent relabelling.

## Tests
- `harvest/__tests__/handlers/create-harvest-record.handler.spec.ts` (6): partial→no-close,
  final→CloseBatch-after-commit, generic-failure→ERROR+harvest-survives,
  withdrawal-block→WARN, idempotent-already-closed→DEBUG, unknown-grade→reject.
- `growth/__tests__/services/fcr-calculation.service.spec.ts` (27): ledger nets, transfer-in
  subtraction, removedBiomassKg surfaced into FCR.
- `__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts`: handler
  construction updated for the new `commandBus` arg (no-breakage; closure stubbed for the
  DB-isolation e2e).

No `BREAKING CHANGE` — additive consumer + an internal FCR formula correction; the wire
contract is unchanged (optional isFinal already shipped in #411).

## FARM-MEDIUM-003 (OPEN follow-up — NOT closed by this slice)
`CloseBatchHandler` freezes `finalFCR` from the stored `batch.fcr.actual`, not from the new
ledger-corrected FCR. So `BatchClosed.finalFCR` still reflects whatever last wrote
`batch.fcr.actual`. Wiring the ledger FCR into the `batch.fcr.actual` update path is a
tracked follow-up — out of this slice's scope, registered so it is not dead-on-arrival.

## Tier
Tier-2: the closure transition is owner-enforced by CloseBatchHandler; the FCR correction is
covered by 27 unit cases + a postgres tenant-isolation e2e.
