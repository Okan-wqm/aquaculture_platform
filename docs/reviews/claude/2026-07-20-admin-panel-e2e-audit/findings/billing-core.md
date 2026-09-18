<!-- markdownlint-disable MD011 MD013 MD029 MD033 MD034 MD037 MD038 MD049 MD052 -->
<!-- WHY: imported verbatim FE<->BE<->DB audit evidence. The quoted TypeScript is
     what makes a finding checkable, and markdown's inline rules cannot tell it
     from markup: `Record<string, T>` and `[P]['req']` read as inline HTML and a
     reference link, `(typeof X)[number]` as a reversed link, snake_case
     fragments as emphasis, a template literal as a code span with spaces, an
     internal service URL as a bare URL, and an inline "1)" enumeration as an
     ordered list that starts at 2. Long lines are identifier-dense finding
     titles and evidence paths that cannot wrap without breaking the reference.
     Reflowing them would corrupt the record this file exists to preserve --
     the same rationale scripts/ci/markdownlint-changed.mjs states for its
     changed-line filter. Structure is enforced by the parsers instead:
     tools/gates/finding-registry.ts and tools/gates/commit-msg-validator.ts. -->

# Billing Core (Dashboard/Invoices/Payments/Reports) — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the
> verified severity where status is CONFIRMED, else the auditor's grade pending verification.

## BillingDashboardPage — `/admin/billing` — verdict: **PARTIAL**

**Chain:** GET /analytics/revenue -> AnalyticsController.getRevenueAnalytics ->
AnalyticsService.getRevenueAnalytics/getFinancialMetrics computes MRR/ARR from real
billing.subscriptions rows (pricing jsonb basePrice by billing cycle) plus a real conditional
aggregation over billing.invoices and admin.analytics_snapshots for the monthly series
(apps/admin-api-service/src/analytics/services/analytics.service.ts:476-560,1131-1200). Recent
transactions come from GET /billing/invoices (real SQL vs billing.invoices JOIN auth.tenants). Chain
resolves through nginx /api -> /api/v1 rewrite (infrastructure/nginx/droplet.conf:377-385), global
prefix api/v1 (libs/backend-common/src/bootstrap/create-service-app.ts:610), envelope interceptor +
FE unwrap verified. However 5 of 9 metric cards are hardcoded null (permanent N/A), the revenue
chart is a static placeholder with a decorative range select, and the Export Report button has no
handler.

**Endpoints exercised:** `GET /api/analytics/revenue`; `GET /api/billing/invoices?limit=5`

**DB tables:** `billing.subscriptions`, `billing.invoices`, `admin.analytics_snapshots`,
`auth.tenants`

### APA-078 [MEDIUM] Five of nine dashboard metrics are hardcoded null and render permanent N/A

- **Status:** DESIGNED (brief)
- **Symptom:** transformRevenueData sets activeSubscriptions, churnRate, outstandingInvoices, growth
  and paymentSuccessRate to null with TODO comments, so the Active Subscriptions and Churn Rate
  cards and two of three Quick Stats always show 'N/A'/'—'/'Not yet connected'. Backend data exists
  to populate them (GET /billing/subscriptions/stats returns churnRate, totalSubscriptions, mrr; GET
  /billing/invoices/stats returns pending counts) but is never called from this page.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:64-74 (nulls + TODO comments)`
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:407-428,476-494 (N/A rendering)`
  - `apps/admin-api-service/src/billing/billing.controller.ts:360-363 (existing subscriptions/stats endpoint not used)`
- **Root cause:** transformRevenueData (BillingDashboardPage.tsx:64-74) hardcodes 5 of 9 metrics to
  null with TODOs even though admin-api already serves the data and the FE api layer already wraps
  it (billingApi.getSubscriptionStats -> churnRate/totalSubscriptions, billingApi.getInvoiceStats ->
  pending counts, analyticsApi.getRevenueTrend -> growth). Only paymentSuccessRate has a genuine
  backend gap: PaymentManagementService has no stats method/endpoint.
- **Fix design:** Compose the dashboard from the real contracts and delete nullability (tier 1):
  fetchMetrics = Promise.all([analyticsApi.getRevenueAnalytics(), billingApi.getSubscriptionStats(),
  billingApi.getInvoiceStats(), analyticsApi.getRevenueTrend()]) mapping
  activeSubscriptions<-totalSubscriptions, churnRate<-stats.churnRate,
  outstandingInvoices<-invoiceStats.byStatus pending+sent+overdue+partially_paid counts,
  growth<-last-two trend points. Fill the one real gap: add PaymentManagementService.getStats()
  (succeeded/failed counts + success rate, last 30d) exposed as GET /billing/payments/stats plus
  billingApi.getPaymentStats + PaymentStats FE type. Then make every BillingMetrics field a
  non-nullable number and delete all 'N/A'/'—'/'Not yet connected' branches so a
  permanently-disconnected metric is a compile error. Verification: new
  web/modules/admin-panel/src/pages/**tests**/BillingDashboardPage.spec.tsx asserting all 9 metrics
  render from mocked APIs; extend
  apps/admin-api-service/src/billing/**tests**/billing.controller.spec.ts for payments/stats.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/BillingDashboardPage.spec.tsx`
- **Effort:** M

### APA-079 [MEDIUM] Export Report button and Revenue Trend chart are dead UI

- **Status:** DESIGNED (brief)
- **Symptom:** The 'Export Report' button has no onClick handler, so it silently does nothing. The
  Revenue Trend panel renders a hardcoded dashed placeholder box and its 12m/6m/3m select has no
  onChange — no chart data is ever fetched or drawn even though GET /analytics/revenue returns
  revenueByMonth and GET /analytics/revenue/trend exists.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:379-381 (button without handler)`
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:434-451 (placeholder chart + inert select)`
  - `apps/admin-api-service/src/analytics/controllers/analytics.controller.ts:318-343 (unused revenue trend endpoints)`
- **Root cause:** Placeholder UI shipped as final: Export Report button has no onClick
  (BillingDashboardPage.tsx:379-381), the Revenue Trend panel is a hardcoded dashed box and the
  12m/6m/3m select has no state/onChange (:434-451), while GET /analytics/revenue/trend exists,
  analyticsApi.getRevenueTrend(range) is already written, and AnalyticsDashboardPage already
  contains a working inline SVG MiniChart (duplicated-inline-chart pattern).
- **Fix design:** Extract MiniChart (polyline SVG, AnalyticsDashboardPage.tsx:251-278) into a shared
  component web/modules/admin-panel/src/components/charts/MiniChart.tsx and reuse it: drive the
  select from state ('12m'|'6m'|'3m' -> getRevenueTrend range), fetch via useAsyncData keyed on the
  range, render the chart with loading/empty/error states. Wire Export Report to a real client-side
  CSV of metrics + trend points, extracting InvoicesPage's escapeCell/Blob CSV code into a shared
  util (services/utils/csv.ts) instead of duplicating it; no handler-less buttons remain.
  Verification: BillingDashboardPage.spec.tsx asserts range change refetches with the new range
  param, chart renders points, and Export produces a Blob download.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx`
  - `web/modules/admin-panel/src/components/charts/MiniChart.tsx`
  - `web/modules/admin-panel/src/pages/AnalyticsDashboardPage.tsx`
  - `web/modules/admin-panel/src/utils/csv.ts`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/BillingDashboardPage.spec.tsx`
- **Effort:** M

### APA-080 [MEDIUM] Recent Transactions swallows all errors and shows empty state on 500

- **Status:** DESIGNED (brief)
- **Symptom:** fetchTransactions wraps the API call in try/catch and returns [] on any failure, so a
  backend 500/502 renders 'No recent transactions' with no error indication — an operator cannot
  distinguish an outage from a genuinely empty ledger.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:322-338 (catch { return []; })`
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:462-465 (empty state rendering)`
- **Root cause:** fetchTransactions (BillingDashboardPage.tsx:324-337) wraps the API call in
  try/catch returning [], defeating useAsyncData's built-in error channel (the metrics fetch on the
  same page uses it correctly), so a 500 renders 'No recent transactions'. Instance of the systemic
  swallow-errors-into-empty-state class.
- **Fix design:** Delete the try/catch — fetchers passed to useAsyncData must never catch (the hook
  is the error contract; correct behavior is automatic once the fetcher just throws). Destructure
  error from the transactions useAsyncData call and render a distinct error + Retry state in the
  Recent Transactions panel, keeping the empty state only for a successful empty result.
  Verification: BillingDashboardPage.spec.tsx case: billingApi.getInvoices rejection renders the
  error/retry UI, not 'No recent transactions'.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/BillingDashboardPage.spec.tsx`
