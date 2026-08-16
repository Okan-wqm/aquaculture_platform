# farm-service operations partition — database E2E audit — 2026-08-16

**Agent:** `db-audit-farm-operations` · **Mode:** CATCHER (read-only) · **Lane:** farm
**Cycle:** `2026-08-16-farm-mobile-agent-audit` · **Verdict:** BLOCK
**Findings surviving verification:** 11 (CRITICAL 0 · HIGH 1 · MEDIUM 6 · LOW 4) · 1 refuted

> Produced by a 27-agent audit workflow, then verified by a second 25-agent pass.
> **Every** claim — CRITICAL through LOW — was handed to an independent verifier
> instructed to **refute** it by reopening each cited line, with "refuted" as the
> default when the evidence did not clearly hold. Claims that could not be defended
> were dropped into the Refuted section below; claims that proved smaller or larger
> than filed carry a corrected severity.
>
> **Finding IDs** use the `DB-FARMOPS-*` prefix this agent's contract in
> `.claude/shared/output-format.md` assigns it. That prefix is **rejected** by the
> `id` pattern in `docs/reviews/_registry/findings.jsonl.schema.json`, so these findings
> cannot be registered at all — see `PROC-MEDIUM-016` in the cycle report.

## Scope

Read the rule SSoT (`/home/user/aquaculture_platform/CLAUDE.md`, apps/farm-service/CLAUDE.md,
web/CLAUDE.md) plus
.claude/shared/{output-format,operating-modes}.md,
`.claude/agents/_shared/db-audit-methodology.md`, .claude/knowledge/{layer-1-typeorm,layer-2-patterns,layer-2-defect-catalog}.md.
Backend: enumerated all 38 @Entity classes across
apps/farm-service/src/{feed,feeding,feeding-protocol,storage,farm-stock,consumable,supplier,chemical,finance};
read in full feed.entity.ts, feed-inventory.entity.ts, feeding-protocol.entity.ts,
storage-inventory.entity.ts, stock-movement.entity.ts,
purchase-order.entity.ts, `farm-stock-*-snapshot.entity.ts`, feed-site.entity.ts,
finance-expense-entry.entity.ts; write paths stock-movement.service.ts, feeding-ledger.service.ts,
create-feed.handler.ts, update-feed.handler.ts, approve-inventory-count.handler.ts,
create-inventory-count.handler.ts, transfer-stock.handler.ts, receive-delivery.handler.ts,
spare-part.service.ts; read paths get-warehouse-summary.handler.ts, finance-ledger-query.service.ts,
derived-cost-sources.ts, feed-selection.dataloader.ts, storage.resolver.ts, finance.resolver.ts,
feeding-protocol.resolver.ts, feeding-program.resolver.ts (partial). Migrations: manifest.ts (77
tracked), 1800000000000-Baseline.ts (DDL greps),
1806100000000-BackfillFeedInventoryToStorageLedger.ts,
1806300000000-MigrateFeedingProgramsToProtocolV2.ts,
1806500000000-FeedingCutoverActivateAssignments.ts, farm-seed.service.ts. Frontend:
web/modules/farm-module/src/hooks/{useFeeds,useConsumables,useChemicals,useStorageInventory}.ts,
pages/setup/tabs/{FeedsTab,ConsumablesTab}.tsx, `pages/storage/**` (18 files enumerated,
FeedStockTab read), graphql/finance.operations.ts. No source file was modified.

## Executive summary

The `feed_inventory` `->` `storage_inventory` convergence has effectively
landed: `storage_inventory` \+ `stock_movements` is the physical owner, receive-delivery and feeding
both route through the single StockMovementService sink, and finance derives costs at query time
instead of duplicating them. That core is solid. The defects are on the edges of the ledger. Three
product write paths mutate stock quantities outside the sink:
createFeed/createChemical/createConsumable set `quantity` directly with no movement row, and
ApproveInventoryCount applies count variance without recomputing the item roll-up,
so `feeds.quantity` silently diverges from the ledger and is later overwritten. The
low-stock/reorder chain is structurally dead for feed and chemicals because `minStock` has no editor
in any UI while every detector gates on `minStock > 0`. `maxFishWeightG` is accepted by the create
DTO and sent by the +Add Feed form but never written by the handler. `feed_inventory` is now a fully
orphaned base table still registered as an entity and cloned into every tenant schema. Spare-part
stock changes persist no movement row at all (explicit stub). Legacy feeding-program mutations
remain open post-cutover, gated only at the cron layer.

## Findings (by severity)

### HIGH

### DB-FARMOPS-HIGH-003

**Title:** ApproveInventoryCount applies variance to `storage_inventory` but never recomputes the
item roll-up or the low-stock signal

**Severity:** HIGH
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-HIGH-003` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:114
  \- `if (inventory) { ... inventory.quantity = actualQuantity; ... }` and 129-140 create a new row;
  the transaction ends at line 150 with `countRepo.save(count)` and never touches
  Feed/Chemical/Consumable
- apps/farm-service/src/storage/services/stock-movement.service.ts:263
  \- `await this.updateItemTotalQuantity(...)` is the ONLY roll-up recompute in the service, and
  grep shows it is called from nowhere else
- apps/farm-service/src/storage/services/stock-movement.service.ts:314 \- the LowStockDetected
  outbox enqueue also lives only inside recordMovement, so an approved count that drops stock below
  minimum raises no alert
- apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:81 \- the handler DOES
  write the ADJUSTMENT `stock_movements` row directly instead of routing through the sink, which is
  exactly how the roll-up leg got skipped

**Rule violated:**

Domain invariant 'Movement-ledger balance'; CLAUDE.md Layer Rules 1
(Controller `->` Service `->` Bus `->` Handler `->` Repository, no layer skipping into the
persistence core)

**Proposed fix direction:**

Route the count adjustment through StockMovementService.recordMovement on the approval transaction's
manager, exactly as ReceiveDeliveryHandler does (receive-delivery.handler.ts:104) — that is the
single sink that already owns FEFO bookkeeping, the immutable audit row, the item-total roll-up and
the low-stock enqueue. Then make the bypass impossible: no handler outside the sink should hold a
StockMovement or StorageInventory repository, enforceable by an invariant spec on repository
injection.

**Affected surface (ripple set):**

- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`
- `apps/farm-service/src/storage/storage.module.ts`
- `apps/farm-service/src/storage/**tests**/`
- `tests/invariants/`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Verified in full. approve-inventory-count.handler.ts writes the ADJUSTMENT row (:81-99) and
reconciles `storage_inventory` (:104-141), then ends at `countRepo.save(count)` (:150) — the handler
never imports or touches Feed/Chemical/Consumable (imports at :22-24 are StorageInventory \+
StockMovement only), and its own header comment enumerates exactly two
steps. `updateItemTotalQuantity` is private and grep shows its single call site is
stock-movement.service.ts:263 inside recordMovement; there are no TypeORM EventSubscribers in
apps/farm-service/src and no outbox/event emission from the approve handler, so nothing recomputes
the roll-up out of band. Consequence chain is real: get-storage-overview.handler.ts:193-194 and
get-warehouse-summary.handler.ts:203-205 read the stale master `quantity`, and the LowStockDetected
enqueue (stock-movement.service.ts:314-330) is likewise reachable only from recordMovement, so a
shrinkage correction raises no alert. Path is live (storage.resolver.ts:551,
permission-matrix.ts:20 `TENANT_ADMIN`, web hook useInventoryCounts.ts:343 \+
InventoryCountDetailModal). Only mitigation: the drift self-heals at the next movement for that
item. Severity stands at HIGH — the operation whose purpose is reconciliation leaves the numbers
operators actually read unreconciled.

