# Farm full-integration — post-merge adversarial audit follow-up (2026-07-03)

An 8-dimension multi-agent audit (each finding double-verified by an independent
reproduce-check and intent-check) ran over the farm-integration PR and adjacent
farm domain. 36 findings survived adversarial review. This document tracks the
actionable subset; every fix commit references its ID. Contested findings that
verified as fine-as-is (TransferModal duplication, GradingModal console.error
under the farm-module eslint override) are recorded here as INFO with no code
change.

## FARM-HIGH-126 — klientReferanse regenerated per submit click defeats persist-first idempotency
All 8 report tabs built `klientReferanse: crypto.randomUUID()` fresh inside the submit handler, so a retry/double-click never collides with the `@Unique(tenantId,reportType,klientReferanse)` upsert — it inserts a NEW regulatory_reports row AND (klientReferanse is Mattilsynet's own idempotency key) submits a DUPLICATE report + duplicate legally-immediate urgent email. Fix: a stable per-report client reference held across retries until success (SSoT hook), reset on success.

## FARM-HIGH-127 — Smolt & Cleaner-Fish tabs submit a 0-indexed report month
Biomass sends `formData.month + 1` (backend reportMonth is 1–12); Smolt/Cleaner-Fish send raw `formData.month`, filing every settefisk/rensefisk report a month early with an invalid month 0 for January. Fix: a single month-normalization SSoT used by all monthly-report tabs.

## FARM-HIGH-128 — Sea-Lice / Smolt / Cleaner-Fish always submit lokalitetsnummer 0
These three REST tabs hand-roll `lokalitetsnummer: siteMapping?.lokalitetsnummer || 0` keyed on a `siteId` prop ReportsPage never passes, and have no site selector — so every submission carries an invalid locality. The varsling tabs already use the fail-closed `buildVarslingIdentity` SSoT (throws on a missing mapping). Fix: route the REST tabs through the same fail-closed identity SSoT + a shared site-locality selector; never submit a silent 0.

## FARM-MEDIUM-129 — Grading resume path keys idempotency by array index, contradicting its own resume guidance
The backend error + GradingModal tell the operator to "resubmit the remaining outputs only", but useRecordGrading keys each output's stable clientCommandId by ARRAY INDEX — trimming committed rows reuses a committed id with a new payloadHash and hard-fails with ConflictException. Fix: key the per-output envelope by a stable per-row identity minted at row creation.

## FARM-MEDIUM-130 — batch.types.ts is a drifted, largely-dead duplicate domain surface
Parallel Batch/CreateBatchInput/Record*Input/mock arrays duplicating hooks/useBatches.ts, already drifted on the primary key (equipmentId/operationDate vs tankId/observedAt) — a real footgun. Fix: delete the dead duplicates, keep only the genuinely-imported types, re-export inputs from the useBatches SSoT.

## FARM-MEDIUM-131 — WorkersAnalyticsTab renders 100% fabricated mock data behind a live nav route
A tenant sees convincing fake worker KPIs (hardcoded names/attendance/roles) with no data layer; the dateRange prop is discarded. Fix: remove the mock tab + its route until a real worker-analytics data source exists (no fake data behind live nav).

## FARM-MEDIUM-132 — FE campaign specs assert query-fired, not rendered behavior
AnalyticsPage KPI spec and the four tab-switch specs (Storage/Feeding/Tasks/Setup) assert only that a query fired with empty fixtures — broken KPI rollups or a tab that never maps its response would ship green. Fix: seed non-empty fixtures and assert rendered values.

## FARM-LOW-133 — upsert() leaves a stale Mattilsynet receipt on a resubmitted PENDING/FAILED row
The reset-to-PENDING branch clears feilmelding but not referanse; markFailed likewise. Fix: clear referanse in both.

## FARM-LOW-134 — submitWithRecord mislabels a regulator-accepted submission as FAILED on a post-submit DB error
One try wraps both submit() and markSubmitted; a persistence throw after a successful regulator call reports FAILED. Fix: narrow the catch so only submit() failures mark FAILED.

## FARM-LOW-135 — WaterQuality parseCriticalParameters guard too loose
The type guard validates only code+value but buildMessage consumes name/direction/threshold, yielding "undefined 3.1 undefined" incident text on a malformed payload. Fix: tighten the guard / default in buildMessage.

## FARM-LOW-136 — schema-manager cites the stale finding ID FARM-HIGH-112
The regulatory_reports comment cites FARM-HIGH-112 (now an unrelated reconcile finding) while every other site cites FARM-HIGH-125. Fix: correct to FARM-HIGH-125.

## FARM-LOW-137 — useRecordGrading attaches an operation-level envelope the resolver never reads
Only per-output envelopes are consumed; the top-level clientCommandId+payloadHash is a redundant hash implying dedup that does not exist. Fix: remove the op-level attach for grading.

## FARM-LOW-138 — useInvalidateRegulatoryReports exported but never used in production
Its docstring claims it is called from submit onSuccess handlers; real invalidation is invalidateAllRegulatoryQueries. Fix: remove the dead export + its test mock.

## FARM-LOW-139 — ReportSubmissionResult.reportId added but never selected/consumed by the FE
Fix: either select+use it to deep-link the submitted row, or drop the field + comment.

## FARM-LOW-140 — Per-tab stats cards count a 50-row page instead of the summary aggregate
SubmissionHistorySection derives Total/Submitted/Failed/Pending from the paginated window, under-counting past 50. Fix: feed the cards from useRegulatoryReportSummary filtered to the tab's reportType.

## FARM-LOW-141 — payloadHash implemented by two divergent algorithms for one dedup contract
useBatches uses a shallow top-level sort; aquamobil a recursive deep stableStringify. Behaviorally inert today (disjoint clientCommandIds, flat payloads) but a drift trap. Fix: one canonical stableStringify helper.

## FARM-LOW-142 — CullModal dropped the future-date guard MortalityModal has (copy-paste divergence)
The two are ~95% identical; culls can be future-dated while mortalities cannot. Fix: add the programmatic future-date guard to CullModal (and share the check).

## FARM-LOW-143 — BATCH_LIST_QUERY and BATCH_QUERY repeat the same ~40-field selection inline
Classic detail-vs-list drift source. Fix: extract a BATCH_CORE_FIELDS fragment.

## FARM-LOW-144 — WaterQuality ensureIncident is a near-verbatim copy of Mortality ensureIncident
A future dedup/lock change must be applied in two places. Fix: extract a shared ensureFarmSignalIncident helper.

## FARM-LOW-145 — lastOccurredAt jumps from event-time to processing wall-clock on the first bump
recordOccurrence() stamps wall-clock, corrupting recency/flapping analytics under consumer lag (shared by mortality + water-quality). Fix: recordOccurrence(occurredAt) takes the event timestamp.

## FARM-LOW-146 — BatchGraded is a summary event with no backend consumer and no bridge/validator
Per-output BatchTransferred events already carry stock deltas; BatchGraded is operation-level audit only. Fix: document it as intentionally summary/FE-bridge-only (matching WaterQualityMeasurementCreated) so audits do not re-derive it.

## FARM-LOW-147 — Feeding/Storage specs omit the fake-empty-on-failure guard the siblings standardized
Fix: add the routeGraphql failure-path assertion to both.

## FARM-LOW-148 — TasksPage spec derives 'today' from the real UTC clock while TodayTab buckets local
Latently flaky at the date boundary in non-UTC offsets. Fix: freeze the clock and derive fixture + page today from it.

## FARM-LOW-149 — Health/Harvest specs are render-only (no domain-derived state, filter, or interaction)
Fix: add a behavioral assertion each (HealthEvents has an untested search + severity/quarantine badge map; note the fixture uses uppercase enums that mismatch the lowercase label maps).

## FARM-LOW-150 — SubmissionHistorySection.spec hand-rolls a partial useTenantQuery mock instead of the shared harness
Fix: route it through createSharedUiMock/routeGraphql like the sibling specs.

## FARM-LOW-151 — sharedUiMock.useTenantQuery header claims parity it does not implement
Omits the real hook's token+tenantId enabled gate and session-epoch key segment. Fix: mirror the real hook faithfully or drop the false parity claim.

## FARM-LOW-152 — Biomass single-period draft pre-fill path unwired end-to-end (INFO / tracked)
BIOMASS_REPORT_QUERY + backend biomassReport query/handler exist with no caller. Contested harm; already in the dead-contract baseline. Fix: wire a pre-fill hook or delete the query + handler; do not leave a comment claiming behavior no code performs.
