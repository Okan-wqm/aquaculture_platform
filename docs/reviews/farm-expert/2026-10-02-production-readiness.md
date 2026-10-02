# Farm-service stock and lifecycle integrity — production readiness review (2026-10-02)

| Field | Value |
| ----- | ----- |
| Date | 2026-10-02 |
| Reviewer | `farm-expert` (read-only specialist, dispatched by the orchestrator) |
| Question | What blocks this repository from going to production? |
| Scope | apps/farm-service, web/modules/farm-module: stock, feeding, harvest, finance, batches |
| Verdict | **NOT READY** |
| Method | Independent read-only review; claims cite file:line as the reviewer reported them. Items the orchestrator re-checked are marked in the verification section. |

Three blockers in stock and state-machine integrity; three of the open registry HIGH findings are
already fixed in code.

## Blockers

- **B1. The feed-ledger completion can double count.**
  `apps/farm-service/src/database/migrations/1809800000000-CompleteFeedInventoryLedgerBackfill.ts:103-156`
  drops the feed-level guard and imports every legacy `feed_inventory` row. The earlier
  migration's own docstring (`1806100000000…ts:26-32`) says Phase A wrote both ledgers, so for
  feeds already in the ledger this adds the legacy balance on top and inflates `feeds.quantity`.
  Nothing classifies rows as ALREADY_REPRESENTED or CONFLICT, and nothing records provenance.
  `postCondition` (`:188-205`) only checks that each row is present, not that balances match.
- **B2. Harvest can reopen a closed batch.**
  - `events/listeners/harvest-completed.listener.ts:293-304` sets HARVESTING on any late
    partial-harvest event without `canTransitionTo`. A partial harvest followed by the final one
    inside the outbox relay window turns CLOSED back into HARVESTING.
  - `harvest/handlers/delete-harvest-record.handler.ts:90-103` puts quantity and tank stock back
    on a CLOSED batch with no status check, so its frozen final FCR is wrong.
- **B3. Web harvest never moves stock.** HarvestPlansPage calls `completeHarvestPlan`, and
  `harvest/services/harvest-plan.service.ts:447-467` only flips the plan status. No HarvestRecord,
  batch/tank decrement, BatchHarvested event or batch close happens. `useCreateHarvestRecord`
  (`hooks/useBatches.ts:1021`) is never used.

## Major

- **M4. Finance totals mix currencies.** Manual feeding currency defaults to `'TRY'` as free text
  (`feeding/dto/create-feeding-record.input.ts:209-213`). The summary SUM
  (`finance/services/finance-ledger-query.service.ts:212-232`) has no currency filter or FX, and
  the default currency can be changed at any time.
- **M5. No server-side idempotency on manual feeding or harvest.** The deduction key is
  `feeding-deduct-${saved.id}` (`feeding/services/feeding-ledger.service.ts:229-232`), so a double
  submit deducts twice. `createHarvestRecord` accepts requests without the envelope.
  `tests/invariants/stock-mutating-handlers-reject-legacy.spec.ts:17-24` lists only 4 handlers.
- **M6. `storage/handlers/transfer-stock.handler.ts:92-185` bypasses the stock sink.** No roll-up,
  `lotNumber ?? undefined` picks an arbitrary lot, the destination loses lot/receivedDate, and the
  idempotency check runs outside the transaction.
- **M7. Any authenticated user can close a live batch.**
  `batch/handlers/delete-batch.handler.ts:39-44` sets CLOSED from any state, even with fish in the
  tank. The REST `DELETE` route (`batch/controllers/batch.controller.ts:355`) has no `@Roles`,
  `RolesGuard` lets any logged-in user through, and `PermissionMatrixGuard` skips HTTP.

## Minor

- Period FCR uses the net biomass change and ignores fish removed
  (`growth/services/fcr-calculation.service.ts:267-277`).
- `BatchProductionCompleted` carries only the final harvest's quantity
  (`harvest-completed.listener.ts:456-458`).

## FE–BE contract

All five drifts in the 2026-06-24 audit are fixed (stale). The CI gate only checks root fields;
codegen does not validate farm-module documents, so nested-field drift goes undetected.

## Registry check (16 items)