- **Effort:** S

### APA-081 [MEDIUM] Invoice statuses 'sent'/'draft'/'partially_paid'/'overdue' all misrender as 'failed' transactions

- **Status:** DESIGNED (brief)
- **Symptom:** The invoice->transaction mapping treats anything that is not 'paid' or 'pending' as
  status 'failed', so a legitimately sent or partially paid invoice appears as a red failed
  transaction on the dashboard — silently wrong financial signal.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:332 (ternary collapses all other statuses to 'failed')`
  - `apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts:12-21 (8 real invoice statuses)`
- **Root cause:** The invoice->transaction mapping (BillingDashboardPage.tsx:332) projects the
  8-value InvoiceStatus domain onto a 3-value union with an else->'failed' branch, and re-declares
  the invoice shape inline instead of using the shared InvoiceOverview type — so
  sent/draft/partially_paid/overdue invoices render as red 'failed'. Instance of FE-type-drift: two
  pages each hand-roll status presentation.
- **Fix design:** Stop collapsing: type RecentTransaction.status as the real InvoiceStatus (add the
  8-value union/enum to services/types/billing.ts — InvoicesPage.tsx:21 already lists it inline) and
  extract InvoicesPage's statusColors/statusLabels maps into a shared InvoiceStatusBadge component
  typed Record<InvoiceStatus, string> so a status without a mapping is a compile error (tier 1).
  TransactionItem renders the badge; fetchTransactions consumes InvoiceOverview instead of its
  inline structural type. Verification: BillingDashboardPage.spec.tsx asserts a 'sent' invoice
  renders the blue Sent badge and a 'partially_paid' invoice the Partial badge, never 'failed'.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/components/InvoiceStatusBadge.tsx`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/pages/__tests__/BillingDashboardPage.spec.tsx`
- **Effort:** S

## InvoicesPage — `/admin/billing/invoices (+ /admin/billing/invoices/new)` — verdict: **PARTIAL**

**Chain:** List/stats: GET /billing/invoices and /billing/invoices/stats run real parameterized SQL
against billing.invoices JOIN auth.tenants (columns verified against billing-service Baseline
migration; t.name/t.contactEmail verified in auth tenant entity). Mutations go admin-api ->
BillingAdminCommandClientService -> NATS request-reply -> billing-service BillingAdminNatsHandler ->
CQRS handlers that persist with pessimistic locks, Money arithmetic, audit decorators and
transactional outbox events (CreateInvoiceHandler, RecordPaymentHandler for mark-paid,
VoidInvoiceHandler). Field parity FE InvoiceOverview <-> backend verified. Primary defect: invoices
created here are persisted as status 'draft' and no finalize path exists on this surface, so they
can never be paid.

**Endpoints exercised:** `GET /api/billing/invoices?status&search&limit`;
`GET /api/billing/invoices/stats`; `POST /api/billing/invoices`;
`POST /api/billing/invoices/:invoiceId/mark-paid`; `POST /api/billing/invoices/:invoiceId/void`

**DB tables:** `billing.invoices`, `billing.payments`, `auth.tenants`,
`billing.outbox (via @platform/outbox enqueue)`

### APA-082 [HIGH] Admin-created invoices are stuck in 'draft' forever — no finalize path, cannot be marked paid

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** CreateInvoiceHandler persists every invoice with status: InvoiceStatus.DRAFT. The
  admin panel exposes no finalize action (billing.controller.ts has no finalize route; FE billingApi
  has no finalize function), FE canMarkPaid explicitly excludes 'draft', and billing-service
  RecordPaymentHandler rejects payments on draft invoices (payableStatuses =
  pending/sent/partially_paid/overdue). billing-service has a FinalizeInvoiceHandler but it is
  unreachable from admin-api. Net effect: the Create Invoice flow succeeds but produces an invoice
  that can never progress to payable through this UI — the create->collect lifecycle dead-ends.
- **Evidence:**
  - `apps/billing-service/src/billing/handlers/create-invoice.handler.ts:113 (status: InvoiceStatus.DRAFT)`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:332 (canMarkPaid excludes 'draft')`
  - `apps/billing-service/src/billing/handlers/record-payment.handler.ts:54-65 (draft not payable)`
  - `apps/admin-api-service/src/billing/billing.controller.ts:628-738 (no finalize endpoint)`
  - `web/modules/admin-panel/src/services/api/billing.ts:137-189 (no finalize call)`
- **Verification:** Confirmed end-to-end. Admin create path: FE billingApi.createInvoice -> POST
  /billing/invoices (apps/admin-api-service/src/billing/billing.controller.ts:681) ->
  BillingAdminCommandClientService.createInvoice -> NATS request.billing.admin.createInvoice ->
  BillingAdminNatsHandler.createInvoice -> CreateInvoiceCommand -> status DRAFT
  (apps/billing-service/src/billing/handlers/create-invoice.handler.ts:113). No finalize exists on
  any layer of the admin surface: BILLING_ADMIN_COMMAND_SUBJECTS
  (libs/event-contracts/src/billing-admin-commands.ts:11-22) has no FINALIZE subject,
  billing-admin-nats.handler.ts has no finalize @MessagePattern, billing.controller.ts has no
  finalize route, and grep 'finalize' over web/modules/admin-panel/src returns zero matches.
  Mark-paid cannot rescue: it delegates to RecordPaymentCommand
  (billing-admin-nats.handler.ts:258-280) whose payableStatuses exclude DRAFT
  (record-payment.handler.ts:54-65); FE canMarkPaid mirrors that (InvoicesPage.tsx:332). No
  background rescue: billing-scheduler.service.ts only flips SENT/PENDING->OVERDUE and creates
  scheduler invoices directly in PENDING. FinalizeInvoiceHandler exists but is wired only to
  billing-service's tenant-scoped GraphQL finalizeInvoice mutation (billing.resolver.ts:276,
  requires tenant context + INVOICE_WRITE_ROLES), unreachable from the SUPER_ADMIN REST->NATS
  facade. Only escape from DRAFT via the panel is VOID (VoidInvoiceHandler VOIDABLE_STATUSES
  includes DRAFT) — the invoice can be destroyed but never collected. HIGH is correct: core
  financial workflow (create->collect) dead-ends for the platform operator; no
  security/data-corruption impact so not CRITICAL, but not MEDIUM because the panel's only
  invoice-creation flow silently produces permanently uncollectable invoices.
- **Root cause:** The BE->BE contract link broke: BILLING_ADMIN_COMMAND_SUBJECTS is a hand-picked
  projection of billing-service's CQRS command set onto the admin NATS facade, and the projection
  included the lifecycle entry (CREATE_INVOICE) and terminal transitions (MARK_INVOICE_PAID,
  VOID_INVOICE) but omitted the mandatory intermediate transition FinalizeInvoice (DRAFT->SENT) that
  the domain state machine requires before any payment is accepted. Everything downstream (admin-api
  client, controller, FE api, FE UI) faithfully mirrored the incomplete contract, so each layer
  individually looks consistent. This is an instance of the systemic class 'domain state-machine
  transition with no reachable surface': the existing admin-route-contract CI gate validates
  FE-route<->BE-route parity only, so a transition absent from ALL layers simultaneously passes
  every existing check. Nothing derives or verifies that the admin command surface covers a
  progressing path through the invoice state machine, so the facade drifted from the domain the
  moment FinalizeInvoiceCommand was added only to the tenant GraphQL surface.
