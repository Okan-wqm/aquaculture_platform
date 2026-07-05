# Farm — New-Batch modal backdrop stacking + batch-tracking readback (2026-07-04)

Operator report (`app.suderra.com/sites/tanks`): clicking **New Batch** opened the
form *behind* the darkened backdrop, so the form was unreachable and no batch
could be entered. Follow-up ask: confirm batch tracking actually works.

## FARM-HIGH-129 — New-Batch form rendered behind its own backdrop (unusable) — RESOLVED

**Where:** `web/modules/farm-module/src/pages/production/components/BatchFormModal.tsx`

**Root cause.** `BatchFormModal` hand-rolled its own modal shell instead of using
the shared `@aquaculture/shared-ui` `Modal` primitive that every sibling modal
(MortalityModal, TransferModal, GradingModal, CullModal, cleaner-fish
CreateBatchModal, …) uses. The hand-rolled shell had:

- overlay: `fixed inset-0 … bg-gray-500/75` → a **positioned** box (position: fixed).
- panel: `inline-block … transform bg-white …` → a **non-positioned**, in-flow box
  that only forms a stacking context via `transform`, with **no** `relative`/z-index.

Per CSS paint order, a non-positioned in-flow element paints in the in-flow phase
while a `position: fixed` sibling paints later in the positioned phase — so the
overlay was drawn **on top of** the panel. The dark backdrop covered the form.
The panel needed to be a positioned element (`relative`) to win the paint order,
which it never was.

**Fix (tier 2 — correct-by-default).** Route the modal through the shared `Modal`
primitive, matching every sibling modal. That component `createPortal`s to
`document.body` (escaping any transformed/overflow-clipped federated ancestor
stacking context) and gives the panel `relative` (correct paint order). It also
brings focus-trap, Escape-to-close, scroll-lock and `role="dialog"`/`aria-modal`
that the hand-rolled shell lacked. Header title → `Modal` `title`; the batch-number
line, tabs, form body and action buttons moved into the Modal body; tab buttons
got `type="button"` so they can never accidentally submit the form.

**Tests.** `BatchFormModal.spec.tsx` (new) — locks the fix in: asserts the modal
renders through the shared primitive (`role="dialog"` + `aria-modal`, portaled to
body), that tabs + Create-Batch survive the shell swap, and that it renders
nothing when closed. If the hand-rolled shell is ever reintroduced the semantic
dialog role disappears and the suite fails. Full farm-module suite green (105).

## FARM-MEDIUM-133 — `useCreateBatch` does not invalidate `tanks`/`tankBatches` caches — OPEN

**Where:** `web/modules/farm-module/src/hooks/useBatches.ts` (`useCreateBatch.onSuccess`)

Creating a batch allocates fish into tanks (`initialLocations`), so it mutates
tank state. But `useCreateBatch.onSuccess` invalidates only `batches/list` and
`batches/generateNumber` — **not** `tanks` or `tankBatches`. Every tracking
mutation in the same file (mortality, cull, transfer, grading, harvest-delete)
correctly invalidates BOTH `tanks` and `tankBatches`; create is the outlier.

**Impact.** Masked on `/sites/tanks` because `TanksPage` wires
`BatchFormModal.onSuccess → refetch()` on its `useTanksList` query, so that page
refreshes. But any *other* surface showing tank/batch data (dashboards, other
tabs) will not auto-reflect a freshly created batch until an unrelated refetch or
reload. Low-severity readback/consistency gap, not a blocker for the tanks page.

**Suggested fix (tier 2, matches established pattern).** Add
`queryClient.invalidateQueries({ queryKey: createTenantInvalidationKey(tenantId, 'tanks') })`
and the same for `'tankBatches'` to `useCreateBatch.onSuccess`, so a new batch is
correct-by-default across every surface instead of relying on each page to
remember a manual `refetch()`.

## Batch-tracking readback — assessment

Wired correctly end-to-end on `/sites/tanks`:

- **Create → display:** `CreateBatch` persists the batch + tank allocations; the
  page refetches; the new allocation surfaces in the tank rows.
- **Readback:** `useTanksList` returns rich per-tank `batchMetrics` — `batchNumber`,
  `pieces`, `biomass`, `initialQuantity`, `totalMortality`, `mortalityRate`,
  `survivalRate`, `totalCull`, `fcr`, `sgr`, feeding fields — so live tracking
  numbers render per tank.
- **Tracking ops:** mortality / cull / transfer / grading mutations decrement
  `currentQuantity`, invalidate `tanks` + `tankBatches`, and the page refetches.
  Backend count-tracking was live-verified correct in the 2026-06-30 batch-lifecycle
  audit (`2026-06-30-batch-lifecycle-ssot.md`).