| ID | Result | Evidence |
| --- | ------ | -------- |
| FARM-CRITICAL-238 | CONFIRMED, past its 2026-07-18 deadline | Blocker B1 |
| FARM-HIGH-239 | PARTIAL | Inventory-count approval fixed (`approve-inventory-count.handler.ts:85`); stock transfer still confirmed |
| FARM-HIGH-138 | PARTIAL | The tank-batch writer now rejects overdraft but throws a plain `Error` (500); the `tank.currentBiomass` clamps remain (`create-harvest-record.handler.ts:418`, `record-mortality.handler.ts:327`) |
| FARM-HIGH-003 | PARTIAL | Site create is converged; the rest of the umbrella not verified |
| FARM-HIGH-084, 202, 203 | STALE | The mock directory is gone and the assemblers exist; the registry should close them |
| FARM-HIGH-323 | CONFIRMED | `create-batch.handler.ts:271-274` |
| FARM-HIGH-334 | CONFIRMED | `mortality-recorded.listener.ts:281` compares a date column against a timestamp |
| FARM-HIGH-335/336/337 | CONFIRMED | `get-warehouse-summary.handler.ts:208`, `update-feed.handler.ts:63-68` |
| FARM-HIGH-338 | CONFIRMED | `spare-part.service.ts:241-254` |
| FARM-HIGH-339 | CONFIRMED | `auto-rule-trigger.service.ts:41-46,80-82` |
| FARM-HIGH-340/341 | CONFIRMED | `speciesCode` is never passed at `water-quality.service.ts:299,470,702` |

## Stubs

No `NotImplemented` throws. Four user-visible gaps:

- `SetupPage.tsx:155-176`: Import/Export buttons are disabled "Coming Soon".
- `SpeciesTab.tsx:341`: the species edit form does not load existing feed links (`feedIds: []`
  TODO).
- `harvest-completed.listener.ts:327`: harvest price is hardcoded to 50 (internal report only).
- `useCreateHarvestRecord` exists but nothing calls it.

## Not verified

- Which migrations production has already run, so whether B1 is live; whether Phase A receipts
  actually wrote both ledgers (relied on the migration's own docstring); nested GraphQL
  selections; whether the gateway's `/api/farms` proxy reaches `DELETE /batches/:id`; anything at
  runtime (read-only access, no tests run).

## Registry entries

This review appended 6 finding(s) to `docs/reviews/_registry/findings.jsonl` (state OPEN, owner
okan). Findings the review only confirmed, such as ALERT-CRITICAL-009 or the INFRA-CRITICAL
deploy-pipeline cluster, already exist and were not re-filed.

| ID | Severity | Title |
| --- | --- | --- |
| FARM-CRITICAL-365 | CRITICAL | Web harvest never moves stock: HarvestPlansPage calls completeHarvestPlan which only flips the plan status, so no HarvestRecord, batch or tank decrement, BatchHarvested event or batch close happens, and useCreateHarvestRecord is never used |
| FARM-HIGH-364 | HIGH | Harvest can reopen a closed batch: the harvest-completed listener sets HARVESTING on a late partial-harvest event without canTransitionTo, so a partial harvest followed by the final one inside the outbox relay window turns CLOSED back into HARVESTING, and deleting a harvest record restores stock on a CLOSED batch with no status check, leaving the frozen final FCR wrong |
| FARM-HIGH-366 | HIGH | Finance totals mix currencies: manual feeding currency defaults to the free-text TRY, the summary SUM has no currency filter or FX, and the default currency can be changed at any time |
| FARM-HIGH-367 | HIGH | Manual feeding and harvest have no server-side idempotency: the deduction key is `feeding-deduct-<recordId>` so a double submit deducts twice, createHarvestRecord accepts requests without the envelope, and the legacy-rejection invariant lists only 4 stock-mutating handlers |
| FARM-HIGH-368 | HIGH | Any authenticated user can close a live batch: delete-batch sets CLOSED from any state even with fish in the tank, and the REST DELETE route has no @Roles while RolesGuard lets any logged-in user through and PermissionMatrixGuard skips HTTP |
| FARM-LOW-369 | LOW | Period FCR uses the net biomass change and ignores fish removed, and BatchProductionCompleted carries only the final harvest quantity |