- **Fix design:** Fix at the contract SOURCE and propagate through every layer, reusing the existing
  FinalizeInvoiceHandler (which already enforces the DRAFT-only guard and fail-closed Stripe
  finalization). (1) libs/event-contracts/src/billing-admin-commands.ts: add FINALIZE_INVOICE:
  'request.billing.admin.finalizeInvoice' to BILLING_ADMIN_COMMAND_SUBJECTS and interface
  BillingAdminFinalizeInvoiceCommand extends BillingAdminCommandMeta { invoiceId: string }; result
  reuses BillingAdminInvoiceCommandResult. (2)
  apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts: add
  @MessagePattern(BILLING_ADMIN_COMMAND_SUBJECTS.FINALIZE_INVOICE) finalizeInvoice() mirroring
  voidInvoice exactly: runAsTrustedAdminBypass('finalize-invoice'),
  getInvoiceTenantId(command.invoiceId), commandBus.execute(new FinalizeInvoiceCommand(tenantId,
  command.invoiceId, command.actorId)), return { success: true, invoice: this.mapInvoice(invoice) }
  — billing-service stays the single writer. (3) admin-api: billing-admin-command-client.service.ts
  adds finalizeInvoice(invoiceId, actorId) via sendBillingCommand + unwrapInvoiceResult;
  billing.controller.ts adds @ThrottleSensitive() @Post('invoices/:invoiceId/finalize') with the
  getAuthUserId check, returning { success: true, invoice } (same envelope as mark-paid/void). (4)
  FE: services/api/billing.ts adds finalizeInvoice(invoiceId) -> POST /billing/invoices/:id/finalize
  typed { success: boolean; invoice: InvoiceOverview }; InvoicesPage.tsx adds canFinalize =
  selectedInvoice.status === 'draft' and a Finalize action beside Mark Paid/Void with confirm +
  refetch. canMarkPaid keeps excluding 'draft' — it correctly mirrors the backend state machine;
  after finalize the invoice is 'sent' and the existing mark-paid path opens. (5) Pattern-level gate
  (hierarchy tier 3, make the class detectable): add an admin invoice-lifecycle reachability spec
  that drives create -> finalize -> mark-paid through the BillingAdminNatsHandler methods against
  the real command handlers, asserting an admin-created invoice reaches PAID using ONLY subjects
  present in BILLING_ADMIN_COMMAND_SUBJECTS; and extend
  tests/invariants/admin-billing-runtime-contract.spec.ts with a bidirectional coverage check —
  every BILLING_ADMIN_COMMAND_SUBJECTS entry must have a matching @MessagePattern in
  billing-admin-nats.handler.ts AND a client method in billing-admin-command-client.service.ts — so
  a dangling or missing subject fails CI. The existing contract-validation.spec.ts
  (admin-route-contract Nx project) picks up the new FE call + BE route pair and stays green because
  both sides land together.
- **Files to change:**
  - `libs/event-contracts/src/billing-admin-commands.ts`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts`
  - `apps/admin-api-service/src/billing/services/billing-admin-command-client.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `apps/billing-service/src/billing/handlers/__tests__/billing-admin-nats.handler.spec.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `tests/invariants/admin-billing-runtime-contract.spec.ts`
- **Proof of fix:** Extend
  apps/billing-service/src/billing/handlers/**tests**/billing-admin-nats.handler.spec.ts with a
  lifecycle-reachability suite: (a) finalizeInvoice message pattern resolves tenant, dispatches
  FinalizeInvoiceCommand, returns success+invoice; (b) end-to-end DRAFT->PAID walk 'admin-created
  invoice reaches PAID using only BILLING_ADMIN_COMMAND_SUBJECTS' — create returns status draft,
  finalize flips to sent, markInvoicePaid succeeds (fails today because no finalize pattern exists).
  Extend tests/invariants/admin-billing-runtime-contract.spec.ts with a bidirectional
  subject-coverage invariant: each BILLING_ADMIN_COMMAND_SUBJECTS key appears in exactly one
  @MessagePattern in billing-admin-nats.handler.ts and one send in
  billing-admin-command-client.service.ts (catches the whole 'partial command-surface projection'
  class). Extend apps/admin-api-service/src/billing/**tests**/billing.controller.spec.ts for the
  POST invoices/:invoiceId/finalize route (auth required, delegates to
  billingAdminCommands.finalizeInvoice, envelope { success, invoice }). The existing
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts (admin-route-contract CI target)
  verifies the new FE billingApi.finalizeInvoice route resolves to the new controller route. Run: nx
  affected --target=test and the test:contract target.
- **Effort:** M

### APA-083 [MEDIUM] No pagination — list hard-capped at 100 invoices with no offset controls

- **Status:** DESIGNED (brief)
- **Symptom:** fetchInvoices always sends limit:100 and never sends offset; the table has no pager
  even though the backend supports offset and returns total. Past 100 invoices, older rows are
  silently invisible, and the client-side CSV 'Export' exports only those loaded rows while implying
  a full export.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:98-102 (limit:100, no offset)`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:256-318 (CSV built from loaded state only)`
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts:249-258 (offset supported server-side)`
- **Root cause:** fetchInvoices (InvoicesPage.tsx:98-102) hardcodes limit:100 and never sends
  offset; the page discards the server-returned total (invoice-management.service.ts supports
  LIMIT/OFFSET and returns {invoices,total}) and renders no pager, so rows past 100 are invisible;
  handleExportCsv (:256-318) serializes only loaded state while implying a full export. The existing
  usePagination hook was never adopted.
- **Fix design:** Adopt the existing web/modules/admin-panel/src/hooks/usePagination.ts:
  page/pageSize state -> limit/offset params, pager UI fed by the returned total (pattern already
  proven on other admin pages). handleExportCsv iterates all pages for the current filters (loop
  fetch with increasing offset until total collected) so the CSV covers the full filtered set, and
  the success toast reports the true count. Verification: new
  web/modules/admin-panel/src/pages/**tests**/InvoicesPage.spec.tsx asserting offset is sent on page
  change, pager renders from total, and export issues paged fetches until total rows are gathered.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/InvoicesPage.spec.tsx`
- **Effort:** M

### APA-084 [MEDIUM] Search fires a full list+stats refetch on every keystroke with no debounce

- **Status:** DESIGNED (brief)
- **Symptom:** searchTerm is a dependency of fetchInvoices; the useEffect re-runs on each identity
  change and also re-invokes fetchStats, so each character typed issues two backend requests plus a
  router navigate. Under the shared per-user ThrottlerGuard this can 429 an operator typing quickly
  and hammers billing.invoices with ILIKE scans.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:93-118 (fetchInvoices deps [statusFilter, searchTerm])`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:135-138 (effect runs both fetches)`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:168-171 (handleSearchChange per keystroke)`
- **Root cause:** searchTerm is a dep of fetchInvoices (InvoicesPage.tsx:118) and the single effect
  (:135-138) re-invokes BOTH fetchInvoices and fetchStats when the callback identity changes, plus
  handleSearchChange navigates per keystroke — 2 requests + a router update per character. The page
  hand-rolls filter/URL state although hooks/useFilters.ts already provides debounceKeys +
  debouncedFilters + syncUrl for exactly this.
- **Fix design:** Replace searchTerm/statusFilter/updateInvoiceListQuery with useFilters({
  initialFilters: { search, status }, syncUrl: true, debounceKeys: ['search'] }); the fetch effect
  depends on debouncedFilters only. Split fetchStats into its own mount-only effect, refreshed
  explicitly after mutations (stats never depended on search). Pattern-level fix already exists as
  the hook; this closes the non-adoption. Verification: InvoicesPage.spec.tsx with fake timers
  asserting one getInvoices call per debounce window while typing and zero getInvoiceStats calls
  triggered by typing.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/InvoicesPage.spec.tsx`
- **Effort:** S

### APA-085 [LOW] Void offered for partially_paid invoices but backend always rejects it

- **Status:** DESIGNED (brief)
- **Symptom:** FE canVoid only excludes paid/void/refunded, so partially_paid invoices show a Void
  button; billing-service VOIDABLE_STATUSES is draft/pending/sent/overdue, so the request always
  fails with 400 'Cannot void invoice with status partially_paid' surfaced as an error toast.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:333 (canVoid predicate)`
  - `apps/billing-service/src/billing/handlers/void-invoice.handler.ts:9-14 (VOIDABLE_STATUSES excludes partially_paid)`
- **Root cause:** Invoice status-transition rules exist only inside billing-service handlers
  (VOIDABLE_STATUSES = draft/pending/sent/overdue in void-invoice.handler.ts:9-14) while the FE
  re-derives eligibility with an ad-hoc negative predicate (InvoicesPage.tsx:333 excludes only
  paid/void/refunded), so partially_paid shows a Void button that always 400s. Systemic
  FE-guessing-transition-rules drift; web modules deliberately do not import
  @platform/event-contracts, so no compiler link exists.