### MEDIUM

### DB-FARMOPS-MEDIUM-002

**Title:** Item-master create writes the stock roll-up column with no ledger row; the sink later
overwrites it silently

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-HIGH-002` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feed/handlers/create-feed.handler.ts:135
  \- `quantity: input.quantity ?? 0` inside `feedRepo.create({...})`, with
  no `storage_inventory` row and no `stock_movements` row anywhere in the handler
- apps/farm-service/src/chemical/handlers/create-chemical.handler.ts:85
  \- `quantity: input.quantity ?? 0`
- apps/farm-service/src/consumable/handlers/create-consumable.handler.ts:64
  \- `quantity: input.quantity ?? 0`
- apps/farm-service/src/storage/services/stock-movement.service.ts:747
  \- `feed.quantity = totalQuantity;` — the first real movement replaces the hand-entered value with
  the ledger sum, so the initial quantity vanishes with no audit row explaining the drop
- apps/farm-service/src/feeding/services/feeding-ledger.service.ts:210 \-
  when `feedHasStoragePresence` is false the deduction is skipped entirely, so a feed created this
  way is fed forever without its quantity ever decreasing

**Rule violated:**

Domain invariant 'Movement-ledger balance' (every stock quantity change must carry
a `stock_movements` row); layer-2-patterns 'one physical owner per datum'

**Proposed fix direction:**

Make the roll-up column structurally unwritable from outside the ledger: remove `quantity` from all
four create DTOs and treat `<item>.quantity` as a derived projection owned exclusively by
StockMovementService.updateItemTotalQuantity. If operators need opening stock, model it as a genuine
opening-balance IN movement into a storage location (the same shape migration 1806100000000 already
uses for the `feed_inventory` import), so the ledger and the roll-up can never disagree. Back this
with an invariant spec asserting no writer outside the sink assigns `quantity` on
Feed/Chemical/Consumable.

**Affected surface (ripple set):**

- `apps/farm-service/src/feed/dto/create-feed.input.ts`
- `apps/farm-service/src/chemical/dto/create-chemical.input.ts`
- `apps/farm-service/src/consumable/dto/create-consumable.input.ts`
- `apps/farm-service/src/feed/handlers/create-feed.handler.ts`
- `apps/farm-service/src/chemical/handlers/create-chemical.handler.ts`
- `apps/farm-service/src/consumable/handlers/create-consumable.handler.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`
- `tests/invariants/`

**Expected closer:**

farm-expert WRITER mode; requires database-reviewer sign-off on the opening-balance movement shape

**Verifier note:**

Core mechanism verified: create-feed.handler.ts:135, create-chemical.handler.ts:85 and
create-consumable.handler.ts:64 all write `quantity: input.quantity ?? 0` onto the item master, and
grep for StorageInventory/StockMovement/recordMovement in all three handlers returns zero hits — no
ledger row is created. stock-movement.service.ts:729-747 (`updateItemTotalQuantity`) then
recomputes `feed.quantity = totalQuantity` from `SUM(storage_inventory`), so the hand-entered
opening balance is silently replaced on the first real movement. Two corrections shrink the impact:
(1) reachability is narrower than implied — FeedsTab.tsx and ChemicalsTab.tsx never
send `quantity` (grep: no match in either file), so the feed/chemical legs are API-only; only
ConsumablesTab.tsx:249/587 actually ships an initial quantity from the product UI; (2) the
feeding-ledger.service.ts leg is not a defect — the skip is the documented, deliberately warned
Phase-A branch for `feed_inventory-only` tenants (`feedHasStoragePresence` false → logger.warn), and
the storage-tracked path is fail-closed with a BadRequestException. Real inconsistency, reachable
via one form and the API, self-limited to an opening balance: MEDIUM.

### DB-FARMOPS-MEDIUM-004

**Title:** maxFishWeightG is accepted by the API and submitted by the +Add Feed form but never
persisted on create

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMOPS-HIGH-004` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feed/entities/feed.entity.ts:358 \- `maxFishWeightG?: number;` mapped to
  column `max_fish_weight_g`
- apps/farm-service/src/feed/dto/create-feed.input.ts:468 \- `maxFishWeightG?: number;` present on
  the create input (so ValidationPipe whitelist accepts it)
- apps/farm-service/src/feed/handlers/create-feed.handler.ts:167
  \- `minFishWeightG: input.minFishWeightG,` is the last field of the create object literal (line
  121-171); `maxFishWeightG` never appears in the handler
- web/modules/farm-module/src/pages/setup/tabs/FeedsTab.tsx:314
  \- `maxFishWeightG: formData.maxFishWeightG ? Number(...) : undefined` is sent, and line
  364 `createFeed.mutateAsync(input as CreateFeedInput)` submits it
- web/modules/farm-module/src/pages/setup/tabs/FeedsTab.tsx:621 \- the card
  renders `feed.maxFishWeightG`, so the operator sees '?' after a successful save

**Rule violated:**

CLAUDE.md Architectural Approach — 'Missing field `->` add the @Column \+ DTO field';
layer-2-defect-catalog 'copy-paste / identifier typo (a renamed-but-not-everywhere symbol)'

**Proposed fix direction:**

Fix the drop, then remove the class of bug: hand-maintained field-by-field create object literals
are the root cause. Derive the persisted payload from the DTO shape (a typed pick/mapper whose
exhaustiveness the compiler checks) so a DTO field with no persistence target is a build error, not
a silent no-op. A parity invariant asserting CreateFeedInput fields subset Feed mapped columns
closes the remaining gap for the sibling handlers (chemical, consumable, supplier).

**Affected surface (ripple set):**

- `apps/farm-service/src/feed/handlers/create-feed.handler.ts`
- `apps/farm-service/src/feed/dto/create-feed.input.ts`
- `appsts/farm-service/src/feed/**tests**/`
- `apps/farm-service/src/chemical/handlers/create-chemical.handler.ts`
- `apps/farm-service/src/consumable/handlers/create-consumable.handler.ts`
- `tests/invariants/`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Fact pattern verified exactly: grep for maxFishWeightG across apps/farm-service/src returns only
feed.entity.ts:358, create-feed.input.ts:468 and feed.response.ts:308 — it appears nowhere in
create-feed.handler.ts, whose create object ends at `minFishWeightG: input.minFishWeightG,` (:167).
FeedsTab.tsx:314 does send it and useFeeds.ts:312 selects it back, so the create round-trip drops
the value and the card at FeedsTab.tsx:621 renders '?'. Downgrade reasons: the loss is create-only —
UpdateFeedHandler (:63-68) Object.assigns the whole partial input, and FeedsTab.tsx:361 sends the
same object on edit, so re-saving the feed persists it; and no backend logic consumes maxFishWeightG
(no reference outside entity/DTO/response), so this is a display/data-entry loss on one optional
field, not a behavioural or safety defect. MEDIUM.

### DB-FARMOPS-MEDIUM-005

**Title:** Spare-part stock is mutated with no persisted movement ledger — the audit row is built in
memory and discarded

**Severity:** MEDIUM (filed as HIGH, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-HIGH-005` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/maintenance/services/spare-part.service.ts:263
  \-

  ```text
  // Log movement (in a real implementation, this would be stored in a separate table)
  ```

- apps/farm-service/src/maintenance/services/spare-part.service.ts:264
  \- `const movement: StockMovement = { id: Date.now().toString(), ... }` is constructed and then
  never persisted; line 283 returns `this.sparePartRepository.save(sparePart)` only
- apps/farm-service/src/maintenance/services/spare-part.service.ts:241
  \- `sparePart.quantity += input.quantity;` (and 250 `-=`, 254 absolute set for 'adjustment')
  mutate durable stock with no ledger row
- apps/farm-service/src/maintenance/services/spare-part.service.ts:27
  \- `export interface StockMovement {` — a second, in-memory-only StockMovement type shadowing the
  real storage entity

**Rule violated:**

Domain invariant 'Movement-ledger balance'; layer-2-defect-catalog Hygiene ('TODO/stub on a
reachable path'). Incidental finding per db-audit-methodology 'Mandatory incidental findings'.

**Proposed fix direction:**

Spare parts are a fifth stock item type competing with the converged storage ledger. Fold them into
the existing single ledger: add `SPARE_PART` to StorageItemType and route spare-part
in/out/adjustment through StockMovementService.recordMovement, deleting the shadow interface. That
inherits idempotency, the immutable audit row, the roll-up and the low-stock sink for free rather
than rebuilding a fourth copy of the same machinery.

**Affected surface (ripple set):**

- `apps/farm-service/src/maintenance/services/spare-part.service.ts`
- `apps/farm-service/src/maintenance/resolvers/spare-part.resolver.ts`
- `apps/farm-service/src/maintenance/dto/spare-part.dto.ts`
- `apps/farm-service/src/storage/entities/storage-inventory.entity.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`
- `apps/farm-service/src/database/migrations/`

**Expected closer:**

farm-expert WRITER mode; cross-domain — flag to database-reviewer because it widens the
StorageItemType enum

**Verifier note:**

Verbatim accurate: spare-part.service.ts:262 comment "in a real implementation, this would be stored
in a separate table", :263-278 builds the `movement` object which is never read again, :283
returns `this.sparePartRepository.save(sparePart)` only; the mutations at :241/:250/:254 change
durable stock, and grep confirms no `spare_part_movements` table or SparePartMovement entity exists
anywhere in the service. Path is live (maintenance/resolvers/spare-part.resolver.ts:317,
permission-matrix.ts:165, web hook useMaintenance.ts:1679). Downgraded because the impact is an
audit-history gap only, not a balance/roll-up inconsistency: sparePart.quantity is the single owner
of spare-part stock (no second projection to drift against), the 'out' branch is guarded against
negative stock, and spare parts carry none of the lot-traceability regulation (EU 178/2002) that
makes the feed/chemical ledger load-bearing. The "shadowing the real storage entity" framing is also
overstated — it is a separate interface in a separate module with no import collision. MEDIUM.

### DB-FARMOPS-MEDIUM-007

**Title:** `storage_inventory.received_date` has no DB default (contrary to its own doc comment) and
two write paths leave it NULL, breaking FEFO determinism and as-of scoping

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-007` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:165
  \- `"received_date" TIMESTAMP WITH TIME ZONE,` — nullable, no DEFAULT, and no later tracked
  migration adds one
- apps/farm-service/src/storage/entities/storage-inventory.entity.ts:69 \- the doc comment claims
  'Defaults to NOW() at the database level so rows that predate this migration still sort stably' —
  factually false against the DDL above
- apps/farm-service/src/storage/handlers/transfer-stock.handler.ts:147
  \-
  with
  no receivedDate

  ```text
  destInventory = inventoryRepo.create({ ... expiryDate: sourceInventory.expiryDate, createdBy, updatedBy })
  ```

- apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:129
  \- `inventoryRepo.create({ ... lotNumber: item.lotNumber, createdBy, updatedBy })` with no
  receivedDate
- apps/farm-service/src/storage/services/stock-movement.service.ts:428
  \- `.andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf })` — NULL always
  passes, so a backdated feeding can deduct from a lot transferred in after the feeding date; line
  650 has the same predicate and 444-446 orders receivedDate NULLS LAST

**Rule violated:**

layer-1-typeorm 'declare explicit types / blue-green `nullable->backfill->NOT` NULL'; the FEFO
compliance guarantees documented at stock-movement.service.ts:398-406 (EU 178/2002 evidence trail)

**Proposed fix direction:**

Make the invariant structural rather than relying on every writer to remember:
give `received_date` a NOT NULL constraint with a now() default via the blue-green three-step
(nullable `->` backfill from `created_at` `->` SET NOT NULL), which simultaneously fixes the two
bypass writers and makes the entity comment true. Longer term, route transfer and count-adjustment
inventory creation through StockMovementService.increaseInventory (which already stamps it at line
715\) so there is exactly one row-construction site.

**Affected surface (ripple set):**

- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/src/storage/entities/storage-inventory.entity.ts`
- `apps/farm-service/src/storage/handlers/transfer-stock.handler.ts`
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`

**Expected closer:**

database-reviewer for the migration; farm-expert for the handler consolidation

**Verifier note:**

Fully confirmed, every cited line reads as claimed. Baseline.ts:165
creates `"received_date" TIMESTAMP WITH TIME ZONE` with no DEFAULT and no NOT NULL, and a grep
of `received_date/receivedDate` across apps/farm-service found no later ALTER — the only other
migration touching it is 1806100000000-BackfillFeedInventoryToStorageLedger.ts:126 which COALESCEs
to now() for its own inserted rows. storage-inventory.entity.ts:61-73 does claim 'Defaults to NOW()
at the database level', which is false against that DDL. transfer-stock.handler.ts:147-156 builds
the destination row with
tenantId/locationId/itemType/itemId/quantity/unit/lotNumber/expiryDate/createdBy/updatedBy and no
receivedDate; approve-inventory-count.handler.ts:129-138 does the same. Only
StockMovementService.increaseInventory (stock-movement.service.ts:715) stamps it. Consequence is
real: stock-movement.service.ts:428 and :648
use `(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)`, so NULL rows always pass the as-of
gate — a backdated feeding can deduct from a lot transferred in after the feeding date — and
:445/:650 order receivedDate NULLS LAST, so those rows lose the FEFO tiebreak. Transfers and count
approvals are routine operations, so this is hit in normal use. MEDIUM stands.

### DB-FARMOPS-MEDIUM-008

**Title:** Un-lotted `storage_inventory` rows are not uniquely addressable —
nullable `lot_number` in the unique index plus an undefined find predicate

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-008` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:169
  \-
  — `lot_number` is nullable, and in Postgres NULL never equals NULL, so the index does not prevent
  multiple un-lotted rows for the same item+location

  ```text
  CREATE UNIQUE INDEX ... ON "farm"."storage_inventory" ("tenant_id", "storage_location_id", "item_type", "item_id", "lot_number")
  ```

- apps/farm-service/src/storage/services/stock-movement.service.ts:684
  \- —
  an undefined property is dropped from a TypeORM where clause rather than matched as IS NULL

  ```text
  let inventory = await repo.findOne({ where: { ..., lotNumber: lotNumber ?? undefined } });
  ```

- apps/farm-service/src/storage/handlers/transfer-stock.handler.ts:132 \- the
  same `lotNumber: input.lotNumber ?? undefined` shape on the destination lookup, and 99-108 on the
  locked source lookup
- apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:110
  \- `lotNumber: item.lotNumber ?? undefined` on the row the count writes back to
- `apps/farm-service/src/storage/**tests**/stock-movement.service.spec.ts:119` \- every inventory
  fixture carries `lotNumber: 'LOT-A'`; the un-lotted branch is untested

**Rule violated:**

layer-2-defect-catalog Correctness ('check-then-insert TOCTOU — use a unique constraint'); EU
178/2002 lot traceability contract documented on stock-movement.entity.ts:76-88

**Proposed fix direction:**

Remove the ambiguity at the schema level: either make `lot_number` NOT NULL with a sentinel for
un-lotted stock, or replace the index with a COALESCE-based expression unique index so NULL lots
collide as intended. Then express the lookup with an explicit IsNull() rather than an undefined
property, so 'no lot' is a stated predicate the type system can see instead of a silently dropped
clause.

**Affected surface (ripple set):**

- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/src/storage/entities/storage-inventory.entity.ts`
- `apps/farm-service/src/storage/services/stock-movement.service.ts`
- `apps/farm-service/src/storage/handlers/transfer-stock.handler.ts`
- `apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts`
- `apps/farm-service/src/storage/**tests**/stock-movement.service.spec.ts`

**Expected closer:**

database-reviewer for the index change; farm-expert for the predicate

**Verifier note:**

Confirmed, including the mechanism the claim depends on. Baseline.ts:169 creates the unique index
on (`tenant_id`, `storage_location_id`, `item_type`, `item_id`, `lot_number`) and
storage-inventory.entity.ts:55 declares `lot_number` nullable, so NULL != NULL leaves un-lotted
duplicates unconstrained. stock-movement.service.ts:684-690, transfer-stock.handler.ts:105 and :138,
and approve-inventory-count.handler.ts:110 all use `lotNumber: X ?? undefined`. I verified the
TypeORM behavior rather than assuming it: `node_modules/typeorm` 0.3.31,
SelectQueryBuilder.js:2496-2504 — an undefined where value
takes `invalidWhereValuesBehavior.undefined`, default 'ignore', and `continue`s (drops the
predicate); a grep shows the repo never sets invalidWhereValuesBehavior, so the default applies.
lotNumber is optional on every input DTO (record-stock-movement.input.ts:43,
transfer-stock.input.ts:33, receive-delivery.input.ts:19) and recordMovement
passes `input.lotNumber` straight through (stock-movement.service.ts:254-257), so the un-lotted
branch is reachable. Effect is worse than 'not uniquely addressable': an un-lotted inbound movement
matches an arbitrary EXISTING row for that item+location — possibly a lotted one — adds quantity to
it and, at line 697, overwrites its expiryDate, i.e. untracked stock silently gets attributed to a
real lot number. The test fixture point holds too (stock-movement.service.spec.ts:119/232 always set
lotNumber: 'LOT-A'). I kept MEDIUM rather than raising it because triggering the traceability
corruption requires mixed lotted/un-lotted stock of the same item at the same location.

### DB-FARMOPS-MEDIUM-012

**Title:** Farm demo seed uses an ON CONFLICT target that no longer matches the live unique index,
aborting tenant seeding behind a swallowed catch

**Severity:** MEDIUM
**Layer:** 1
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-012` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/database/services/farm-seed.service.ts:965
  \- `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`
- apps/farm-service/src/database/migrations/1800600000000-ExtendFarmStockReadModelFanout.ts:466 \-
  the single-column index is dropped and
  replaced:
  (same
  replacement at 1800400000000-CreateFarmStockReadModel.ts:213)

  ```text
  DROP INDEX IF EXISTS "IDX_93018beb62439a265dcb715936"; ... CREATE UNIQUE INDEX ... idx_stock_movements_tenant_idempotency ON stock_movements ("tenant_id", "idempotency_key")
  ```

- apps/farm-service/src/storage/entities/stock-movement.entity.ts:35 \- the entity declares the
  composite
  form:

  ```text
  @Index('idx_stock_movements_tenant_idempotency', ['tenantId','idempotencyKey'], { unique: true, where: ... })
  ```

- apps/farm-service/src/database/migrations/1806100000000-BackfillFeedInventoryToStorageLedger.ts:118
  \- the migration written for the same table correctly
  uses `ON CONFLICT (tenant_id, idempotency_key)`, confirming the seed is the outlier
- apps/farm-service/src/database/services/farm-seed.service.ts:110
  \- `this.logger.error('Error during farm seed:', error)` swallows the resulting failure, so
  dev/staging tenants silently lose every seed step after feeds

**Rule violated:**

layer-2-defect-catalog Correctness ('enum/string mismatch — a literal that no longer matches its
source') \+ 'empty / swallowing catch'

**Proposed fix direction:**

Correct the conflict target to the composite index, then remove the class: the seed hand-writes raw
SQL against tables that migrations reshape independently. Drive seed inserts through the same entity
metadata the migrations are generated from (or at minimum assert the seed's conflict targets against
the entity index metadata in a unit test) so an index reshape breaks CI instead of dev onboarding.
The swallowing catch should re-throw in non-production so a broken seed is loud.

**Affected surface (ripple set):**

- `apps/farm-service/src/database/services/farm-seed.service.ts`
- `apps/farm-service/src/storage/entities/stock-movement.entity.ts`
- `apps/farm-service/src/database/**tests**/`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Confirmed, and empirically proven. farm-seed.service.ts:964
uses `ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`, but the
single-column unique index is gone: Baseline.ts:180
created `IDX_93018beb62439a265dcb715936` on (`idempotency_key`), and both
1800400000000-CreateFarmStockReadModel.ts:212-218 and
1800600000000-ExtendFarmStockReadModelFanout.ts:465-470 DROP it (both the hash name
and `IDX_stock_movements_idempotency_key`) and CREATE UNIQUE
INDEX
`idx_stock_movements_tenant_idempotency`
ON `stock_movements` (`tenant_id`, `idempotency_key`) WHERE `idempotency_key` IS NOT NULL — matching
stock-movement.entity.ts:35. Both migrations are registered in database/migrations/manifest.ts, so
they execute. I started a throwaway Postgres 16 and reproduced it exactly: with only the composite
partial unique index present, the seed's INSERT fails
with
(42P10) —
the inference list is a strict subset of the index key columns, so no arbiter is found.
1806100000000-BackfillFeedInventoryToStorageLedger.ts:118 uses the correct composite target,
confirming the seed is the outlier. Two corrections that do not change the verdict: (1) the
consequence is worse-shaped than described — seedFarmData wraps every step in one transaction and
the catch at line 258-260 rolls the WHOLE thing back and rethrows, so tenant, site, department,
tanks, species and feeds are all lost, not just 'steps after feeds' (no partial/corrupt state, but
no demo data at all); (2) it is not fully silent — line 260 and line 110 both log at ERROR level
with the error object, though the process still boots green. Reachability is narrower than implied:
docker-compose.yml:324, docker-compose.dev.yml:286, docker-compose.watch.yml:156 and
test/e2e-env.ts:27 all set `FARM_SEED_ENABLED=false`, so this only fires on a
bare `npm run dev:backend` / `nx serve farm-service` host run — which is the documented local dev
workflow. Dev-only, proven-broken SQL: MEDIUM stands.

```text
ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification
```

### LOW

### DB-FARMOPS-MEDIUM-006

**Title:** `feed_inventory` is a fully orphaned base table still registered as a TypeORM entity and
cloned into every tenant schema

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 3
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-006` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/storage/services/stock-movement.service.ts:33 \- 'Phase 2 (stock SSoT)
  completed the read re-point: the legacy `feed_inventory` writers and the GetFeedInventory read
  path are GONE ... The frozen `feed_inventory` table is dropped in the retirement phase.'
- apps/farm-service/src/feeding/feeding.module.ts:89 \- `FeedInventory,` still registered in
  TypeOrmModule.forFeature, so the drift validator keeps requiring the table in every tenant schema
- apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:370 \- the table and
  its `feed_inventory_status_enum` are created by the baseline and no tracked migration drops them
  (manifest.ts lists 77 migrations, none named for the drop)
- apps/farm-service/src/feeding/entities/feed-inventory.entity.ts:83 \- the class still
  carries `@ObjectType()` plus ~25 `@Field` decorators and two `registerEnumType` calls for a type
  no resolver returns
- apps/farm-service/src/database/services/farm-seed.service.ts:902 \- 'o tablo artik donduruldu
  (okuyucu/yazici kalmadi, Faz 8'de drop)' — the seed already moved off it

**Rule violated:**

db-audit-methodology table-level verdict ORPHAN-TABLE; domain invariant 'Feed-stock single ledger'
(one physical owner per stock quantity)

**Proposed fix direction:**

Complete the retirement in the same release rather than leaving a frozen dual-ledger shape: drop the
entity registration and the GraphQL decorations first (so nothing can re-acquire a reference), then
land the DROP TABLE \+ DROP TYPE migration with the pre-migration `pg_dump` artifact the
destructive-migration rule requires. Leaving it registered means every new tenant provisioned from
now on materialises a table that can never be written or read, and the schema-drift validator will
defend it forever.

**Affected surface (ripple set):**

- `apps/farm-service/src/feeding/entities/feed-inventory.entity.ts`
- `apps/farm-service/src/feeding/feeding.module.ts`
- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/src/database/migrations/manifest.ts`
- `libs/backend-common/src/database/schema-manager.service.ts`

**Expected closer:**

database-reviewer (DB-state owner) with farm-expert; destructive migration needs the
pre-migration-restore-test gate

**Verifier note:**

Evidence checks out but the impact is smaller than MEDIUM. Confirmed:
apps/farm-service/src/feeding/feeding.module.ts:28/89 still imports and registers `FeedInventory` in
TypeOrmModule.forFeature;
apps/farm-service/src/database/migrations/1800000000000-Baseline.ts:370-371
creates `farm.feed_inventory_status_enum` \+ `farm.feed_inventory` and a grep of all non-archived
migrations found no DROP TABLE for it;
libs/backend-common/src/database/schema-manager.service.ts:451 lists `feed_inventory` in the farm
per-tenant `tables` array, so it is indeed cloned into every tenant schema;
apps/farm-service/src/feeding/entities/feed-inventory.entity.ts:83-89 still carries
@ObjectType/@Field plus two registerEnumType calls; farm-seed.service.ts:902-907 confirms the seed
moved to the storage ledger. A repo-wide grep found zero readers/writers (only the entity file, the
module registration, the barrel export at entities/index.ts:8, the backfill migration, and
comments), so it is a genuine orphan. What lowers severity: there is no dual-ledger correctness risk
left (no writers at all — the 'Feed-stock single ledger' invariant is not actually violated), no
GraphQL enum-name collision (`InventoryStatus`/`InventoryMovementType` are registered only here),
and keeping the frozen table one release past the read re-point is standard blue-green rollback
practice, explicitly documented at stock-movement.service.ts:33-36 and farm-seed.service.ts:903 as
Phase-8 work. Net effect is dead DDL \+ dead code — cleanup debt nobody hits at runtime. LOW.

### DB-FARMOPS-MEDIUM-009

**Title:** Legacy feeding-program write surface stays open post-cutover; the 'single producer v2'
invariant is enforced only on cron jobs

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-009` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feeding/constants/legacy-engine-gate.ts:24
  \- `return process.env['FEEDING_LEGACY_ENGINE_ENABLED'] === 'true';` — grep shows the gate is
  consulted only in feeding-cron.service.ts (317, 649) and feeding-scheduler.service.ts (775, 838,
  912, 984, 1060)
- apps/farm-service/src/database/migrations/1806500000000-FeedingCutoverActivateAssignments.ts:81 \-
  the cutover forces every live legacy program to 'completed', establishing v2 as sole producer
- apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts:573
  \- `async createFeedingProgram(` is un-gated, as are `activateFeedingProgram` (line 783)
  and `generateDailyPlan` (line 1009), so an operator can re-create and re-activate a legacy program
  and hand-generate `daily_feeding_executions` after cutover
- apps/farm-service/src/feeding/services/feeding-ledger.service.ts:7 \- all three producers write
  the SAME `feeding_records` ledger that FCR and the finance FEED derived source read, so a
  resurrected legacy program double-counts feed

**Rule violated:**

Domain invariant 'Protocol drives feed rate' (one rate SSoT keyed by the batch protocol);
layer-2-patterns 'one physical owner per datum'

**Proposed fix direction:**

Apply the K-5 gate at the write boundary, not only at the schedulers: the legacy
create/activate/generate mutations must be unreachable while the gate is off, so the migration's
'single producer v2' state cannot be undone through the API. Highest tier is deletion — the drain
window is bounded and Phase 8 already plans removal; until then a gate check on the mutation path
plus an invariant spec asserting no un-gated legacy producer mutation exists makes the wrong
behaviour detectable at build time.

**Affected surface (ripple set):**

- `apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts`
- `apps/farm-service/src/feeding/constants/legacy-engine-gate.ts`
- `apps/farm-service/src/feeding/services/daily-feeding-execution.service.ts`
- `tests/invariants/feeding-legacy-cutover-gate.spec.ts`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Facts hold, severity is inflated. legacy-engine-gate.ts:24 is as quoted, and grep
for `legacyFeedingEngineEnabled` confirms call sites only in feeding-cron.service.ts:317,649 and
scheduler/feeding-scheduler.service.ts:775,838,912,984,1060;
tests/invariants/feeding-legacy-cutover-gate.spec.ts pins exactly those seven jobs and nothing on
the write surface. 1806500000000-FeedingCutoverActivateAssignments.ts:81-90 does force every
non-deleted draft/active/paused program to 'completed'. feeding-program.resolver.ts:573
createFeedingProgram, :783 activateFeedingProgram and :1009 generateDailyPlan carry
only `@Roles(TENANT_ADMIN`, `MODULE_MANAGER`) — no gate check. feeding-ledger.service.ts:1-8
confirms all three producers (v2 meal engine, manual handler, legacy execution) write the
same `feeding_records` ledger. So the gap is real and is not a documented decision: the gate's own
doc block enumerates the deliberately-ungated drain-window items (applyDailyGrowthRollup,
cleanupOldExecutions, recordDailyFeeding, weeklyFeedForecast) and these mutations are not among
them. What shrinks it: a grep of web/ found no caller for createFeedingProgram,
activateFeedingProgram or generateDailyPlan outside web/shared-ui/src/generated/graphql-types.ts, so
there is no UI path; the scheduled legacy producers stay gated, so resurrection requires a tenant
admin deliberately driving three raw GraphQL mutations, and the double-count then still needs an
operator to record the same physical feeding twice. Narrowly scoped defense-in-depth gap → LOW.

### DB-FARMOPS-MEDIUM-010

**Title:** feeds.procurementLeadTimeDays has no write path anywhere — the forecast 'warning'
coverage band collapses to a hardcoded default for every tenant

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-010` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/feed/entities/feed.entity.ts:243
  \- `procurementLeadTimeDays?: number;` added by migration
  1806700000000-FeedingForecastFoundation.ts:55
- apps/farm-service/src/feeding-protocol/services/protocol-feed-forecast.service.ts:275
  \- and
  325 `leadTimeSource: feed?.procurementLeadTimeDays != null ? 'feed' : 'default'` — the 'feed'
  branch is unreachable

  ```text
  const leadTime = feed?.procurementLeadTimeDays ?? DEFAULT_PROCUREMENT_LEAD_TIME_DAYS;
  ```

- apps/farm-service/src/storage/handlers/get-warehouse-summary.handler.ts:128
  \- `: feed.daysOfCover <= feed.procurementLeadTimeDays ? 'warning'` — the entire warning band is
  computed from the constant 7
- apps/farm-service/src/feed/dto/create-feed.input.ts \- repo-wide grep
  for `procurementLeadTimeDays` returns zero hits in any create/update DTO, resolver, or frontend
  form; the only web hit is a read-only selection at
  web/modules/farm-module/src/graphql/feedingProtocolV2.operations.ts:316

**Rule violated:**

db-audit-methodology column class MIGRATION/NONE writer with GRAPHQL read — a durable column with no
product counterpart

**Proposed fix direction:**

Either give the column a write path (create/update DTO field plus the FeedsTab control, which makes
the documented per-feed lead time real) or delete the column and the dead 'feed' branch and name the
7-day constant as the policy. Shipping a read-only knob that the forecast pretends to honour is the
worst of the three states. Whichever direction is chosen, the parity invariant proposed in
DB-FARMOPS-HIGH-001 (every detector-predicate column needs a writer) catches the next occurrence.

**Affected surface (ripple set):**

- `apps/farm-service/src/feed/entities/feed.entity.ts`
- `apps/farm-service/src/feed/dto/create-feed.input.ts`
- `apps/farm-service/src/feed/handlers/create-feed.handler.ts`

  ```text
  apps/farm-service/src/feeding-protocol/services/protocol-feed-forecast.service.ts
  ```

- `apps/farm-service/src/storage/handlers/get-warehouse-summary.handler.ts`
- `web/modules/farm-module/src/pages/setup/tabs/FeedsTab.tsx`

**Expected closer:**

farm-expert WRITER mode

**Verifier note:**

Every cited fact
holds.
declares `@Column({type:'int', nullable:true}) procurementLeadTimeDays?: number` added by
1806700000000-FeedingForecastFoundation.ts:55. A repo-wide grep
for `procurementLeadTimeDays/procurement_lead_time_days` returns NO writer:
apps/farm-service/src/feed/dto/create-feed.input.ts and update-feed.input.ts contain zero
hits (`grep -rn 'leadTime' apps/farm-service/src/feed/` returns nothing), the seed service never
sets it, and no raw SQL UPDATE touches it. So protocol-feed-forecast.service.ts:275 always
takes branch at
line 325 is exercised only by unit tests (feed-forecast.slice.spec.ts:30,
protocol-feed-forecast.service.spec.ts:112). get-warehouse-summary.handler.ts:128 reads the snapshot
copy, so the entire 'warning' band — and
alert-engine/src/alert/services/feed-coverage-alert.service.ts:40 WARNING severity — is a fixed 7
days for every tenant. Downgraded to LOW rather than MEDIUM: nothing computes a wrong value (the
7-day default is the documented policy at feed.entity.ts:237-241 and is applied uniformly), and the
field is not even rendered — web/modules/farm-module only types it (useProtocolFeeding.ts:655) and
selects it (feedingProtocolV2.operations.ts:316); no component displays it, so no operator sees a
knob that lies. Real defect class (durable column \+ dead branch with no writer), but the impact is
dead-column/dead-branch debt, not an operator-facing failure.

```text
/home/user/aquaculture_platform/apps/farm-service/src/feed/entities/feed.entity.ts:242-243
```

```text
DEFAULT_PROCUREMENT_LEAD_TIME_DAYS` = 7 (line 63) and the `leadTimeSource: 'feed'
```

### DB-FARMOPS-MEDIUM-011

**Title:** `purchase_orders` carries a free-text supplier name with no supplierId FK, and PO spend
has no finance representation at all

**Severity:** LOW (filed as MEDIUM, downgraded by adversarial verification)
**Layer:** 2
**State:** OPEN
**Raised as:** `DB-FARMOPS-MEDIUM-011` by `db-audit-farm-operations` in
cycle `2026-08-16-farm-mobile-agent-audit`
**Verification:** CONFIRMED by an independent refute-by-default verifier

**Evidence:**

- apps/farm-service/src/storage/entities/purchase-order.entity.ts:60
  \- —
  there is no supplierId column on the entity

  ```text
  @Column({ type: 'varchar', length: 255, name: 'supplier_name' }) supplierName!: string;
  ```

- apps/farm-service/src/storage/handlers/create-purchase-order.handler.ts:72
  \- `supplierName: input.supplierName,` is the only supplier linkage written; grep
  for `supplierId` across apps/farm-service/src/storage returns zero hits
- apps/farm-service/src/supplier/entities/supplier.entity.ts:82 \- a full `suppliers` master exists
  with `supplier_types` and `supplier_sites` approval (set-supplier-approved-sites.handler.ts), none
  of it reachable from a purchase order
- apps/farm-service/src/finance/services/derived-cost-sources.ts:76
  \-
  `DERIVED_COST_SOURCES`
  lists
  `feeding_records`,
  is
  absent, so approved procurement spend never appears in the finance ledger

  ```text
  batches_v2`, `work_orders`, `health_events` and `harvest_records`; `purchase_orders.total_amount
  ```

- apps/farm-service/src/storage/entities/purchase-order.entity.ts:78 \- `total_amount` is persisted
  and read-exposed but has no finance consumer

**Rule violated:**

db-audit-methodology table-level verdict DUPLICATE-STRUCTURE (supplier identity modelled twice with
no declared owner); ADR-011 relational discipline

**Proposed fix direction:**

Give `purchase_orders` a real `supplierId` FK to the suppliers master (keeping the denormalised name
as a point-in-time audit snapshot, the same pattern approvedByName already uses at line 92), so
supplier spend, approved-site checks and vendor performance become queryable instead of
string-matched. Separately, decide explicitly whether procurement is a cash-basis finance source:
either add a PURCHASE derived-cost source or document in derived-cost-sources.ts that feed cost is
deliberately consumption-basis and chemical/consumable purchases are out of the P&L by design.

**Affected surface (ripple set):**

- `apps/farm-service/src/storage/entities/purchase-order.entity.ts`
- `apps/farm-service/src/storage/dto/create-purchase-order.input.ts`
- `apps/farm-service/src/storage/handlers/create-purchase-order.handler.ts`
- `apps/farm-service/src/database/migrations/`
- `apps/farm-service/src/finance/services/derived-cost-sources.ts`

  ```text
  web/modules/farm-module/src/pages/storage/components/CreatePurchaseOrderModal.tsx
  ```

**Expected closer:**

farm-expert WRITER mode with database-reviewer on the FK migration

**Verifier note:**

Facts confirmed, framing inflated. purchase-order.entity.ts:60
is and the
entity has no supplierId column; `grep -rn supplierId apps/farm-service/src/storage/` returns zero
hits, and create-purchase-order.handler.ts:72 writes only `supplierName: input.supplierName` (plus
supplierContact). A full suppliers master does exist (supplier/entities/supplier.entity.ts, with
supplier-site approval in set-supplier-approved-sites.handler.ts, audited \+ outbox-evented) and is
unreachable from a PO. derived-cost-sources.ts declares exactly six sources (FEED, FINGERLINGS,
MAINTENANCE, `HEALTH_TREATMENT`, `HARVEST_REVENUE`, `HARVEST_COST`) at lines 78/95/112/134/151/168
— `purchase_orders.total_amount` (entity line ~78) is indeed absent. Downgraded to LOW: (a) the
'DUPLICATE-STRUCTURE / supplier identity modelled twice' label does not hold — a denormalised name
string is not a second identity model, and no code string-matches supplierName against suppliers
today, so nothing currently computes a wrong result; (b) the finance half is largely a design
question the file header already answers in principle (derived-cost-sources.ts:1-33 states money is
derived at query time from the domain rows where it occurs, i.e. consumption-basis), and the fix
direction the claim itself proposes for it is 'decide and document' — Tier-4 work, not a defect.
What remains real is modelling debt: the approved-supplier control has no procurement enforcement
point and supplier spend is not queryable.

```text
@Column({type:'varchar', length:255, name:'supplier_name'}) supplierName!: string
```

## Refuted by adversarial verification

These did **not** survive independent re-checking. They are recorded so the same
claim is not re-raised next cycle.

### ~~DB-FARMOPS-HIGH-001~~

**Title:** feeds.minStock / chemicals.minStock have no product write path — the entire low-stock \+
reorder alert chain is unreachable

**Raised as:** HIGH · **Result:** REFUTED

Headline ("no product write path — the entire low-stock \+ reorder alert chain is unreachable") does
not hold. (a) minStock IS persisted on create:
apps/farm-service/src/feed/handlers/create-feed.handler.ts:136 and
chemical/handlers/create-chemical.handler.ts:86 both write `minStock: input.minStock ?? 0`, and both
DTOs expose it (create-feed.input.ts, create-chemical.input.ts:231). (b) It is also writable on
update: UpdateFeedInput = PartialType(OmitType(CreateFeedInput,...)) so it inherits minStock, and
UpdateFeedHandler (apps/farm-service/src/feed/handlers/update-feed.handler.ts:63-68)
does `Object.assign(feed, {...updateFields})` — any GraphQL client, and the seed path
(database/services/farm-seed.service.ts:878), set it. (c) The claim misreads the sink:
stock-movement.service.ts:308-309 emits LowStockDetected with severity `out_of_stock` whenever
currentTotal `<=` 0, independent of minStock — only the early-warning `low_stock` tier at :310 is
gated. So the alert chain is reachable, not dead. What actually survives is narrower and UI-only:
FeedsTab.tsx and ChemicalsTab.tsx expose no minStock control (ConsumablesTab.tsx:603 and
SparePartsPage.tsx:547 do), so operators using only those two forms leave the threshold at 0 and
never get the early-warning tier or the get-warehouse-summary/get-storage-overview low-stock lists.
That is a missing form field, i.e. MEDIUM, not a dead backend chain.

## Inventory — what exists / what is missing

| Status          | Area                                                                                     | Note                                                                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MISSING**     | Farm CREATE VIEW migrations                                                              | The shared methodology expects three live farm views. Grep for CREATE [OR REPLACE] [MATERIALIZED] VIEW across the 77 tracked migrations plus the baseline returns zero matches, so the methodology note is stale for the current chain — no VIEW-STALE risk exists in this partition.                                        |
| **MISSING**     | Low-stock / reorder alert chain                                                          | All machinery exists (LowStockDetected outbox enqueue, warehouse KPI, forecast coverage bands) but is gated on minStock `>` 0, and minStock has no editor for feeds or chemicals in any UI. Effectively dead for those two item types.                                                                                       |
| **MISSING**     | Purchase order `->` finance ledger                                                       | `purchase_orders.total_amount` is persisted and exposed but is not a `DERIVED_COST_SOURCE`, so procurement spend never appears in the finance tab. Feed cost is consumption-basis from `feeding_records`; chemical/consumable purchases have no representation at all.                                                       |
| **MISSING**     | Purchase order `->` supplier master linkage                                              | `purchase_orders` stores `supplier_name` free text only; the `suppliers/supplier_types/supplier_sites` master has no relationship to any spend document. Supplier spend and approved-vendor enforcement are not queryable.                                                                                                   |
| **PARTIAL**     | Feed-rate SSoT                                                                           | Two rate services coexist by design during the drain window: ProtocolRateService (v2 bands) is the documented primary resolution and FeedingProtocolRateService (v1 jsonb) remains as fallback. Controlled transitional duplication, but both are live and Phase 8 retirement has not landed.                                |
| **PARTIAL**     | Feeding deduction for storage-untracked feeds                                            | When a feed has zero `storage_inventory` presence the deduction is skipped with a warn. That escape hatch existed for `feed_inventory-only` tenants; with `feed_inventory` frozen it now means feed can be consumed with no movement row and no quantity decrement.                                                          |
| **PARTIAL**     | Finance site-scoped reporting                                                            | Every `DERIVED_COST_SOURCE` has siteIdExpr: null, so a site-filtered ledger deliberately shows manual entries only; getSummary and getBatchTotals accept no site filter at all. Documented as FARM-MEDIUM-162 rather than silently mixing tenant-wide costs — correct behaviour, incomplete capability.                      |
| **PARTIAL**     | Inventory count (BAP/ASC physical verification)                                          | Full lifecycle with SOC2 CC3.4 separation-of-duties, frozen expected-quantity snapshot, per-item and aggregate variance, and an ADJUSTMENT movement row. Missing the item roll-up recompute and the low-stock signal on approval; HEALTHCARE items fall through resolveItemName and display as a raw uuid prefix.            |
| **PARTIAL**     | Legacy `feeding_programs` / `feeding_program_tanks` / `daily_feeding_executions`         | Cutover completed all programs and gated the cron producers, but the create/activate/generate mutations remain callable, so dual planning is re-achievable through the API. No frontend consumer remains for the legacy program mutations.                                                                                   |
| **PARTIAL**     | Legacy `feeding_protocols` (v1) GraphQL surface                                          | Full CRUD is exposed (feedingProtocol, feedingProtocols, feedingProtocolsBySpecies, defaultFeedingProtocol, create/update/delete/setDefault) with zero frontend consumers — repo-wide grep finds no farm-module call site. Backend-internal reads (seeder, dataloader fallback) keep the table alive.                        |
| **PARTIAL**     | Spare-part stock (maintenance domain)                                                    | Quantities and status are maintained on the SparePart row, but the movement record is an in-memory object explicitly documented as unpersisted. A fifth stock ledger with no audit trail, outside `storage_inventory/stock_movements`.                                                                                       |
| **PARTIAL**     | Stock roll-up columns (feeds/chemicals/consumables .quantity, .status)                   | Maintained correctly by the movement sink, but writable directly at item-master create with no ledger row, and not recomputed after inventory-count approval. Two documented divergence paths from the ledger.                                                                                                               |
| **PARTIAL**     | Stock transfer between locations                                                         | Idempotent, site-authorized on both legs, pessimistic-locked, and captures lot+expiry on the movement. Bypasses the movement sink, so the destination row is created without receivedDate and lot matching uses the ambiguous undefined predicate.                                                                           |
| **PARTIAL**     | `chemical_sites` / `supplier_sites` (approved-site mapping)                              | `supplier_sites` has a dedicated update path (set-supplier-approved-sites.handler.ts); `chemical_sites` mirrors the `feed_sites` shape — write-once at create, read only as a list filter, no update path.                                                                                                                   |
| **PARTIAL**     | `feed_inventory` legacy ledger                                                           | Convergence read/write re-point is complete (no writer, no reader, no resolver), but the base table, its enum type and the TypeORM entity registration all remain, so every tenant schema still materialises a dead table. Retirement migration not present in the tracked chain.                                            |
| **PARTIAL**     | `feed_sites` / `feed_type_species` (feed-to-site and feed-to-species mapping)            | Written once inside createFeed and read only as a filter join in listFeeds; UpdateFeedInput explicitly omits siteId and speciesMappings, so a feed can never be re-assigned. FeedsTab.tsx:382 reads feed.siteId, which the GraphQL response type does not expose, so the edit form's site selector is always blank.          |
| **IMPLEMENTED** | ADR-011 schema placement across the partition                                            | All 38 @Entity classes in feed/feeding/feeding-protocol/storage/farm-stock/consumable/supplier/chemical/finance omit schema:, correctly routing through `search_path` into `tenant_<uuid>`. No product table lands in public and none of these appear in farm's infrastructureTables set.                                    |
| **IMPLEMENTED** | Feed stock physical ledger (`storage_inventory` \+ `stock_movements`)                    | Converged single owner with FEFO picking, lot-mix detection, pessimistic locking, idempotency keys and an immutable movement row; feeding deduction and PO receipt both run inside the caller's transaction through one sink. This is the strongest surface in the partition.                                                |
| **IMPLEMENTED** | Feeding protocol v2 (bands, day plans, meals, assignments, forecast)                     | Five tables created and populated by a tested pure-function conversion from v1 protocols and legacy programs, with a fail-closed cutover that never activates a DRAFT protocol and skips site-less units. Resolvers, query handlers and the ProtocolBuilderTab UI all present.                                               |
| **IMPLEMENTED** | Finance ledger (manual entries \+ derived projections \+ computed rules)                 | Query-time derivation from five source-of-truth tables via a declarative registry with a CI parity spec, single UNION ALL aggregation, exact Decimal money handling, soft delete with deletedBy attribution, and full FE mutation/query parity in finance.operations.ts.                                                     |
| **IMPLEMENTED** | Lot traceability (EU 178/2002 Art. 18)                                                   | `stock_movements` carries `lot_number` and `expiry_date` on every movement type with a composite (tenant, lot) index; `storage_lot_mixes` records mixes at receipt and traceLot reads both. Weakened only by the un-lotted-row ambiguity in DB-FARMOPS-MEDIUM-008.                                                           |
| **IMPLEMENTED** | Purchase order lifecycle (draft `->` submitted `->` approved `->` ordered `->` received) | Maker-checker separation with approvedBy/approvedByName/approvedAt, partial receipt with deterministic idempotency keys, and outbox StockMovementRecorded emission inside the receipt transaction.                                                                                                                           |
| **IMPLEMENTED** | Storage frontend (web/modules/farm-module/src/pages/storage)                             | 18 components covering overview, per-type stock tabs, movements, transfers, purchase orders, receive delivery, inventory counts and storage locations; the stock tabs read `storage_inventory` (the converged ledger), not the item-master roll-up.                                                                          |
| **IMPLEMENTED** | `farm_stock_batch_snapshots` / `farm_stock_container_snapshots`                          | Fish-stock (not feed-stock) read models, federated with @key(fields: "id"), projected by farm-stock-projection.listener and fanned out by dedicated migrations; unique keys per (tenant, container[, batch]) prevent duplicate projections.                                                                                  |
| **IMPLEMENTED** | `feeding_records` ledger \+ FeedingLedgerService                                         | Single write path for all three producers (v2 meal engine, manual create, legacy drain), with cost computed centrally from feed.pricePerKg, currency resolved from finance settings, batch aggregates updated, storage deducted last per the canonical lock order, and the FeedingRecorded outbox event on the same manager. |

## Verdict

BLOCK

## References

- Cycle report: `docs/reviews/orchestrator/2026-08-16-farm-mobile-audit-cycle.md`
- Finding format: `.claude/shared/output-format.md`
- Agent definition: `.claude/agents/**/db-audit-farm-operations.md`
- Rule SSoT: `CLAUDE.md`
