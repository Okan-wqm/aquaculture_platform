# Farm — batch traceability report (Phase 6) + web list visibility & low-stock badge (Phase 7) — 2026-07-05

Closes the last two phases of the protocol/traceability initiative (operator spec
items 1, 4 and the "tarihsel veri… rapor" requirement).

## FARM-HIGH-141 — no batch lifecycle traceability report — RESOLVED (Phase 6)

**Requirement.** For any batch: where the fish lived and for how long, what was
done to them (stocking/transfer/grading/mortality/cull/harvest), how much of
which feed they ate, and the water temperature while they were in each tank —
one printable report.

**Architecture (read-only composition over existing SSoTs — no new write model).**
- New CQRS query `GetBatchTraceabilityQuery` + handler: residency intervals come
  straight from `batch_locations` ([movedAt, exitedAt) per tank — the table the
  transfer path already maintains); the event timeline is the EXISTING
  `GetBatchHistoryQuery` executed through the QueryBus (one assembler, no second
  copy of the operation-merge logic); feed eaten is aggregated in SQL from
  `feeding_records` (the same per-batch table the FCR SSoT sums) per feed and per
  residency window; water temperature is a SQL MIN/AVG/MAX over
  `water_quality_measurements` for the residency tank + window. All reads inside
  `runInTenantRead` (fail-closed tenant boundary).
- Typed GraphQL surface: `batchTraceability(id)` → `BatchTraceabilityResponse`
  (summary + residencies[] each with water/feed aggregates + feedTotals[] +
  events[] reusing `BatchHistoryEntryResponse`).
- Frontend: a **Traceability** tab on BatchDetailPage (`useBatchTraceability`
  via `useTenantQuery`) with KPI header, residency table, feed totals, event
  timeline, and a **printable report** (self-contained HTML through the shared
  `escapeHtml` — one escaping SSoT with the water-chemistry report exporter).

## FARM-HIGH-142 — web lists silently truncated (tanks 50-cap, batches 20/50-cap) + feed-stock rows had no low-stock signal — RESOLVED (Phase 7)

- **Tanks:** `useTanksList` sent NO limit (backend default 50) on the false
  belief the gateway rejects `limit` — every container past the 50th was
  invisible on web everywhere the hook is used (tanks page, 6 report tabs,
  3 report modals, analytics). The hook now pages through the whole list
  (100/page, verified gateway-supported) when no explicit pagination is passed.
- **Batches:** `useBatchList` defaulted to 20 and the production list fetched
  one page of 50 — batches past the cap were invisible on web while mobile
  paged through everything (the operator's original "webte göremiyorum"). New
  `fetchAll` option pages the whole list; the production list, growth tab,
  feeding batch selector, harvest plans and welfare modal use it.
- **Backend hardening:** `list-batches` had NO page-size ceiling (unbounded
  caller-controlled `take()` — a DoS vector; equipment already capped at 100).
  Now clamped to 200.
- **Feed-stock badge:** the server-side low-stock signal (master
  `quantity <= minStock`, already computed for the Overview tab) is now surfaced
  on the stock rows themselves: per-row LOW STOCK / OUT OF STOCK badge + a tab
  count chip, matched by `itemId` — no second threshold implementation.

## Verification
`get-batch-traceability.handler.spec` 2 (composition + aggregation rounding +
NotFound); list-batches suite green under the cap; FE: BatchTraceabilityTab spec
3 (fires `query BatchTraceability`, renders residency rows, honest "—" for
zero-measurement water) + report-export spec 3 (HTML escaping of hostile input,
sections, empty rows); farm-module 29 files / 116 tests; FE↔BE parity 4/4; tsc
0 backend + 0 frontend; invariants:fast green.