- **Fix design:** Make affordances server-computed (tier 2): define canonical
  INVOICE_VOIDABLE_STATUSES / INVOICE_PAYABLE_STATUSES in @platform/event-contracts
  (libs/event-contracts/src, exported from index); billing-service VoidInvoiceHandler and
  RecordPaymentHandler import them (deleting local arrays); admin-api InvoiceManagementService
  imports the same sets and emits computed canVoid/canMarkPaid booleans on InvoiceOverview; FE
  InvoiceOverview type gains the fields and InvoicesPage renders buttons from
  invoice.canVoid/canMarkPaid, deleting both local predicates — the FE can no longer disagree with
  the handler. Verification: billing-service handler specs assert rejection sets come from the
  contract; new invoice-management.service spec asserts partially_paid -> canVoid:false, draft ->
  canMarkPaid:false; InvoicesPage.spec.tsx asserts no Void button for a partially_paid invoice.
- **Files to change:**
  - `libs/event-contracts/src/billing-invoice-status.ts`
  - `libs/event-contracts/src/index.ts`
  - `apps/billing-service/src/billing/handlers/void-invoice.handler.ts`
  - `apps/billing-service/src/billing/handlers/record-payment.handler.ts`
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/InvoicesPage.spec.tsx`
- **Effort:** M

### APA-086 [LOW] MarkInvoicePaidDto accepts amount 0, creating a $0 payment that flips status to partially_paid

- **Status:** DESIGNED (brief)
- **Symptom:** The DTO uses @Min(0) rather than @Min(0.01); a 0 amount passes admin-api validation
  and billing-service RecordPaymentHandler (0 is not greater than amountDue), creating a SUCCEEDED
  $0 payment row and setting the invoice to PARTIALLY_PAID though nothing was paid. FE blocks 0 but
  the API does not.
- **Evidence:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts:222-226 (@Min(0))`
  - `apps/billing-service/src/billing/handlers/record-payment.handler.ts:79-127 (no lower-bound check; PARTIALLY_PAID branch)`
- **Root cause:** MarkInvoicePaidDto uses @Min(0) (billing.dto.ts:222-226) so amount:0 passes
  admin-api validation, and RecordPaymentHandler's only bound check is
  paymentMoney.greaterThan(amountDueMoney) (record-payment.handler.ts:79) — zero (and any value the
  DTO lets through) creates a SUCCEEDED $0 payment row and the else-branch at :126 flips the invoice
  to PARTIALLY_PAID with nothing paid. Aggravating instance of the unvalidated-interface-DTO class:
  POST /billing/payments takes RecordPaymentDto as a TS interface with zero class-validator
  coverage, so the handler is the only real gate for that path.
- **Fix design:** Enforce at the source of truth: RecordPaymentHandler rejects non-positive amounts
  (paymentMoney.isZero() || paymentMoney.isNegative() -> BadRequestException) before any write,
  protecting every caller (admin mark-paid, record-payment, Stripe paths). Tighten the edges:
  MarkInvoicePaidDto -> @IsPositive() (drop @Min(0)), and convert admin-api's RecordPaymentDto
  interface into a validated class DTO (@IsUUID invoiceId, @IsPositive amount, enum paymentMethod)
  in dto/billing.dto.ts — local application of the systemic fix. Verification: extend
  apps/billing-service/src/billing/**tests**/record-payment.handler.spec.ts with amount 0 and
  negative -> BadRequest and invoice status unchanged; extend billing.controller.spec.ts for DTO
  rejection of amount:0.
- **Files to change:**
  - `apps/billing-service/src/billing/handlers/record-payment.handler.ts`
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/billing-service/src/billing/__tests__/record-payment.handler.spec.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
- **Effort:** S

## PaymentsPage — `/admin/billing/payments` — verdict: **PARTIAL**

**Chain:** GET /billing/payments runs real SQL against billing.payments LEFT JOIN billing.invoices
(all selected columns verified in Baseline migration line 45). POST /billing/payments and
/billing/payments/refund route via NATS to billing-service RecordPaymentHandler /
RefundPaymentHandler: real transactions with pessimistic locks, invoice amountPaid/amountDue
updates, transactional outbox events, and a REAL Stripe refund (StripeApiService.createRefund with
idempotency key) when the payment has a stripeChargeId — manual admin-recorded payments are
ledger-only, which is correct. Gaps: the invoice-ID filter 500s on any non-UUID input, the refund
history array is never returned by the list query so the modal's Refund History section is dead,
stat cards aggregate only the current 50-row page, and the record/refund request bodies bypass
validation (interface-typed DTOs).

**Endpoints exercised:** `GET /api/billing/payments?status&invoiceId&limit`;
`POST /api/billing/payments`; `POST /api/billing/payments/refund`

**DB tables:** `billing.payments`, `billing.invoices`

### APA-087 [MEDIUM] Invoice-ID filter throws 500 on every keystroke of a non-UUID value

- **Status:** DESIGNED (brief)
- **Symptom:** The free-text filter fires fetchPayments per keystroke and the backend interpolates
  it as p.invoice_id = $n::uuid; any partial input ('abc', or a pasted invoice NUMBER like
  INV-202607-...) makes Postgres raise 'invalid input syntax for type uuid', which surfaces as a 500
  and flips the page into the error state. The placeholder invites typing yet no UUID validation or
  debounce exists on either side.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts:117-121 ($::uuid cast on raw filter)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:334-339 (free-text input)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:126-151 (refetch per keystroke, error state)`
- **Root cause:** GET /billing/payments takes invoiceId as a raw @Query string
  (billing.controller.ts:747) and PaymentManagementService interpolates it as p.invoice_id =
  $n::uuid (payment-management.service.ts:117-121); any non-UUID (partial keystroke, pasted INV-
  number) makes Postgres raise 22P02 -> unhandled 500, and PaymentsPage feeds a free-text field into
  it with a refetch per keystroke and no debounce (:126-151, :334-339). Systemic: admin-api list
  endpoints use raw string @Query params instead of validated query DTOs despite the global
  ValidationPipe.
- **Fix design:** Backend: introduce ListPaymentsQueryDto (@IsOptional @IsUUID('4') invoiceId, typed
  status/search/limit/offset) consumed via @Query() dto so malformed ids are a 400 at the boundary,
  never a Postgres error — apply the query-DTO pattern as the fix for this endpoint class.
  Semantics: the operator-facing filter is a search, not a raw UUID — extend PaymentFilters.search
  to also match i.invoice_number ILIKE (the billing.invoices join already exists at :175) and have
  PaymentsPage send a debounced search (useFilters debounceKeys:['search']); invoiceId remains an
  exact-UUID deep-link param only. Verification: billing.controller.spec.ts: invoiceId=abc -> 400
  with validation message; payment-management spec: search='INV-2026' matches by invoice_number; new
  PaymentsPage.spec.tsx: typing 'abc' never flips the page to the error state.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/PaymentsPage.spec.tsx`
- **Effort:** M

### APA-088 [MEDIUM] Refund history is never returned — payment detail modal's Refund History section is permanently dead

- **Status:** DESIGNED (brief)
- **Symptom:** billing.payments has a refunds jsonb column populated by RefundPaymentHandler
  (amount, reason, refundedAt, refundId), and the FE modal renders selectedPayment.refunds. But
  PaymentManagementService.getPayments SELECT list omits the refunds column entirely, so the field
  is always undefined and per-refund reasons/dates are unviewable in the admin panel despite
  existing in the DB.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts:155-179 (SELECT omits refunds)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:567-584 (Refund History UI keyed on payment.refunds)`
  - `apps/billing-service/src/billing/entities/payment.entity.ts:163-165 (refunds jsonb column exists)`
  - `web/modules/admin-panel/src/services/types/billing.ts:322 (FE type declares refunds)`
- **Root cause:** PaymentManagementService.getPayments SELECT list
  (payment-management.service.ts:155-179) omits the refunds jsonb column, and the service's
  hand-written PaymentOverview interface (:12-31) omits the field entirely, while
  billing.payments.refunds exists (payment.entity.ts:163-165, populated by RefundPaymentHandler) and
  the FE type (:322) + modal (PaymentsPage.tsx:567-584) already consume it. Instance of the
  FE-type-drift class: admin-api and FE each hand-maintain PaymentOverview with no contract check,
  so the omission was silent.
- **Fix design:** Fix the contract at the source: add p.refunds to the SELECT, add a RefundInfo
  interface (amount, reason, refundedAt, refundId — matching billing-service and the FE type) and
  refunds?: RefundInfo[] to admin-api's PaymentOverview + PaymentOverviewRow so the mapper now
  carries the column by type. Pattern-level: add a contract spec that a refunded payment's refunds
  array round-trips through getPayments — the detectable gate for this admin-api/FE shape pair (full
  codegen for admin-panel types is the tracked class-level fix). Verification: new
  apps/admin-api-service/src/billing/**tests**/payment-management.service.spec.ts asserting a row
  with refunds jsonb is returned with the array intact; PaymentsPage.spec.tsx asserting Refund
  History renders when refunds are present.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/__tests__/payment-management.service.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/PaymentsPage.spec.tsx`
- **Effort:** S

### APA-089 [MEDIUM] Stat cards (Succeeded/Refunded/Net) computed from the current 50-row page while Total Payments is the server-wide count

- **Status:** DESIGNED (brief)
- **Symptom:** totalPayments comes from the server COUNT, but totalSucceeded/totalRefunded/net are
  reduced over the currently loaded page (fixed limit 50, no pagination UI). With more than 50
  payments the money cards silently understate platform totals while sitting next to an accurate
  count — inconsistent financial numbers on one screen; amounts also sum across currencies and
  render as USD.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:259-261 (client-side reduce over page)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:131-135 (limit: 50, no offset)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:297-314 (cards mixing server total with page sums)`
- **Root cause:** PaymentsPage derives the Succeeded/Refunded/Net money cards by client-side reduce
  over the currently loaded page (fixed limit 50, no offset/pagination UI) while Total Payments uses
  the server-wide COUNT — there is no server-side payments aggregate endpoint, so the page has
  nothing correct to render. The reduce also adds mixed-currency amounts and formats them as USD.
- **Fix design:** Make the correct number the only available number (tier 2): add
  PaymentManagementService.getPaymentStats() computing currency-partitioned aggregates in SQL over
  billing.payments (SUM(amount) FILTER (WHERE status IN ('succeeded','partially_refunded')),
  SUM(refunded_amount), COUNT(\*), all GROUP BY currency), expose GET /billing/payments/stats in
  BillingController (registered before the parameterized payment routes), add PaymentStats to the FE
  billing types + billingApi.getPaymentStats(), and drive all four cards from it — delete the client
  reduce at PaymentsPage.tsx:259-261. Render amounts per-currency per the xc|i2 Money-by-currency
  contract (no cross-currency sum, no default-USD format). Verification: extend
  apps/admin-api-service/src/billing/**tests**/payment-management.service.spec.ts with a >50-row,
  two-currency fixture asserting stats are table-wide and currency-keyed, plus a PaymentsPage spec
  asserting cards render server stats independent of the loaded page.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx`
  - `apps/admin-api-service/src/billing/__tests__/payment-management.service.spec.ts`
- **Effort:** M

### APA-090 [LOW] FE PaymentOverview type omits invoiceNumber; page reads it through an inline cast

- **Status:** DESIGNED (brief)
- **Symptom:** The backend returns invoiceNumber (joined from billing.invoices) but the hand-written
  FE type lacks the field, forcing '(payment as PaymentOverview & { invoiceNumber?: string })' in
  the render path — contract drift that currently works only by accident of the cast.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/billing.ts:310-328 (no invoiceNumber)`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx:433 (inline cast)`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts:161 (invoiceNumber selected)`
- **Root cause:** Hand-written FE PaymentOverview
  (web/modules/admin-panel/src/services/types/billing.ts:310-328) drifted from the backend
  PaymentOverview (payment-management.service.ts:12-31), which gained invoiceNumber (and tenantName)
  from the billing.invoices join; the page papers over the gap with an inline intersection cast at
  PaymentsPage.tsx:433. Instance of the systemic FE-type-drift class (hand-maintained duplicate
  types with no contract link).
- **Fix design:** Fix the contract at the source: add invoiceNumber?: string and tenantName?: string
  to the FE PaymentOverview so it matches the backend response shape, then delete the cast at
  PaymentsPage.tsx:433 and read payment.invoiceNumber directly. Pattern-level: this is the same
  drift class already flagged for the section — the durable fix is a single shared response-contract
  module (backend admin-api response interfaces exported from a shared lib or generated from the
  existing Swagger via openapi codegen) consumed by web/modules/admin-panel/src/services/types; the
  local field addition is the immediate application. Verification: TS compile (npm run type-check)
  fails on any remaining cast; the future contract test / codegen gate covers the class.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx`
- **Effort:** S

## BillingReportsPage — `/admin/billing/reports` — verdict: **PARTIAL**

**Chain:** Compiles the report from three real endpoints: GET /billing/invoices/stats (5 parallel
real aggregations over billing.invoices), GET /billing/subscriptions?status=active&limit=1 (real SQL
over billing.subscriptions JOIN auth.tenants; only total is used), GET
/billing/payments?status=succeeded&limit=100 (real SQL over billing.payments). CSV export is
client-side over the 8 summary numbers — real data, no server export. Core defect: the 'Payments
With Refunds' metric is structurally always ~0 because refunded payments leave the 'succeeded'
status the query filters on.

**Endpoints exercised:** `GET /api/billing/invoices/stats`;
`GET /api/billing/subscriptions?status=active&limit=1&offset=0`;
`GET /api/billing/payments?status=succeeded&limit=100`

**DB tables:** `billing.invoices`, `billing.subscriptions`, `billing.payments`, `auth.tenants`

### APA-091 [HIGH] 'Payments With Refunds' metric is structurally always ~0; 'Successful Payments' shrinks when payments are refunded

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The page fetches payments with status:'succeeded' and then counts rows with
  refundedAmount>0. But RefundPaymentHandler transitions any refunded payment to status 'refunded'
  or 'partially_refunded', removing it from the 'succeeded' filter — so a payment with a refund can
  (edge cases aside) never appear in the fetched set, and the card silently reports 0 regardless of
  actual refund volume. The same filter makes 'Successful Payments' exclude historically successful
  payments that were later (partially) refunded, so both report numbers are silently wrong.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx:37 (status:'succeeded' filter)`
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx:47-48 (refundedPayments computed from that set)`
  - `apps/billing-service/src/billing/handlers/refund-payment.handler.ts:123-128 (status leaves 'succeeded' on refund)`
- **Verification:** Confirmed end-to-end. FE (BillingReportsPage.tsx:37) requests only
  status='succeeded'; admin-api BillingController @Get('payments') passes status through to
  PaymentManagementService.getPayments, which applies `p.status = ANY($1)` server-side to both the
  row page and the COUNT(\*) total. Both refund paths — RefundPaymentHandler
  (refund-payment.handler.ts:123-128) and the Stripe charge.refunded webhook
  (stripe-webhook.service.ts:490-492) — set status to REFUNDED/PARTIALLY_REFUNDED in the same
  transaction that raises refundedAmount, so no reachable state has status='succeeded' with
  refundedAmount>0. Hence 'Payments With Refunds' is structurally 0 and 'Successful Payments'
  (payments.total under the filter) silently drops every ever-succeeded-then-refunded payment; the
  CSV export propagates both. Refutation attempts failed: no alternate route, no server-side stats
  endpoint for payments, no other consumer. Aggravator found: the FE aggregates over a single
  limit:100 page, so even with correct statuses the number could never be a platform total. Severity
  stays HIGH: the page is the SUPER_ADMIN billing report with an authoritative CSV export, and both
  financial metrics are silently wrong 100% of the time refunds exist — silent financial
  misreporting, not an edge case. Systemic class: client-side aggregation over a paginated/filtered
  list API where the platform pattern is server-computed stats endpoints (invoices/stats,
  subscriptions/stats, discounts/stats).
- **Root cause:** The FE→BE contract link broke: the page treats payment status 'succeeded' as a
  sticky historical fact ('was this payment ever successful?') while the billing-service state
  machine treats it as a current state that refunds transition out of (succeeded →
  refunded/partially_refunded, set atomically with refundedAmount in both RefundPaymentHandler and
  the Stripe webhook). Because admin-panel types are hand-written and stats are derived client-side
  from a filtered, paginated list endpoint (limit 100), nothing in the type system or tests tied the
  page's aggregate semantics to the backend state machine — an instance of the systemic 'client-side
  aggregation over a paginated list API' class, for which the repo's established cure (server-side
  SQL stats endpoints like invoices/stats) was never applied to payments.
- **Fix design:** Pattern-level fix (tier 2 — make correct behavior automatic): platform aggregates
  must be computed server-side in SQL, never derived in the FE from a filtered/paginated list. The
  repo already has this pattern for invoices/subscriptions/discounts stats; payments is the missing
  instance. (1) BACKEND: add `getStats(): Promise<PaymentStats>` to `PaymentManagementService`
  (admin-api-service), mirroring `InvoiceManagementService.getStats()` — one parallel SQL pass over
  `billing.payments`:
  `successfulPayments = COUNT(*) FILTER (WHERE status IN ('succeeded','refunded','partially_refunded'))`
  (ever-succeeded — both refund paths only transition OUT of succeeded, so these three statuses are
  exactly the ever-succeeded set),
  `paymentsWithRefunds = COUNT(*) FILTER (WHERE refunded_amount > 0)`, plus `totalPayments`,
  per-status counts/sums, `totalRefundedAmount = COALESCE(SUM(refunded_amount),0)`. Export the
  `PaymentStats` interface next to `PaymentOverview`. (2) Add `@Get('payments/stats')` to
  `BillingController` (declared alongside `@Get('payments')`; no param-route conflict exists)
  returning `this.paymentService.getStats()` — the ResponseInterceptor envelope wraps it like every
  other stats endpoint. (3) FE CONTRACT: add `PaymentStats` to
  `web/modules/admin-panel/src/services/types/billing.ts` and
  `billingApi.getPaymentStats: () => apiFetch<PaymentStats>('/billing/payments/stats')`. (4) FE
  PAGE: BillingReportsPage replaces the `getPayments({status:'succeeded',limit:100})` call and the
  client-side `filter(refundedAmount>0)` with `getPaymentStats()`; `successfulPayments` and
  `refundedPayments` come verbatim from the stats payload, so the wrong computation is deleted, not
  patched — the page no longer imports the list API at all. No defensive `??`/`?.` retained around
  the removed path. This simultaneously fixes the status-exclusivity bug AND the limit-100
  truncation, because the aggregate is computed over the full table in the DB.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/BillingReportsPage.spec.tsx`
- **Proof of fix:** Extend apps/admin-api-service/src/billing/**tests**/billing.controller.spec.ts:
  GET payments/stats delegates to PaymentManagementService.getStats and returns its result;
  service-level test asserts the SQL semantics via the mocked dataSource (successfulPayments counts
  statuses succeeded+refunded+partially_refunded; paymentsWithRefunds counts refunded_amount>0
  regardless of status) — i.e., a fully-refunded payment increments BOTH counters. Add
  web/modules/admin-panel/src/pages/**tests**/BillingReportsPage.spec.tsx (pattern exists:
  TenantManagementPage.spec.tsx): mock billingApi, assert the page calls getPaymentStats and renders
  its refund/success counts verbatim, and assert billingApi.getPayments is NOT called by the page —
  this is the regression gate that the client-side succeeded-filter aggregation stays deleted.
  Optionally extend e2e/tests/integration billing coverage: seed payments in statuses
  succeeded/refunded/partially_refunded/failed with refunded_amount set by the real refund handler,
  then assert /billing/payments/stats reports successfulPayments=3, paymentsWithRefunds=2.
- **Effort:** M

### APA-092 [MEDIUM] Refund count additionally capped at 100 rows and export is summary-only

- **Status:** DESIGNED (brief)
- **Symptom:** Even if the status filter were fixed, refundedPayments is counted client-side over at
  most 100 fetched rows (no pagination loop), and the 'Export CSV' produces only the 8 aggregate
  numbers — there is no server-side report export of underlying rows despite admin-api having a
  reports controller with financial_revenue/financial_payments report types this page never calls.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx:37,48 (limit:100 + client count)`
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx:62-88 (summary-only CSV)`
  - `apps/admin-api-service/src/analytics/controllers/reports.controller.ts:323-326,411-421 (unused real report endpoints)`
- **Root cause:** BillingReportsPage re-implements aggregation the backend already owns:
  refundedPayments is counted client-side over at most 100 fetched rows
  (BillingReportsPage.tsx:37,48) because no server aggregate exposes it, and Export CSV hand-builds
  a Blob of the 8 summary numbers (62-88) while reports.controller.ts already serves
  financial_revenue/payments report generation with CSV format and an execution download route the
  page never calls.
- **Fix design:** Move all aggregation and export server-side. (a) Refund/succeeded counts come from
  the GET /billing/payments/stats endpoint designed in p2|i2 (add COUNT(\*) FILTER (WHERE
  refunded_amount > 0) per currency); drop the limit:100 getPayments call entirely. (b) Export CSV
  invokes the existing reports pipeline (POST reports/quick/revenue or GET reports/payments with
  format=csv via a reportsApi fn in services/api) and downloads the server-produced row-level CSV
  through the executions/:id/download route, replacing the summary Blob. Verification:
  BillingReportsPage spec asserting no client-side reduce/filter over payments and that export calls
  the reports API; extend the reports controller/service spec to cover the csv payments report path
  end-to-end.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
- **Effort:** M

## Cross-cutting findings

### APA-093 [MEDIUM] Admin billing reads ignore soft-delete: is_deleted rows counted in invoice lists/stats, payment lists, subscription lists, and MRR/revenue analytics

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** billing-service treats is_deleted as the financial soft-delete SSoT and filters every
  lookup with is_deleted = false (e.g. getInvoiceTenantId, getPaymentTenantId, subscription
  lookups). admin-api-service's parallel read paths do NOT:
  InvoiceManagementService.getInvoices/getStats, PaymentManagementService.getPayments,
  SubscriptionCoreService.getSubscriptions, and AnalyticsService.getFinancialMetrics (both the
  subscriptionRepository.find for MRR and the billing.invoices aggregation) all query without an
  is_deleted predicate. Any soft-deleted invoice/payment/subscription therefore inflates admin
  revenue, MRR, invoice stats and report totals — silent wrong financial data that diverges from the
  SSoT's own view.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts:165-186,308-351 (no is_deleted filter)`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts:151-179 (no is_deleted filter)`
  - `apps/admin-api-service/src/billing/services/subscription-core.service.ts:78-97 (no is_deleted filter)`
  - `apps/admin-api-service/src/analytics/services/analytics.service.ts:480-519 (MRR + invoice aggregation without is_deleted)`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:1078-1100 (SSoT filters is_deleted = false)`
  - `apps/billing-service/src/database/migrations/1800000000000-Baseline.ts:45,53 (is_deleted columns exist on payments/invoices)`
- **Verification:** CONFIRMED with one impact correction. Facts verified: (1) is_deleted exists on
  billing.subscriptions/invoices/payments
  (apps/billing-service/src/database/migrations/1800000000000-Baseline.ts, incl. partial unique
  index UQ_subscriptions_tenantId_active WHERE is_deleted=false); (2) billing-service enforces
  is_deleted=false on every SSoT read
  (billing-admin-nats.handler.ts:383,428,464,815,1080,1092,1111,1148); (3) admin-api-service has
  ZERO isDeleted references — 45 unfiltered references to billing.(subscriptions|invoices|payments)
  across 9 production files, and the read-only entities
  (analytics/entities/external/{subscription,invoice}.entity.ts) do not even map the column; (4)
  reachable today: create-subscription.handler.ts:136 soft-deletes the prior CANCELLED subscription
  on cancel→re-subscribe, and the unfiltered reads are exposed at GET /billing/subscriptions,
  /subscriptions/stats, /subscriptions/tenant/:id, /invoices, /invoices/stats, /payments
  (billing.controller.ts:322-769). Reachable-today damage: ghost duplicate subscription rows in
  admin lists; SubscriptionCoreService.getSubscriptionByTenant (no is_deleted filter AND no ORDER BY
  — result[0] nondeterministic) can show a dead 'cancelled' row for an actively subscribed tenant;
  SubscriptionAnalyticsService.getStats/getChurnAnalysis/getGrowthMetrics count soft-deleted rows in
  totalSubscriptions, churnRate, trial conversion, lifetime. REFUTED portion: MRR/revenue inflation
  is latent, not active — softDelete() preserves status, the only current writer only soft-deletes
  already-CANCELLED subscriptions (excluded from MRR by status IN ('active','trial')), and
  Invoice.softDelete/Payment.softDelete currently have no callers. So invoice/payment/revenue
  divergence is a guaranteed time bomb (SSoT reads filter, entity API invites the writer) but not
  live. HIGH lowered to MEDIUM: wrong admin business metrics + ghost rows reachable today, financial
  inflation latent, no security/tenant impact. Systemic class: parallel admin read model violating
  the owner-service's soft-delete read contract, which exists only as repeated literal SQL inside
  billing-service.
- **Root cause:** The BE→DB link broke at the service boundary: billing-service established
  is_deleted as the live-row read contract for its tables, but that contract exists only as ad-hoc
  `AND is_deleted = false` literals repeated inside billing-service query text. Nothing structural
  (view, mapped column, shared predicate, or test gate) exports the contract across the boundary, so
  admin-api-service's parallel read path — raw SQL over billing.\* plus synchronize:false read-only
  entities that never mapped is_deleted — was built and evolved (BUG-044, CRITICAL-003 fixes touched
  these exact queries) without ever learning the predicate. Classic config/contract-nobody-reads
  drift: the SSoT changed its semantics (soft delete added for audit-trail preservation,
  ORPHAN-175/BILLING-MEDIUM-004) and every out-of-service reader silently kept pre-soft-delete
  semantics.
- **Fix design:** Pattern-level fix (Tier 1/2 — make dead-row reads impossible for cross-service
  readers, and the predicate single-sourced at the owner): billing-service ships a migration
  creating owner-side live views — billing.live_subscriptions, billing.live_invoices,
  billing.live_payments — each `SELECT * FROM billing.<table> WHERE is_deleted = false` (additive,
  blue-green safe). The soft-delete predicate then lives in exactly one place owned by the table
  owner; any future soft-delete writer (invoice/payment softDelete() already exists on the entities)
  requires zero reader changes. Local application in admin-api-service: (a) retarget the read-only
  entities at the views — `@Entity('live_invoices', { schema: 'billing', synchronize: false })` and
  `@Entity('live_subscriptions', …)` — so every repository read
  (AnalyticsService.getFinancialMetrics subscriptionRepository.find) is automatically live with no
  where-clause to forget; (b) replace every `FROM/JOIN billing.(subscriptions|invoices|payments)`
  with the live view in invoice-management.service.ts, payment-management.service.ts,
  subscription-core.service.ts, subscription-analytics.service.ts, subscription-renewal.service.ts,
  analytics.service.ts, tenant.controller.ts; (c) fix getSubscriptionByTenant determinism to match
  the SSoT's getSubscription semantics: `ORDER BY "createdAt" DESC LIMIT 1`
  (billing-admin-nats.handler.ts:1102-1122 is the reference semantics). Tier 3 gate against
  recurrence of the class: a static invariant spec in admin-api-service failing on any base-table
  reference `billing\.(subscriptions|invoices|payments)\b` in src (migrations/archives excluded),
  plus a billing-service integration test that runs migrations, inserts a row, calls softDelete, and
  asserts the row is absent from the live view while present in the base table. Also verify the
  ADR-012 schema-drift validator classifies views correctly (filter information_schema
  table_type='BASE TABLE' if it currently enumerates all relations). No defensive per-query patching
  as the primary fix; the sprinkled-filter alternative was rejected because it leaves the drift
  class open for the next query.
- **Files to change:**
  - `apps/billing-service/src/database/migrations/<next-timestamp>-CreateBillingLiveRowViews.ts`
  - `apps/admin-api-service/src/analytics/entities/external/subscription.entity.ts`
  - `apps/admin-api-service/src/analytics/entities/external/invoice.entity.ts`
  - `apps/admin-api-service/src/analytics/services/analytics.service.ts`
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-core.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-analytics.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-renewal.service.ts`
  - `apps/admin-api-service/src/tenant/tenant.controller.ts`
  - `apps/billing-service/src/__tests__/integration/billing-live-views.spec.ts`
  - `apps/admin-api-service/src/__tests__/billing-base-table-read.invariant.spec.ts`
- **Proof of fix:** 1) New
  apps/billing-service/src/**tests**/integration/billing-live-views.spec.ts: after migrations,
  insert a subscription/invoice/payment, flip softDelete + save, assert the row is returned by
  billing.<table> but NOT by billing.live\_<table>; assert all three views exist. 2) New
  apps/admin-api-service/src/**tests**/billing-base-table-read.invariant.spec.ts: static scan of
  apps/admin-api-service/src (excluding migrations and .archive) asserting zero matches for
  /billing\.(subscriptions|invoices|payments)\b/ — locks the whole drift class out at test time. 3)
  New/extended subscription-core spec asserting getSubscriptionByTenant emits ORDER BY "createdAt"
  DESC LIMIT 1 and reads from billing.live_subscriptions (parity with billing-admin-nats.handler
  getSubscription). 4) Reproduction-turned-regression in the billing-views integration suite:
  cancel→re-subscribe a tenant, then assert admin getSubscriptions returns exactly one row for that
  tenant, getStats churn/total counts exclude the soft-deleted row, and getSubscriptionByTenant
  returns the live active row. 5) e2e/tests/integration/schema-invariants.spec.ts stays green (views
  must not be misclassified as new tables by the ADR-012 drift validator).
- **Effort:** M

### APA-094 [MEDIUM] Financial mutation endpoints use interface-typed @Body DTOs, silently bypassing the global ValidationPipe

- **Status:** DESIGNED (brief)
- **Symptom:** POST /billing/payments, /billing/payments/refund, /billing/invoices
  (CreateInvoiceRequest), /billing/subscriptions/change-plan and /billing/pricing/calculate type
  their @Body as TypeScript interfaces (RecordPaymentDto/RefundPaymentDto from
  payment-management.service.ts, CreateInvoiceRequest, PlanChangeRequest, QuoteRequest). Interfaces
  erase to Object at runtime, so the platform's global ValidationPipe (whitelist:true,
  forbidNonWhitelisted:true in create-service-app.ts) skips them entirely — no field validation, no
  whitelisting, no 400s on garbage. Malformed amounts/dates flow over NATS into billing-service
  handlers, which validate business rules but return INTERNAL_ERROR->502 for type garbage instead of
  a clean 400, and arbitrary extra fields ride through untouched. Contrast with
  MarkInvoicePaidDto/VoidInvoiceDto which are proper class-validator classes.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts:44-57 (interface DTOs)`
  - `apps/admin-api-service/src/billing/billing.controller.ts:88-90,682,774,782 (interface-typed @Body params)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-460 (global pipe assumes class DTOs)`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:299-339 (spread of unvalidated input; only paymentMethod parsed)`
- **Root cause:** Five financial mutation routes type @Body with TypeScript interfaces
  (RecordPaymentDto/RefundPaymentDto payment-management.service.ts:44-57; CreateInvoiceRequest
  billing.controller.ts:88-90; PlanChangeRequest subscription-types.ts:38; QuoteRequest
  pricing-calculator.service.ts:76). Interfaces erase to Object at runtime, so the global
  ValidationPipe (create-service-app.ts:458-461) skips them — no field validation, no whitelisting,
  no 400s; the controller even hand-strips changedBy at line 379 because whitelist never runs.
  Systemic class: unvalidated interface-DTO.
- **Fix design:** Local (tier 2): convert the five request shapes into class-validator classes in
  apps/admin-api-service/src/billing/dto/billing.dto.ts, following the existing
  MarkInvoicePaidDto/VoidInvoiceDto pattern: RecordPaymentDto (@IsUUID invoiceId, @IsPositive
  amount, @IsEnum paymentMethod, @IsISO8601 optional paymentDate, @IsOptional @IsString
  notes/currency), RefundPaymentDto, CreateInvoiceDto implementing BillingAdminCreateInvoiceInput &
  {tenantId} with @ValidateNested + @Type subclasses for lineItems/billingAddress/tax/discount,
  ChangePlanDto (without changedBy — delete the manual strip at billing.controller.ts:379; whitelist
  now enforces it), PricingQuoteDto with nested ModuleSelection class. Classes structurally satisfy
  the old interfaces, so services accept them unchanged; delete the interface exports so the drift
  cannot recur. Pattern gate (tier 3): add
  apps/admin-api-service/src/**tests**/architecture/body-dto-validation.architecture.spec.ts that
  reflects over every controller (ROUTE_ARGS_METADATA + design:paramtypes) and fails any @Body whose
  metatype is Object/undefined or has no class-validator metadata in getMetadataStorage() — making
  the whole class of silent-bypass endpoints detectable at test time across the service.
  Verification: that architecture spec plus controller e2e cases asserting 400 on garbage amounts
  and on unknown extra fields.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-types.ts`
  - `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts`
  - `apps/admin-api-service/src/__tests__/architecture/body-dto-validation.architecture.spec.ts`
- **Effort:** M

### APA-095 [MEDIUM] Multi-currency amounts are summed into single totals and always rendered as USD

- **Status:** DESIGNED (brief)
- **Symptom:** Invoices can be created in USD/EUR/GBP/TRY (CreateInvoiceModal currency select;
  billing.invoices.currency column), but InvoiceManagementService.getStats SUMs total/amount_paid
  across all currencies into one number, the byCurrency breakdown it computes is ignored by the FE,
  and every stats card formats with hardcoded USD. AnalyticsService likewise hardcodes byCurrency =
  { USD: mrr } with a 'single-currency tenancy' comment while the invoice UI actively offers four
  currencies — cross-currency addition produces meaningless platform totals the moment one non-USD
  invoice exists.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts:308-333 (SUM without currency partition in totals)`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx:39-44,400-415 (formatCurrency defaults USD for stats)`
  - `web/modules/admin-panel/src/components/CreateInvoiceModal.tsx:300-311 (EUR/GBP/TRY offered)`
  - `apps/admin-api-service/src/analytics/services/analytics.service.ts:537 (byCurrency hardcoded USD)`
- **Root cause:** The stats contracts drop the currency dimension: InvoiceManagementService.getStats
  SUMs total/amount_paid across all currencies (invoice-management.service.ts:308-351) and its
  byCurrency side-channel is never consumed (InvoicesPage declares its own local InvoiceStats
  without byCurrency and formats everything as USD at 400-415); AnalyticsService hardcodes
  byCurrency = { USD: mrr } (analytics.service.ts:537) while CreateInvoiceModal actively offers
  USD/EUR/GBP/TRY. One non-USD invoice makes every platform total meaningless. Systemic class:
  scalar money aggregates without a currency key.
- **Fix design:** Make cross-currency addition impossible at the contract level (tier 1): change
  every monetary aggregate to be currency-partitioned. InvoiceStats becomes { totalInvoices,
  avgPaymentDays, byCurrency: Record<string, { totalAmount; totalPaid; totalPending; totalOverdue;
  paidThisMonth; pendingThisMonth }> } produced by GROUP BY currency, status SQL (remove the
  currency-less SUM columns so no scalar total exists to misuse); the new payment stats (p2|i2) uses
  the same shape; AnalyticsService derives byCurrency from the actual subscription/invoice currency
  columns instead of the literal, and its scalar mrr/totalRevenue fields are kept only per-currency.
  FE: delete InvoicesPage's local duplicate InvoiceStats, import the shared type from
  services/types/billing.ts, and render stats per currency (single card when one currency exists,
  stacked per-currency rows otherwise) with formatCurrency(amount, currency) — remove default-'USD'
  at aggregate call sites in InvoicesPage, PaymentsPage, BillingReportsPage. Verification: extend
  the invoice-management/analytics service specs with a two-currency fixture asserting the response
  contains no cross-currency scalar total; FE page tests assert per-currency rendering; npm run
  type-check fails any consumer still reading the old scalar fields.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/invoice-management.service.ts`
  - `apps/admin-api-service/src/billing/services/payment-management.service.ts`
  - `apps/admin-api-service/src/analytics/services/analytics.service.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/services/types/analytics.ts`
  - `web/modules/admin-panel/src/pages/InvoicesPage.tsx`
  - `web/modules/admin-panel/src/pages/PaymentsPage.tsx`
  - `web/modules/admin-panel/src/pages/BillingReportsPage.tsx`
- **Effort:** L

### APA-096 [LOW] FE double-submit CSRF token is decorative — admin-api never sets or verifies XSRF-TOKEN

- **Status:** DESIGNED (brief)
- **Symptom:** http-client.ts attaches X-CSRF-Token from an XSRF-TOKEN cookie on all mutations and
  documents that 'the server set this cookie and will reject mutating requests whose header does not
  match', but admin-api-service and the shared bootstrap contain no CSRF middleware — the only
  reference is a CORS header example. Auth is Bearer-token so practical CSRF risk is low, yet the FE
  comment claims a server-side control that does not exist, which can mask a future regression if
  cookie-based auth is ever added.
- **Evidence:**
  - `web/modules/admin-panel/src/services/http-client.ts:96-106,256-263 (token read + claim of server enforcement)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:558 (only CSRF mention is a CORS header example; no middleware)`
- **Root cause:** http-client.ts ships the client half of double-submit CSRF (reads XSRF-TOKEN
  cookie, sends X-CSRF-Token on mutations) with comments asserting the server sets the cookie and
  rejects mismatches — but no backend code sets or verifies either: the only csrf/xsrf hits in
  admin-api-service and backend-common are a CORS-header doc example, a security-event enum value,
  and a test comment. The control is dead code documenting a nonexistent guarantee.
- **Fix design:** Eliminate the half-state; pick one truthful state. Primary (auth is Bearer-header,
  so CSRF is structurally inapplicable to admin-api mutations): remove getCsrfTokenFromCookie, the
  CSRF_PROTECTED_METHODS block and both false comments from http-client.ts, replacing them with an
  accurate note that admin-api auth is Authorization-header-only and any future cookie-authenticated
  route must add server-side CSRF middleware first. Alternative (only if cookie-auth is planned):
  implement real double-submit in libs/backend-common (middleware issuing XSRF-TOKEN and verifying
  X-CSRF-Token on state-changing methods, opt-in via createServiceApp) and enable it for admin-api —
  then the FE code becomes correct as-is. Verification: for the removal path, an http-client unit
  spec asserting mutation requests carry no X-CSRF-Token header and a grep-style invariant that no
  XSRF-TOKEN reference remains in admin-panel; for the implement path, an e2e case asserting a
  mutating request with a mismatched token is rejected.
- **Files to change:**
  - `web/modules/admin-panel/src/services/http-client.ts`
- **Effort:** S

### APA-097 [LOW] Positive verification: auth, routing and envelope chain are sound for this section

- **Status:** DESIGNED (brief)
- **Symptom:** Recorded for audit completeness: every billing/analytics endpoint sits behind the
  global APP*GUARD PlatformAdminGuard (RS256 verifyAsync, SUPER_ADMIN role required, roles cannot be
  widened by decorators) plus per-route @ThrottleSensitive on money mutations; nginx rewrites /api/*
  to /api/v1/\_ matching the global prefix + VERSION_NEUTRAL versioning; the ResponseInterceptor
  envelope is correctly unwrapped by the FE http-client; NATS write path keeps billing-service as
  single writer with audited RLS bypass, idempotent receipts, pessimistic locks, transactional
  outbox events, and real Stripe refunds keyed idempotently. No unguarded endpoint or route mismatch
  was found in this section.
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:283-290 (APP_GUARD PlatformAdminGuard + ThrottlerGuard)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:151-177 (SUPER_ADMIN enforcement)`
  - `infrastructure/nginx/droplet.conf:377-385 (rewrite /api -> /api/v1)`
  - `apps/billing-service/src/billing/handlers/refund-payment.handler.ts:76-86 (real Stripe refund with idempotency key)`
- **Root cause:** Not a defect — positive assurance record. Spot-checked and accurate: APP_GUARD
  wiring via useExisting PlatformAdminGuard + ThrottlerGuard (app.module.ts:278-290), SUPER_ADMIN
  enforcement in the guard, nginx /api -> /api/v1 rewrite matching globalPrefix + VERSION_NEUTRAL,
  envelope unwrap in the FE http-client, and the billing-service single-writer NATS path with
  idempotent Stripe refunds all hold as described.
- **Fix design:** No change required. Retain the entry in the audit log as the section's positive
  verification baseline; any future finding that contradicts it must cite which of these controls
  regressed.
- **Effort:** S

---

## Finding registry anchors

Registry IDs (`docs/reviews/_registry/findings.jsonl`) tracking findings in this document:

- **ADMIN-MEDIUM-029** — APA-087: GET /billing/payments read filters as raw `@Query` strings and
  cast `invoiceId`/`tenantId` as `::uuid`, so a non-UUID free-text keystroke raised Postgres 22P02 →
  500 and flipped the Payments page to its error state. Fixed by binding the request to a validated
  `ListPaymentsQueryDto` (`@IsUUID` ids, typed dates/limit) so malformed input is a 400 at the
  boundary, extending the service `search` to match `invoice_number` (join added to the count
  query), and repointing the FE free-text box to a debounced `search` via `useFilters` with
  `invoiceId` demoted to a read-only URL deep-link. Proven by a ValidationPipe DTO spec
  (`invoiceId=abc` → 400), a service search spec, and a `PaymentsPage` spec (typing a non-UUID never
  flips to the error state).
