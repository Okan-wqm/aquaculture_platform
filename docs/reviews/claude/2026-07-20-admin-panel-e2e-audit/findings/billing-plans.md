# Billing Plans/Subscriptions/Discounts/Usage — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## SubscriptionManagementPage — `/admin/billing/subscriptions` — verdict: **PARTIAL**

**Chain:** List/stats are real: FE -> GET /api/billing/subscriptions + /stats -> BillingController (global PlatformAdminGuard, RS256 JWT + SUPER_ADMIN, app.module.ts:283-290) -> SubscriptionCoreService/SubscriptionAnalyticsService raw SQL on billing.subscriptions LEFT JOIN auth.tenants (subscription-core.service.ts:78-161). Mutations (cancel/reactivate/extend-trial) go admin-api -> NATS request-reply (BillingAdminCommandClientService) -> billing-service BillingAdminNatsHandler -> real UPDATE billing.subscriptions under audited RLS bypass (billing-admin-nats.handler.ts:362-474). The Process Renewals button is a dead end by design on the backend and fails silently on the FE.

**Endpoints exercised:** `GET /billing/subscriptions`; `GET /billing/subscriptions/stats`; `POST /billing/subscriptions/tenant/:tenantId/cancel`; `POST /billing/subscriptions/tenant/:tenantId/reactivate`; `POST /billing/subscriptions/tenant/:tenantId/extend-trial`; `POST /billing/subscriptions/process-renewals`

**DB tables:** `billing.subscriptions`, `auth.tenants`, `billing.invoices`

### APA-098 [MEDIUM] Process Renewals button always fails, silently

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** The controller unconditionally throws ConflictException ('renewal processing is billing-service-owned') for POST /billing/subscriptions/process-renewals, and the FE fires it as a floating promise with no await/error handling, so every click produces an unhandled 409 with zero user feedback. There is no billing-service NATS subject for renewals either, so the feature has no working path.
- **Evidence:**
  - `apps/admin-api-service/src/billing/billing.controller.ts:417-424 (processRenewals(): never { throw new ConflictException(...) })`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx:166 (onClick={() => billingApi.processRenewals()} — not awaited, no catch)`
- **Verification:** Confirmed end-to-end. (1) apps/admin-api-service/src/billing/billing.controller.ts:417-424 unconditionally throws ConflictException for POST /billing/subscriptions/process-renewals; the request is reachable (nginx /api->/api/v1, PlatformAdminGuard passes for SUPER_ADMIN, ThrottleSensitive only rate-limits) so every click returns 409. The tombstone repeats at SubscriptionRenewalService.processRenewals(): never (subscription-renewal.service.ts:171-175). (2) SubscriptionManagementPage.tsx:166 fires billingApi.processRenewals() as a floating promise into onClick; apiFetch (services/http-client.ts:309-311) throws on 4xx with no retry and there is no global error UI, so the rejection is unhandled — zero user feedback. Lint misses it because the admin-panel per-project block sets no-floating-promises/no-misused-promises to 'off' (eslint.project-overrides.mjs:2050-2052, a preserved root:true-era quirk). (3) BILLING_ADMIN_COMMAND_SUBJECTS (libs/event-contracts/src/billing-admin-commands.ts) has no renewal subject and BillingAdminNatsHandler has no renewal MessagePattern — no working path exists. Severity lowered HIGH->MEDIUM: the renewal business function is NOT broken — billing-service's BillingSchedulerService runs the whole lifecycle automatically (hourly trial/subscription-expiry crons, daily overdue detection, monthly auto-invoice + period advance, advisory-locked and idempotent). The defect is a dead, silently-failing admin affordance producing operator false confidence — no revenue/data/security impact. Stale mock at billing.controller.spec.ts:84 (processRenewals mockResolvedValue) confirms contract drift in tests too.
- **Root cause:** The FE->BE contract link broke during the billing single-writer remediation: admin-api's direct billing.* writes were migrated to NATS request-reply commands (BILLING_ADMIN_COMMAND_SUBJECTS + BillingAdminNatsHandler) for cancel/reactivate/extend-trial/change-plan, while renewal processing was moved into billing-service cron automation (BillingSchedulerService) with NO admin command equivalent — a deliberate ownership decision. But the decommissioning stopped halfway at the HTTP boundary: instead of deleting the route, the controller and SubscriptionRenewalService.processRenewals were converted into throwing tombstones, and the FE surface (billingApi.processRenewals + the always-visible Process Renewals button) was never removed. Two missing gates let the drift persist: (a) no FE<->BE route-contract test exists, so an admin-panel api fn can point at a dead/tombstoned route indefinitely; (b) the admin-panel ESLint block switches off the platform-wide floating-promise ban (no-floating-promises/no-misused-promises 'off' in eslint.project-overrides.mjs — documented quirk, ORPHAN-HIGH-093/094 family), so the onClick floating promise that swallows the deliberate 409 also passes lint.
- **Fix design:** This is an instance of two systemic classes — 'FE affordance wired to a decommissioned backend route' and 'silent-failure floating promise in admin-panel' — so the fix is local removal plus two pattern-level gates. LOCAL (root cause: remove the dead contract, do not resurrect it — billing-service owns renewals automatically and doctrinally): delete the processRenewals() tombstone route from billing.controller.ts (the URL then 404s at the router instead of impersonating an endpoint); delete the dead chain SubscriptionManagementService.processRenewals() and SubscriptionRenewalService.processRenewals() plus the equally-unreferenced markAsPastDue/suspendForNonPayment tombstones in subscription-renewal.service.ts; delete billingApi.processRenewals from web/modules/admin-panel/src/services/api/billing.ts and the Process Renewals button from SubscriptionManagementPage.tsx (TypeScript then makes any leftover reference a compile error — Tier 1); remove the stale processRenewals mock from billing.controller.spec.ts:84. If product later requires an on-demand sweep, it must be a NEW tracked feature via the established path: BILLING_ADMIN_COMMAND_SUBJECTS.PROCESS_RENEWALS + platform-event-registry entry + fixture + BillingAdminNatsHandler MessagePattern invoking the same idempotent advisory-locked scheduler routine, admin-api forwarding, FE awaiting with success/error feedback. PATTERN GATE A (Tier 3, kills the whole dead-route class): new spec apps/admin-api-service/src/__tests__/integration/admin-panel-route-contract.spec.ts that extracts every apiFetch('<path>', {method}) literal from web/modules/admin-panel/src/services/api/*.ts and asserts each (method,path) resolves against the Nest route map introspected from the compiled AppModule — zero allowlist entries; it fails today on process-renewals and passes after removal. PATTERN GATE B (Tier 3, kills the silent-failure class): in eslint.project-overrides.mjs admin-panel block, set '@typescript-eslint/no-floating-promises': 'error' and '@typescript-eslint/no-misused-promises': ['error', {checksVoidReturn: {attributes: true}}] so promise-returning onClick handlers become lint errors; fix all surfaced violations in the module and update the parity baseline in tools/lint-gates/eslintrc-flat-parity.spec.ts (the migration doc explicitly designates these quirks as fixed-separately work; close with a tracked finding ID per repo discipline).
- **Files to change:**
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/subscription-management.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-renewal.service.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `eslint.project-overrides.mjs`
  - `tools/lint-gates/eslintrc-flat-parity.spec.ts`
  - `apps/admin-api-service/src/__tests__/integration/admin-panel-route-contract.spec.ts`
- **Proof of fix:** Add apps/admin-api-service/src/__tests__/integration/admin-panel-route-contract.spec.ts: parse every endpoint literal in web/modules/admin-panel/src/services/api/*.ts and assert each (method, path) matches a registered route in the compiled admin-api Nest router (Test.createTestingModule + route introspection), no allowlist — it must FAIL on the current tree (process-renewals has no live route semantics) and PASS after removal, permanently gating the dead-route class. Extend billing.controller.spec.ts to drop the stale processRenewals mock (compile fails if the route lingers). Lint gate: after enabling no-floating-promises + no-misused-promises (checksVoidReturn.attributes: true) for admin-panel in eslint.project-overrides.mjs, `nx lint admin-panel` must flag any onClick={() => somePromise()} (add a firing fixture to tools/lint-gates/lint-gates.spec.ts), and tools/lint-gates/eslintrc-flat-parity.spec.ts baseline updated and green. Full check: nx affected --target=test && nx affected --target=lint green.
- **Effort:** M

### APA-099 [NOT_A_BUG] monthlyPrice column shows per-cycle price labeled as '/mo'

- **Status:** REFUTED
- **Symptom:** SubscriptionCoreService aliases (pricing->>'basePrice') as monthlyPrice, but basePrice in billing.subscriptions.pricing is the per-billing-cycle amount — the analytics service divides it by 3/6/12 to compute MRR for quarterly/semi-annual/annual cycles. The page renders formatCurrency(sub.monthlyPrice)+'/mo', so an annual subscription displays its full annual price as a monthly price — silent wrong financial data.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/subscription-core.service.ts:89 ((s.pricing->>'basePrice')::decimal as "monthlyPrice")`
  - `apps/admin-api-service/src/billing/services/subscription-analytics.service.ts:80-91 (MRR divides basePrice by cycle months, proving it is per-cycle)`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx:332 ({formatCurrency(sub.monthlyPrice)}/mo)`
- **Refutation:** The finding's premise — that pricing.basePrice is the per-billing-cycle amount — is refuted by the schema owner's own code. billing-service (owner of billing.subscriptions, D14 SSoT for subscription state) writes and bills basePrice as the MONTHLY recurring charge: (1) the production tenant-provisioning writer (apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:655-661) explicitly comments "basePrice is the recurring monthly charge the invoice scheduler bills off" and writes basePrice = moduleItemsMonthlyTotal; (2) the live invoice scheduler (apps/billing-service/src/billing/billing-scheduler.service.ts:289-305, registered in billing.module.ts:122 with @Cron jobs) MULTIPLIES basePrice by cycleMonths when invoicing quarterly/semi-annual/annual periods — if basePrice were per-cycle this would 12x-over-bill annual tenants, so the money-authoritative path proves monthly semantics; (3) the GraphQL create path (create-subscription.handler.ts:38-60,204) applies monthly-denominated MIN_PRICES floors (49/149/499, matching the all-MONTHLY plan catalog in plan-seed.service.ts) regardless of billingCycle and emits the platform event field literally named monthlyPrice (libs/event-contracts/src/billing-events.ts:41) as input.pricing.basePrice; (4) change-subscription-plan.handler.ts:250 does the same. Therefore SubscriptionCoreService's alias (pricing->>'basePrice') as "monthlyPrice" and the FE '/mo' label (web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx:332, type web/modules/admin-panel/src/services/types/billing.ts:217) render the correct number, and the asserted failure (annual total displayed as monthly) is unreachable through any sanctioned writer. The auditor's sole proof — the divide-by-3/6/12 in subscription-analytics.service.ts:80-91 — is itself the drifted code, not evidence of DB semantics: that divide (also present in apps/admin-api-service/src/analytics/services/analytics.service.ts:565-575 and apps/billing-service/src/billing/query-handlers/get-tenant-billing.handler.ts:271-285) UNDERSTATES MRR/ARR/tenant monthly price for non-monthly cycles — the inverse bug, in different files, with the opposite failure direction. That divergent-reader defect (systemic class: one JSONB money field consumed with contradictory unit semantics because PlanPricing.basePrice encodes no unit in its type or name — fixable at the source with a unit-explicit pricing contract, e.g. monthlyBasePrice plus a single shared cycle-conversion helper, guarded by an invariant spec that greps for divide-by-cycle reads of basePrice) deserves its own finding; the finding under adjudication as stated is not a bug.

### APA-100 [MEDIUM] Cancel leaves status 'active' — UI appears to have failed

- **Status:** DESIGNED (brief)
- **Symptom:** The FE never sends cancelImmediately, so billing-service keeps status=subscription.status (unchanged), only setting auto_renew=false and end_date. After a successful cancel the reloaded row still shows ACTIVE with a Cancel button and no Reactivate (which requires status CANCELLED), so the operator cannot tell the cancel worked and cannot reactivate an end-of-period cancel.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/billing.ts:118-122 (body only {reason})`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:369-386 (status stays subscription.status when !cancelImmediately)`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx:359-380 (Reactivate only when status === CANCELLED)`
- **Root cause:** The cancellation contract is only half-plumbed: admin-api's CancelSubscriptionDto already accepts cancelImmediately (apps/admin-api-service/src/billing/billing.controller.ts:385-394) and billing-service implements both modes, but the FE api fn sends only {reason} (web/modules/admin-panel/src/services/api/billing.ts:118-122) and the page has no way to choose. For the default end-of-period path, billing-service keeps status unchanged (billing-admin-nats.handler.ts:386) — a correct domain state — but the FE renders pending-cancellation as plain ACTIVE (it ignores the cancelledAt field that SubscriptionOverview already carries on both sides), and billing-service reactivate rejects anything not status=CANCELLED (handler line 414), so an end-of-period cancel is invisible and irreversible in the UI.
- **Fix design:** Complete the contract on all three legs, no new fields needed on the read side (cancelledAt already exists in both SubscriptionOverview types). (1) FE: cancel modal gains an explicit choice (radio: 'At period end' default / 'Immediately'); billingApi.cancelSubscription signature becomes (tenantId, reason, cancelImmediately) and sends it in the body — drop the dead _cancelledBy param. (2) FE rendering: derive a pending-cancellation state (status ACTIVE/TRIAL && cancelledAt set) — render a 'CANCELS <formatDate(currentPeriodEnd)>' badge instead of the bare ACTIVE badge, hide the Cancel button, show Reactivate. (3) billing-service: reactivateSubscription accepts both terminal CANCELLED and pending-cancel (cancelled_at NOT NULL with active/trial status), clearing cancelled_at/cancellation_reason/end_date and restoring auto_renew; reject only rows with no cancellation state. Verification: extend apps/billing-service/src/billing/handlers/__tests__/billing-admin-nats.handler.spec.ts (reactivate of pending-cancel row succeeds; untouched row rejected) and add a SubscriptionManagementPage test asserting the pending-cancel row shows the cancels-on badge + Reactivate and that the modal sends cancelImmediately.
- **Files to change:**
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts`
  - `apps/billing-service/src/billing/handlers/__tests__/billing-admin-nats.handler.spec.ts`
- **Effort:** M

### APA-101 [LOW] Search refetches subscriptions+stats on every keystroke

- **Status:** DESIGNED (brief)
- **Symptom:** useEffect depends on `search` with no debounce, firing both getSubscriptions and getSubscriptionStats per character typed.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx:43-59`
- **Root cause:** SubscriptionManagementPage.tsx:43-45 puts raw `search` in the useEffect deps and loadData fires BOTH getSubscriptions and getSubscriptionStats in one Promise.all, so every keystroke issues two requests; stats do not depend on any filter at all.
- **Fix design:** Two-part: (a) split stats out of loadData into its own effect that runs on mount and after mutations (cancel/reactivate/extend-trial) — stats never depend on search/filter/page; (b) debounce the query input at the pattern level: add a reusable useDebouncedValue(value, 300) hook under web/modules/admin-panel/src/hooks/ (several admin pages share this search-refetch shape) and drive the list effect from the debounced value while the input stays controlled by the raw state. Verification: a hooks test for useDebouncedValue plus a page test with fake timers asserting typing 5 chars produces one getSubscriptions call and zero extra getSubscriptionStats calls.
- **Files to change:**
  - `web/modules/admin-panel/src/hooks/useDebouncedValue.ts`
  - `web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx`
- **Effort:** S


## PlanManagementPage — `/admin/billing/plans` — verdict: **PARTIAL**

**Chain:** Read/seed/deprecate are real: GET /billing/plans?includeInactive -> PlanDefinitionService -> admin.plan_definitions (entity declares schema 'admin', table created in Baseline migration). Seed and deprecate persist. But there is no create/edit UI (the Create button is dead), and — see cross-cutting — this catalog is not the one billing-service uses to provision subscriptions, so the page manages a shadow catalog.

**Endpoints exercised:** `GET /billing/plans?includeInactive=true`; `POST /billing/plans/seed`; `POST /billing/plans/:id/deprecate`

**DB tables:** `admin.plan_definitions`

### APA-102 [HIGH] 'Create New Plan' button has no handler — plan create/update never wired

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The primary CTA renders with no onClick; there is no create or edit form anywhere in the page, so POST /billing/plans and PUT /billing/plans/:id (both implemented server-side) are unreachable from the UI. Plan CRUD from this page is limited to seed + deprecate.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/PlanManagementPage.tsx:123 (<Button variant="primary">Create New Plan</Button> — no onClick)`
  - `apps/admin-api-service/src/billing/billing.controller.ts:141-154 (createPlan/updatePlan exist but unused by this page)`
- **Verification:** Confirmed. web/modules/admin-panel/src/pages/PlanManagementPage.tsx:123 renders <Button variant="primary">Create New Plan</Button> with no onClick, no form, no Link — a silent no-op. The Details modal (lines 258-415) is read-only; card actions are only Details/Deprecate. Module.tsx:131 shows billing/plans is the only route to this page. billingApi.createPlan/updatePlan exist (services/api/billing.ts:48-51) but a repo-wide grep of web/ finds ZERO call sites — the graphql-types.ts createPlan hits are the unrelated HR weekly-plan domain. Backend POST /billing/plans and PUT /billing/plans/:id (billing.controller.ts:141-154) are real, guarded, and stranded. Severity HIGH stands: the page's stated purpose ("Configure subscription plans, pricing, and features") is unachievable — plan CRUD is limited to seed+deprecate, and the primary CTA misleads operators by doing nothing. Additional grounded facts shaping remediation: CreatePlanDto/UpdatePlanDto are plain TS interfaces (plan-definition.service.ts:16-57) so the global ValidationPipe skips them (interface metatype erases to Object) — an instance of the unvalidated-interface-DTO systemic class; and the FE fns accept Partial<PlanDefinition>, the FE-type-drift class, which would trigger forbidNonWhitelisted 400s the moment real DTO classes exist.
- **Root cause:** The FE service layer (services/api/billing.ts) was scaffolded to mirror the full backend controller surface, but the view layer was only half-built: the Create/Edit form was never implemented and the CTA shipped as static markup. The FE->BE chain broke at the view->service link. It drifted silently because nothing in the build detects (a) an exported api function with zero consumers or (b) a handler-less primary CTA — this is an instance of the systemic class "BE endpoint + FE api fn with no UI consumer / dead CTA", compounded by the unvalidated-interface-DTO class on the backend (CreatePlanDto/UpdatePlanDto are interfaces, so the whitelist ValidationPipe never runs on these bodies) and weak FE typing (Partial<PlanDefinition> instead of a dedicated input contract).
- **Fix design:** Fix the contract at the source plus the missing UI, and gate the systemic class. (1) UI: add PlanFormModal.tsx in web/modules/admin-panel/src/components/ (precedent: CreateInvoiceModal.tsx in same dir), one component with create|edit modes: create exposes code+tier (immutable in edit, matching UpdatePlanDto which omits them), plus name, descriptions, visibility, isRecommended, sortOrder, nested limits/pricing (monthly basePrice/perUser/perFarm/perModule per the page's monthly-only model)/features arrays, trialDays, gracePeriodDays, badge/icon/color; in create mode prefill limits from billingApi.getDefaultLimitsForTier(tier) on tier select (endpoint + FE fn already exist). Wire PlanManagementPage: "Create New Plan" opens create mode; add an Edit button beside Deprecate on each card opening edit mode prefilled; on submit call billingApi.createPlan/updatePlan then loadPlans(). (2) Contract (tier-1, make wrong payloads impossible): convert CreatePlanDto/UpdatePlanDto from interfaces in plan-definition.service.ts into class-validator classes in apps/admin-api-service/src/billing/dto/billing.dto.ts (where every other billing DTO lives) with @ValidateNested()+@Type() classes for PlanLimits/PlanPricing/PlanFeatures; createdBy/updatedBy are NOT DTO fields (controller already injects userId from JWT via {...dto, createdBy: userId}); service signature becomes create(dto: CreatePlanDto & { createdBy: string }). This activates the platform whitelist+forbidNonWhitelisted pipe on these routes for the first time. (3) FE types: replace Partial<PlanDefinition> in services/api/billing.ts:48-51 with exported CreatePlanInput/UpdatePlanInput in services/types/billing.ts mirroring the DTO exactly (no id/audit/server-managed fields), so the compiler prevents the form from posting fields the pipe now rejects. (4) Pattern-level gate (tier-3, detectable): new invariant spec tests/invariants/admin-panel-api-consumption.spec.ts (repo convention alongside federation-shared-singleton.spec.ts) that statically walks exported method names of web/modules/admin-panel/src/services/api/* and fails when any has zero call sites outside services/ — this gate is red on today's code (createPlan/updatePlan stranded) and catches the whole endpoint-with-no-consumer class going forward. No defensive code, no shims; the DTO/type work is the same contract expressed once per layer.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/PlanManagementPage.tsx`
  - `web/modules/admin-panel/src/components/PlanFormModal.tsx`
  - `web/modules/admin-panel/src/components/index.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `web/modules/admin-panel/src/pages/__tests__/PlanManagementPage.spec.tsx`
  - `tests/invariants/admin-panel-api-consumption.spec.ts`
- **Proof of fix:** (1) New RTL spec web/modules/admin-panel/src/pages/__tests__/PlanManagementPage.spec.tsx (pattern: existing CreateTenantPage.spec.tsx): clicking "Create New Plan" opens the form; valid submit calls billingApi.createPlan with a payload containing no id/createdBy/isActive and reloads the list; Edit flow calls billingApi.updatePlan(id, ...). (2) Extend apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts plus a ValidationPipe-mounted e2e test: POST /billing/plans with an unknown field returns 400 (proves the interface->class DTO conversion actually activated whitelist validation — fails on current code where validation is skipped), missing required code/name/tier/limits/pricing/features returns 400, valid body persists with createdBy taken from the JWT not the body. (3) New tests/invariants/admin-panel-api-consumption.spec.ts fails whenever an exported services/api/* function has zero consumers — red before this fix (createPlan/updatePlan), green after, permanently gating the systemic class.
- **Effort:** M

### APA-103 [MEDIUM] POST/PUT /billing/plans bodies are completely unvalidated

- **Status:** DESIGNED (brief)
- **Symptom:** CreatePlanDto/UpdatePlanDto are TypeScript interfaces exported from the service, so the global ValidationPipe (whitelist+forbidNonWhitelisted) skips them (metatype Object). Arbitrary nested limits/pricing/features JSON is persisted as-is into jsonb columns.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts:16-57 (export interface CreatePlanDto / UpdatePlanDto)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-460 (whitelist/forbidNonWhitelisted defaults only apply to class metatypes)`
- **Root cause:** CreatePlanDto/UpdatePlanDto are TS interfaces exported from plan-definition.service.ts:16-57, so the reflected @Body metatype is Object and the global ValidationPipe (whitelist+forbidNonWhitelisted) skips them entirely — arbitrary nested limits/pricing/features JSON persists into the jsonb columns. This is one instance of a systemic class in billing.controller.ts: CreateDiscountCodeDto, UpdateDiscountCodeDto, PlanChangeRequest, and SetModulePricingDto (finding p3|i0) are interface-typed @Body params too.
- **Fix design:** Pattern-level fix (tier 3 gate + tier 1 local). Local: move the plan write contracts into class-validator classes in apps/admin-api-service/src/billing/dto/billing.dto.ts — CreatePlanDto/UpdatePlanDto classes with fully validated nested DTOs (PlanLimitsDto mirroring the entity PlanLimits with @IsInt/@IsBoolean per field, PlanPricingDto with per-cycle PlanCyclePricingDto {@IsNumber @Min(0) prices, @Min(0)@Max(100) discountPercent}, PlanFeaturesDto with @IsString({each:true}) arrays and @ValidateNested add-ons), all wired with @ValidateNested + @Type; the service keeps its interfaces (the classes implement them) or imports the class types — no `as` casts. Do the same conversion for CreateDiscountCodeDto/UpdateDiscountCodeDto/PlanChangeRequest bodies. Systemic gate: new invariant tests/invariants/admin-body-dto-class.spec.ts scanning apps/admin-api-service/src/**/*.controller.ts, extracting every `@Body() x: T` type identifier and asserting T resolves to an `export class` declaration in a dto/ file (no allowlist), so an interface-typed @Body can never reappear. Verification: that invariant spec plus a controller e2e-style test asserting a plan create with an unknown nested key or negative price is rejected 400.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `tests/invariants/admin-body-dto-class.spec.ts`
- **Effort:** M

### APA-104 [LOW] FE PlanLimits type drifts from backend PlanLimits

- **Status:** DESIGNED (brief)
- **Symptom:** FE declares apiCallsPerMonth/customReports/advancedAnalytics/apiAccess/whiteLabeling; backend has apiRateLimit/reportsEnabled/customBrandingEnabled/apiAccessEnabled/maxModules/alertsEnabled/auditLogEnabled/dedicatedAccountManager. The page renders limits via Object.entries so nothing crashes, but any typed access to the phantom fields would be undefined.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/billing.ts:96-111`
  - `apps/admin-api-service/src/billing/entities/plan-definition.entity.ts:40-58`
- **Root cause:** FE PlanLimits (web/modules/admin-panel/src/services/types/billing.ts:96-111) was hand-written against an older shape (apiCallsPerMonth/customReports/advancedAnalytics/apiAccess/whiteLabeling) and never updated to the backend PlanLimits (plan-definition.entity.ts:40-58: apiRateLimit/reportsEnabled/customBrandingEnabled/apiAccessEnabled/maxModules/alertsEnabled/auditLogEnabled/dedicatedAccountManager/etc.); the `[key: string]: number | boolean` index signature masks the drift from the compiler, and unlike PlanTier there is no FE-parity invariant pinning it.
- **Fix design:** Rewrite the FE PlanLimits member-for-member to the backend interface and DELETE the index signature (the signature is what makes drift type-invisible — removing it makes any future phantom-field access a compile error, tier 1). Fix any FE usages that referenced phantom keys (pages render via Object.entries; grep shows no typed access to the phantom fields in billing pages — TenantConfigurationPage uses a separate tenant-config type, untouched). Systemic gate: add a parity invariant following the existing tier-enum-ssot.spec.ts mirror-pin pattern — tests/invariants/plan-limits-fe-parity.spec.ts parses the property names of PlanLimits in apps/admin-api-service/src/billing/entities/plan-definition.entity.ts and web/modules/admin-panel/src/services/types/billing.ts and asserts set equality (web modules cannot import backend libs, so mirror-pin is the established mechanism). Verification: that spec fails today, passes after the rewrite; npm run type-check stays green.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `tests/invariants/plan-limits-fe-parity.spec.ts`
- **Effort:** S

### APA-105 [LOW] console.error used (banned by repo lint rules)

- **Status:** DESIGNED (brief)
- **Symptom:** loadPlans catch logs via console.error; repo standard is structured logging / no console.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/PlanManagementPage.tsx:38`
- **Root cause:** PlanManagementPage.tsx:38 calls console.error, but the true root cause is that admin-panel's per-project lint policy sets no-console: 'off' (eslint.project-overrides.mjs, web/modules/admin-panel block) — a faithfully-preserved legacy quirk from the flat-config migration — so ~40 console.* callsites exist across the module and nothing stops new ones.
- **Fix design:** Fix the gate, not just the line (tier 3). Flip no-console to ['error'] in the admin-panel block of eslint.project-overrides.mjs as a deliberate policy change (the flat-parity harness compares against the ESLint-8 golden, so update the golden alongside per its documented process), then remove every console.* callsite in web/modules/admin-panel/src — at each site the error is already surfaced via setError/UI state, so deletion is the correct fix; the one non-page site (hooks/useAsyncData.ts:252) routes through the hook's existing error state. Local instance: delete the console.error in PlanManagementPage.tsx loadPlans (setError already carries the failure). Verification: `nx lint admin-panel` (now enforcing no-console) is the invariant — no bespoke spec needed once the rule is on.
- **Files to change:**
  - `eslint.project-overrides.mjs`
  - `web/modules/admin-panel/src/pages/PlanManagementPage.tsx`
  - `web/modules/admin-panel/src/hooks/useAsyncData.ts`
  - `web/modules/admin-panel/src/pages/TenantConfigurationPage.tsx`
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx`
  - `web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx`
- **Effort:** M


## DiscountCodePage — `/admin/billing/discounts` — verdict: **BROKEN**

**Chain:** Backend chain is real (admin.discount_codes / admin.discount_redemptions, Baseline migration DDL matches the entity), and stats/create/deactivate work. But the primary listing is structurally broken: DiscountCodeService.findAll returns {data,total,page,limit}, the ResponseInterceptor lifts total/page/limit into meta, the FE http-client sees meta.page and returns {data:[...],...meta} — an object — and the page discards anything that is not an array, so the table is permanently empty regardless of DB contents.

**Endpoints exercised:** `GET /billing/discounts`; `GET /billing/discounts/stats`; `POST /billing/discounts`; `POST /billing/discounts/generate-code`; `POST /billing/discounts/:id/deactivate`

**DB tables:** `admin.discount_codes`, `admin.discount_redemptions`

### APA-106 [CRITICAL] Discount code table is always empty — triple envelope/shape mismatch

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** findAll returns {data,total,page,limit}; ResponseInterceptor detects 'data'+'total' and re-wraps as {success,data:[...],meta:{page,...}}; apiFetch sees meta.page and returns {data:[...],total,page,limit,...} (an object, not an array); the page then does Array.isArray(codesResult) ? codesResult : [] and always lands on []. Every created code persists to admin.discount_codes but can never be listed, deactivated, or inspected from this page — the primary flow is dead.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:108-142 (returns { data, total, page, limit })`
  - `apps/admin-api-service/src/shared/response.interceptor.ts:46-65 (lifts to meta when 'data' and 'total' present)`
  - `web/modules/admin-panel/src/services/http-client.ts:343-349 (returns { data, ...meta } when meta.page exists)`
  - `web/modules/admin-panel/src/pages/DiscountCodePage.tsx:60 (setDiscountCodes(Array.isArray(codesResult) ? codesResult : []))`
- **Verification:** Adversarial verification FAILED to refute — every link is confirmed in current code with no escape hatch. (1) BillingController @Get('discounts') (apps/admin-api-service/src/billing/billing.controller.ts:190-205) returns DiscountCodeService.findAll unchanged, which always returns { data, total, page, limit } with page defaulting to 1 (discount-code.service.ts:108-142). (2) ResponseInterceptor is registered as a global APP_INTERCEPTOR (app.module.ts:291-294); its branch fires whenever 'data' AND 'total' keys exist (response.interceptor.ts:46-65), producing { success:true, data:[...], meta:{ total, page, limit, totalPages, timestamp } } — meta.page is always a number here. (3) apiFetch (web/modules/admin-panel/src/services/http-client.ts:341-349) parses the envelope and, because 'page' is in meta, returns { data:[...], ...meta } — an OBJECT — while billingApi.getDiscountCodes declares apiFetch<DiscountCode[]> (services/api/billing.ts:64-65), an unchecked 'as T' assertion. (4) DiscountCodePage.loadData line 60 does Array.isArray(codesResult) ? codesResult : [] and therefore ALWAYS sets []. The page is routed and reachable (Module.tsx:132, path 'billing/discounts'). The failure is silent and misleading: getDiscountStats returns a flat stats object (no data+total keys) so it unwraps correctly — the admin sees 'Total Codes: N > 0' cards above a permanently empty table. Create works (POST response has no meta.page), so codes persist to admin.discount_codes but can never be listed, inspected, or deactivated from the UI — the per-row Deactivate button never renders. Severity stands at CRITICAL: discount codes are financial instruments (the service's own C-12 comment), and the sole intended control surface for revoking a leaked/abused code is dead, silently.
- **Root cause:** The FE transport layer broke the chain, in two compounding ways. First, apiFetch's envelope unwrap is shape-polymorphic at runtime: it returns either envelope.data or { data, ...meta } depending on whether the response happens to carry meta.page, while the declared generic T is a blind 'as T' assertion — so the compiler can never see a mismatch between declared and actual shape. Second, billing.ts hand-typed this paginated endpoint as apiFetch<DiscountCode[]>, drifting from the codebase's own established convention (PaginatedResult<T> in services/types/common.ts, correctly used at 55 call sites across 13 sibling api modules, e.g. tenantsApi.list). The page then masked the resulting contract lie with a defensive Array.isArray guard (a CLAUDE.md-banned pattern) that converted a type error into a permanent silent empty state instead of a loud failure. The backend is internally consistent — service pagination shape + interceptor meta-lift is the service-wide convention — so this is an instance of the SYSTEMIC class 'FE-type drift vs envelope unwrap': a shape-polymorphic transport plus unchecked hand-written assertions plus downstream defensive guards (25+ Array.isArray sites across pages exist to paper over the same uncertainty).
- **Fix design:** Pattern-level fix (tier 1 — make the wrong shape impossible) plus local application. TRANSPORT: split the polymorphic contract in http-client.ts. (a) Delete the meta.page re-spread branch (lines 344-346) so plain apiFetch<T> ALWAYS returns envelope.data and nothing else — a caller who typed T[] against a paginated endpoint now receives the array (correct-by-default, tier 2). (b) Add apiFetchPaginated<T>(endpoint, options?): Promise<PaginatedResult<T>> that parses the same envelope, REQUIRES meta.page/total/limit to be present and numeric, and constructs PaginatedResult<T> explicitly from envelope.data + meta; if the envelope lacks pagination meta it throws a contract-violation ApiError naming the endpoint (tier 3 — loud, not silent-empty). Pagination shape now exists only when the caller declares it, enforced by the type system, and mispairing fails immediately with a diagnosable error. MIGRATION: mechanically convert the 55 existing apiFetch<PaginatedResult<...>> call sites in the 13 api modules (tenants, users, audit, security, settings, support, debug, database, messaging, modules, impersonation, analytics, reports) to apiFetchPaginated<...> — consumer-facing types are unchanged, and `npm run type-check` proves completeness. LOCAL: billing.ts getDiscountCodes becomes apiFetchPaginated<DiscountCode>(`/billing/discounts?${buildQueryString(...)}`); DiscountCodePage.loadData consumes codesResult.data directly and the banned Array.isArray defensive guard is deleted — with the honest type, wrong access is a compile error. No backend change: the controller/service/interceptor convention is consistent platform-wide and matches the FE PaginatedResult contract. No 'as any', no compat shim, no allowlist — the fix removes the runtime polymorphism at its source.
- **Files to change:**
  - `web/modules/admin-panel/src/services/http-client.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/DiscountCodePage.tsx`
  - `web/modules/admin-panel/src/services/api/tenants.ts`
  - `web/modules/admin-panel/src/services/api/users.ts`
  - `web/modules/admin-panel/src/services/api/audit.ts`
  - `web/modules/admin-panel/src/services/api/security.ts`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `web/modules/admin-panel/src/services/api/support.ts`
  - `web/modules/admin-panel/src/services/api/debug.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `web/modules/admin-panel/src/services/api/messaging.ts`
  - `web/modules/admin-panel/src/services/api/modules.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/analytics.ts`
  - `web/modules/admin-panel/src/services/api/reports.ts`
  - `web/modules/admin-panel/src/services/api/__tests__/http-client-pagination.contract.spec.ts`
- **Proof of fix:** New spec web/modules/admin-panel/src/services/api/__tests__/http-client-pagination.contract.spec.ts: mock fetch with the EXACT ResponseInterceptor fixture ({success:true,data:[{...discount}],meta:{total:1,page:1,limit:50,totalPages:undefined,timestamp}}), then assert (1) apiFetchPaginated<DiscountCode> resolves to PaginatedResult with Array.isArray(result.data)===true and total/page/limit populated; (2) plain apiFetch<T> on the same paginated envelope resolves to the raw array — never a spread {data,...meta} object; (3) apiFetchPaginated on a non-paginated envelope ({success:true,data:{...},meta:{timestamp}}) rejects with the contract-violation ApiError; (4) billingApi.getDiscountCodes() resolves to a PaginatedResult whose .data lists the fixture codes. Add a DiscountCodePage render test (same fixture via mocked billingApi) asserting the table shows the code rows and the Deactivate button, proving the primary flow is alive. Completeness of the 55-call-site migration is proven by `npm run type-check` (apiFetch no longer satisfies Promise<PaginatedResult<T>> once the spread branch is gone, so any missed site is a compile error) plus `nx affected --target=test` green.
- **Effort:** M

### APA-107 [MEDIUM] Generate->Create silently mutates the code (underscore stripped)

- **Status:** DESIGNED (brief)
- **Symptom:** generateUniqueCode('PROMO', 8) returns 'PROMO_XXXXXXXX' which is shown to the admin; create() then normalizes with replace(/[^A-Z0-9]/g,'') storing 'PROMOXXXXXXXX'. A customer given the displayed underscore code will fail findByCode lookup — the code communicated is not the code stored.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:492 (code = prefix ? `${prefix}_` : '')`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:168 (const normalizedCode = dto.code.toUpperCase().replace(/[^A-Z0-9]/g, ''))`
  - `web/modules/admin-panel/src/pages/DiscountCodePage.tsx:71-72`
- **Root cause:** Two normalization regimes for one financial identifier: generateUniqueCode (discount-code.service.ts:492) emits `PREFIX_XXXXXXXX` while create() (line 168) canonicalizes with replace(/[^A-Z0-9]/g,''), silently storing `PREFIXXXXXXXXX`. The admin communicates the displayed underscore form, findByCode never matches it, and the generator's own uniqueness check (line 497) runs against the un-normalized form so it can never collide with anything actually stored.
- **Fix design:** Single canonical form, divergence made impossible (tier 1). Add one private normalizeCode(raw) helper (uppercase + strip non-[A-Z0-9]) used everywhere: (a) generateUniqueCode composes prefix+random WITHOUT the underscore join (or normalizes the composed candidate) and uniqueness-checks/returns the canonical form, so what the admin sees IS what will be stored; (b) create() throws BadRequestException('code contains characters outside A-Z0-9') whenever normalizeCode(dto.code) !== dto.code.toUpperCase() instead of silently mutating — the code the caller supplied is exactly the code stored or the request fails; findByCode keeps the uppercase lookup. FE needs no change (it displays whatever generate returns). Verification: extend/create apps/admin-api-service/src/billing/__tests__/discount-code.service.spec.ts with a generate→create round-trip test (stored code === displayed code, including a prefix) and a rejection test for an underscore/hyphen code.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `apps/admin-api-service/src/billing/__tests__/discount-code.service.spec.ts`
- **Effort:** S

### APA-108 [MEDIUM] applyDiscount redemption counting is not atomic

- **Status:** DESIGNED (brief)
- **Symptom:** currentRedemptions is incremented via entity read-modify-write (discountCode.currentRedemptions += 1; save) after a separate validation read — concurrent redemptions can both pass the maxRedemptions check and oversubscribe a capped financial instrument.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:256-263 (validation read)`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:369-370 (non-atomic increment)`
- **Root cause:** applyDiscount does check-then-act across separate statements with no transaction: validateCode reads currentRedemptions (line 260), then the redemption row is saved and the counter incremented via entity read-modify-write (lines 366-370). Two concurrent redemptions of a maxRedemptions-capped code both pass validation and both persist — the cap on a financial instrument is advisory, and the increment itself can lose updates.
- **Fix design:** Make oversubscription impossible at the database (tier 1). Wrap redeem in one transaction: (1) lock the discount_codes row (repo.findOne with lock {mode:'pessimistic_write'} inside dataSource.transaction) — this serializes all redemptions of a code; (2) re-run the cap checks (global + per-tenant redemption count) under the lock; (3) insert the redemption and increment the counter with a guarded atomic UPDATE `SET current_redemptions = current_redemptions + 1 WHERE id = :id AND (max_redemptions IS NULL OR current_redemptions < max_redemptions)`, treating 0 affected rows as cap-reached (defense in depth even if the lock path changes). validateCode stays lock-free for the read-only /validate endpoint; only applyDiscount takes the transactional path. Verification: a concurrency spec in apps/admin-api-service/src/billing/__tests__/ firing N parallel applyDiscount calls against maxRedemptions=1 and asserting exactly one success and currentRedemptions===1 (integration-level against Postgres, e.g. under apps/admin-api-service/src/__tests__/integration/ if the unit harness cannot exercise real locking).
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `apps/admin-api-service/src/__tests__/integration/discount-redemption-atomicity.spec.ts`
- **Effort:** M

### APA-109 [LOW] List capped at 50 codes with no pagination UI

- **Status:** DESIGNED (brief)
- **Symptom:** The FE never sends page/limit so the backend default limit=50 applies; codes beyond 50 would be invisible even after the array bug is fixed, and the page renders no pager.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:116 (const limit = options?.limit || 50)`
  - `web/modules/admin-panel/src/services/api/billing.ts:64-65 (only isActive/includeExpired sent)`
- **Root cause:** The backend list is paginated ({data,total,page,limit}, default limit 50 at discount-code.service.ts:116, surfaced as meta by ResponseInterceptor) but the FE half of the contract was never built: getDiscountCodes sends only isActive/includeExpired (billing.ts:64-65), types the response as a bare DiscountCode[], and DiscountCodePage renders no pager — codes 51+ are unreachable.
- **Fix design:** Adopt the paginated contract end-to-end, reusing the pattern SubscriptionManagementPage already implements: getDiscountCodes gains page/limit params and its return type becomes the unwrapped paginated shape the http-client actually produces for meta.page responses ({data: DiscountCode[]; total; page; limit}) — this simultaneously kills the Array.isArray-fallback-to-[] shape bug at line 60 of the page (the FE type finally matches the wire shape). DiscountCodePage adds page state + the same Previous/Next pager block as SubscriptionManagementPage, resetting page on filter change. Verification: a DiscountCodePage test asserting the pager renders when total > limit, page 2 requests carry page=2, and the list populates from the {data,total} shape (no empty-array fallback).
- **Files to change:**
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/DiscountCodePage.tsx`
- **Effort:** S

### APA-110 [LOW] getDiscountRedemptions FE contract mismatch (unused endpoint)

- **Status:** DESIGNED (brief)
- **Symptom:** FE types the response as an array with tenantName, but the backend returns {redemptions,total} of raw DiscountRedemption rows (no tenantName). Latent drift — no current page calls it.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/billing.ts:94-95`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:390-402`
- **Root cause:** getDiscountRedemptions (billing.ts:94-95) types a hand-invented shape — an array of rows with tenantName — while the backend endpoint returns {redemptions: DiscountRedemption[]; total} (discount-code.service.ts:390-402) whose rows have tenantId but no tenantName. Classic hand-written-FE-type drift; latent only because no page calls it yet, so it is also a dead FE operation.
- **Fix design:** Fix the contract at the source rather than leave a booby-trap: add a DiscountRedemption FE type mirroring the entity fields actually returned (id, discountCodeId, tenantId, subscriptionId?, invoiceId?, discountAmount, currency, redeemedAt, redeemedBy?) to services/types/billing.ts and retype getDiscountRedemptions as {redemptions: DiscountRedemption[]; total} with optional {limit,offset} params matching the service. Drop the phantom tenantName — if a future page needs it, that is a backend join added at the source, not an FE type claim. Because the operation is currently uncalled, register/verify it against the dead-contract gate: ensure tests/invariants/dead-contract-fe-operations.spec.ts + its baseline still account for it (do NOT grow the baseline; if it is already listed the retype is neutral, and the first consuming page removes it). Verification: the retype compiles (npm run type-check) and the dead-contract invariant stays green with no baseline growth.
- **Files to change:**
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
- **Effort:** S


## ModulePricingPage — `/admin/billing/module-pricing` — verdict: **WORKING**

**Chain:** Full chain verified: GET /billing/module-pricing/with-modules -> ModulePricingService -> admin.module_pricing (entity schema 'admin', DDL in 1800200000000-CreateAdminEntitySurfaceTables.ts:125-155) joined with auth.modules (created in auth-service Baseline; id/name/description/icon/isActive columns all exist). Edit -> PUT /billing/module-pricing/:pricingId (UpdateModulePricingDto, a real class-validator DTO) -> creates a new versioned pricing row and deactivates the old one. Envelope passes through cleanly (array payload). Module pricing genuinely feeds real money: tenant provisioning computes subscription monthly totals from priced module items and the pricing calculator/custom-plan pricing read this table.

**Endpoints exercised:** `GET /billing/module-pricing/with-modules`; `PUT /billing/module-pricing/:pricingId`

**DB tables:** `admin.module_pricing`, `auth.modules`

### APA-111 [MEDIUM] pricingMetrics accepted with only @IsArray — no element validation

- **Status:** DESIGNED (brief)
- **Symptom:** UpdateModulePricingDto validates pricingMetrics as a bare array (no nested type/price checks) and SetModulePricingDto (POST path) is a service interface with no validation at all — negative prices, unknown metric types, or NaN survive to jsonb and flow into every downstream pricing calculation.
- **Evidence:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts:34-36 (@IsOptional() @IsArray() pricingMetrics?: PricingMetric[])`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts:19-28 (export interface SetModulePricingDto)`
- **Root cause:** The module-pricing write path has no element-level validation anywhere: UpdateModulePricingDto (billing.dto.ts:34-36) validates pricingMetrics with a bare @IsArray (no @ValidateNested/@Type, so elements are arbitrary), and the POST path's SetModulePricingDto is a TS interface (module-pricing.service.ts:19-28) skipped entirely by the ValidationPipe — negative prices, unknown metric types, and NaN persist to jsonb and feed every pricing calculation. Same systemic interface-@Body class as billing-plans|p1|i1.
- **Fix design:** Local application of the p1|i1 pattern fix. Add PricingMetricDto to dto/billing.dto.ts implementing the entity PricingMetric: @IsEnum(PricingMetricType) type, @IsNumber() @Min(0) price, @IsString() @MaxLength(10) currency, optional @IsString description, optional @IsInt @Min(0) minQuantity/maxQuantity/includedQuantity; TierMultipliersDto with one optional @IsNumber() @Min(0) prop per PlanTier key. Convert SetModulePricingDto into a validated class in dto/billing.dto.ts (moduleId @IsUUID, moduleCode @IsString @MaxLength(100), pricingMetrics @IsArray @ArrayMinSize(1) @ValidateNested({each:true}) @Type(()=>PricingMetricDto), tierMultipliers @ValidateNested @Type, currency/effectiveFrom/effectiveTo/notes as in UpdateModulePricingDto); UpdateModulePricingDto becomes PartialType(SetModulePricingDto) so the two paths cannot diverge; the controller imports both from dto/, the service accepts the class (it satisfies the current interface, which is deleted). The systemic gate is the shared tests/invariants/admin-body-dto-class.spec.ts from p1|i1. Verification: controller validation tests asserting POST/PUT module-pricing rejects a negative price, an unknown metric type, and a non-numeric price with 400; the shared invariant spec confirms no interface-typed @Body remains.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `tests/invariants/admin-body-dto-class.spec.ts`
- **Effort:** M

### APA-112 [LOW] Every save creates a new version row with effectiveFrom=now; currency/effectiveFrom dropped from payload

- **Status:** DESIGNED (brief)
- **Symptom:** The edit modal sends only pricingMetrics/tierMultipliers/notes; updateModulePricing always mints a new version effective immediately and deactivates the prior row (setting its effectiveTo 1s in the past), so repeated saves accrete version rows and there is no way to schedule a future effective date from the UI.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/ModulePricingPage.tsx:283-287`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts:250-279 and 213-223`
- **Root cause:** The edit modal (ModulePricingPage.handleSave) only submits {pricingMetrics, tierMultipliers, notes} and exposes no effectiveFrom/effectiveTo/currency controls, while updateModulePricing() unconditionally defaults effectiveFrom to `new Date()` and setModulePricing() deactivates the prior row at (effectiveFrom-1s). The backend versioning machinery already supports future-dated rows, but the admin UI cannot reach it, so every save mints an immediately-effective version and accretes history with no scheduling capability.
- **Fix design:** Make scheduling a first-class, explicit input rather than a silent default. Add effectiveFrom (required date) and optional effectiveTo to the edit modal, thread them through a validated update DTO -> the PUT module-pricing controller -> updateModulePricing/setModulePricing so a future effective date is honored (blue/green: prior row's effectiveTo = new effectiveFrom-1s only when the new row actually becomes active). Surface/edit currency in the same modal (it is on the entity + FE type but never editable) or drop it from the payload contract to remove the phantom field. Row accretion is acceptable given price history is immutable-by-design; the real fix is reachable scheduling. Tier 2: correct behavior (explicit effective date) becomes the default the UI drives.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/ModulePricingPage.tsx`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/dto/update-module-pricing.dto.ts`
  - `apps/admin-api-service/src/billing/__tests__/module-pricing.service.spec.ts`
- **Effort:** M


## CustomPlansListPage — `/admin/billing/custom-plans` — verdict: **PARTIAL**

**Chain:** Default listing and the submit/approve/reject/delete/clone workflow are real repository writes to admin.custom_plans (table + status enum in admin-api Baseline migration). The paginated shape {items,total,...} passes the envelope untouched (no 'data' key) and matches the FE type. Two structural breaks: (1) the terminal 'Activate' step can never succeed because it routes into a deliberately-disabled createSubscription stub, and (2) any status/search filtering 400s due to the mixed @Query decorator pattern colliding with forbidNonWhitelisted.

**Endpoints exercised:** `GET /billing/custom-plans`; `POST /billing/custom-plans/:planId/submit`; `POST /billing/custom-plans/:planId/approve`; `POST /billing/custom-plans/:planId/reject`; `POST /billing/custom-plans/:planId/activate`; `POST /billing/custom-plans/:planId/clone`; `DELETE /billing/custom-plans/:planId`

**DB tables:** `admin.custom_plans`, `billing.subscriptions`

### APA-113 [HIGH] Activate always throws 409 — approval workflow dead-ends before subscription creation

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** CustomPlanService.activatePlan calls subscriptionService.createSubscription, which delegates to SubscriptionCoreService.createSubscription — a method that unconditionally throws ConflictException ('Subscription creation is billing-service-owned'). No custom plan can ever reach ACTIVE status or produce a subscription from this panel; the entire draft->submit->approve chain terminates in a guaranteed error. The billing-service provisioning path that honors customPlanId also cannot help: it looks the id up in billing.plans, where admin.custom_plans ids do not exist.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts:376-384 (activatePlan -> subscriptionService.createSubscription)`
  - `apps/admin-api-service/src/billing/services/subscription-core.service.ts:270-275 (createSubscription(): never { throw new ConflictException(...) })`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:596-603 (customPlanId resolved against billing Plan repository)`
- **Verification:** Verified end-to-end. (1) apps/admin-api-service/src/billing/services/custom-plan.service.ts:376 calls subscriptionService.createSubscription on the SubscriptionManagementService facade; subscription-management.service.ts:82-84 delegates to coreService.createSubscription; subscription-core.service.ts:270-275 is `createSubscription(dto): never` throwing ConflictException unconditionally — the facade signature `Promise<CreateSubscriptionResult>` launders the `never`, making activatePlan's success-check dead code. (2) Reachable: CustomPlansListPage.tsx:170-178 -> billingApi.activateCustomPlan (services/api/billing.ts:265-266, POST /billing/custom-plans/:planId/activate) -> billing.controller.ts:605-607 -> activatePlan. SUPER_ADMIN clicking Activate on an APPROVED plan always gets 409; plan stays APPROVED forever. (3) The billing-service path cannot substitute: billing-admin-nats.handler.ts:594-618 resolves command.customPlanId against the billing Plan repository (billing.plans), while CustomPlan is @Entity('custom_plans',{schema:'admin'}) (entity line 74) and grep shows no sync mirroring admin custom plans into billing.plans — NotFoundException guaranteed; enterprise provisioning even REQUIRES quoteId/customPlanId (handler:585), so enterprise custom-plan onboarding is broken end-to-end. Severity lowered CRITICAL->HIGH: total functional failure of a core admin workflow, but it fails loudly with 409, leaves state consistent, and has no data-corruption/mis-billing/security impact.
- **Root cause:** The Service->cross-service-boundary link broke during the D14 single-writer migration ("billing is the SSoT for subscription state"). Admin-api's direct billing.subscriptions writes were converted to runtime tombstones (`never` methods throwing ConflictException in SubscriptionCoreService) and the REST endpoints cancel/reactivate/extend-trial were rewired to BillingAdminCommandClientService (billing.controller.ts:383-415) — but the one INTERNAL caller, CustomPlanService.activatePlan, was missed, and no billing-side ACTIVATE_CUSTOM_PLAN command was ever defined in BILLING_ADMIN_COMMAND_SUBJECTS (billing-admin-commands.ts:11-22). The drift persisted because the tombstone pattern makes misuse detectable only at RUNTIME while the SubscriptionManagementService facade wraps the `never` core method in `async createSubscription(): Promise<CreateSubscriptionResult>`, so the compiler could not flag the orphaned call path. Systemic class: SSoT-migration-by-runtime-tombstone instead of compile-time removal — the wrong behavior was left callable with a lying type instead of being made impossible (tier 1).
- **Fix design:** Pattern-level + local fix, following the existing PROVISION_TENANT_SUBSCRIPTION template. (A) Contract at the source (libs/event-contracts/src/billing-admin-commands.ts): add ACTIVATE_CUSTOM_PLAN: 'request.billing.admin.activateCustomPlan' to BILLING_ADMIN_COMMAND_SUBJECTS plus BillingAdminActivateCustomPlanCommand { operationId, tenantId, customPlanId (admin provenance ref), idempotencyKey, requestPayloadHash, actorId, planName, tier: PlanTier, billingCycle, moduleItems: BillingProvisioningModuleItem[] (reuse the existing priced-line shape — admin owns pricing per ORPHAN-HIGH-394), monthlyTotal, currency } with a BillingTenantProvisioningResult-style result carrying subscriptionId/receiptId/replayed. Register it in platform-event-registry.ts (producer admin-api-service, consumer billing-service, request-reply-receipt, financial) + JSON Schema + fixture per Event Contract Rules. (B) billing-service: add handleActivateCustomPlan to billing-admin-nats.handler.ts reusing the existing command-receipt idempotency (insertBillingReceipt/replay) and the createProvisioningSubscription write machinery, taking price/module rows from the command snapshot — explicitly NOT resolving billing.plans for admin custom-plan ids; if the tenant already has an active subscription, supersede it (cancel + insert new) inside the same transaction, recorded on the receipt, honoring UQ_subscriptions_tenantId_active. (C) admin-api: add BillingAdminCommandClientService.activateCustomPlan mirroring provisionTenantSubscription; rewrite CustomPlanService.activatePlan to build the command from the APPROVED plan snapshot with deterministic operationId/idempotencyKey (seed `activate-custom-plan:${planId}`) so post-outage retries replay, then persist returned subscriptionId + ACTIVE status; make activatedBy REQUIRED and have billing.controller.ts activateCustomPlan pass getAuthUserId(req) like its sibling endpoints (today actor identity is silently dropped). Drop the forwardRef(SubscriptionManagementService) dependency. (D) Close the systemic class at tier 1 — make it impossible: DELETE the runtime tombstones SubscriptionCoreService.createSubscription/cancelSubscription/reactivateSubscription/extendTrial and their SubscriptionManagementService facade wrappers (grep confirms activatePlan was the sole remaining caller), and remove the orphaned CreateSubscriptionDto/CreateSubscriptionResult types; any future caller of a billing-service-owned mutation becomes a compile error instead of a 409. The deliberate REST boundary tombstone at billing.controller.ts:314 stays (external API contract, spec'd at billing.controller.spec.ts:450-474).
- **Files to change:**
  - `libs/event-contracts/src/billing-admin-commands.ts`
  - `libs/event-contracts/src/platform-event-registry.ts`
  - `libs/event-contracts/schemas/billing-admin-activate-custom-plan-command.schema.json`
  - `libs/event-contracts/fixtures/billing-activate-custom-plan-command.json`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts`
  - `apps/admin-api-service/src/billing/services/billing-admin-command-client.service.ts`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-core.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-management.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-types.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/billing.module.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
- **Proof of fix:** (1) New spec apps/admin-api-service/src/billing/__tests__/custom-plan.service.spec.ts: activatePlan on an APPROVED plan sends BILLING_ADMIN_COMMAND_SUBJECTS.ACTIVATE_CUSTOM_PLAN via BillingAdminCommandClientService with the priced module snapshot + actorId + deterministic idempotency key, persists the returned subscriptionId, and transitions APPROVED->ACTIVE; a rejected command result leaves the plan APPROVED. (2) Extend apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts: POST /billing/custom-plans/:planId/activate binds getAuthUserId(req) into activatePlan and no longer returns 409 for approved plans. (3) New/extended billing-service handler spec (apps/billing-service/src/billing/handlers/__tests__/billing-admin-nats.handler.activate-custom-plan.spec.ts): subscription row is written from command moduleItems/monthlyTotal with NO billing.plans lookup, receipt-based replay is idempotent, and an existing active subscription is superseded in-transaction. (4) Contract gate: platform-event-registry invariant tests in libs/event-contracts pick up the new entry (schema+fixture round-trip validates BillingAdminActivateCustomPlanCommand). (5) Compile-time gate for the systemic class: the tombstone methods and facade wrappers are deleted, so `npm run type-check` structurally fails any future caller of an admin-side subscription mutation — no runtime 409 path remains to allowlist.
- **Effort:** L

### APA-114 [HIGH] Status/search/tier filters return 400 Bad Request

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** listCustomPlans mixes named @Query('status')/@Query('search')/etc. with a catch-all @Query() pagination: PaginationQueryDto. The global ValidationPipe (whitelist:true, forbidNonWhitelisted:true) validates the FULL query object against PaginationQueryDto, whose only properties are page/limit/sortBy/sortOrder — so ?status=draft or ?search=x is rejected as a non-whitelisted property before the handler runs. Every status-card click and search keystroke on this page yields an error banner.
- **Evidence:**
  - `apps/admin-api-service/src/billing/billing.controller.ts:532-548 (named @Query params + @Query() PaginationQueryDto on one handler)`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25 (only page/limit/sortBy/sortOrder)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-460 (whitelist:true, forbidNonWhitelisted:true defaults; admin-api main.ts passes no overrides)`
- **Verification:** Confirmed end-to-end. billing.controller.ts:532-548 mixes named @Query('status'|'search'|'tier'|'tenantId') with a class-typed catch-all @Query() pagination: PaginationQueryDto. NestJS resolves the catch-all by passing the ENTIRE req.query to the ValidationPipe, which validates it against PaginationQueryDto (only page/limit/sortBy/sortOrder). The global pipe from createServiceApp (create-service-app.ts:458-460, applied line 787) has whitelist:true + forbidNonWhitelisted:true; admin-api main.ts passes no overrides and grep shows no APP_PIPE/@UsePipes anywhere in the service, so ?status=draft or ?search=x throws BadRequestException ('property status should not exist') before the handler runs — and in production disableErrorMessages masks it to a bare 'Bad Request'. FE reachability confirmed: CustomPlansListPage.tsx:91-96 sends status/search on every status-card click and search keystroke via buildQueryString (which skips undefined — explaining why the unfiltered initial load works and the bug survived). The named params do not rescue the request: each route param is piped independently and the catch-all's rejection wins. Systemic class confirmed: the identical mixed pattern exists in audit.controller.ts:48-54 (audit-log filters) and ticket.controller.ts:164-170/234-236/246-249/355-357/394-397 (support-ticket and comment filters), so audit search and ticket filtering are broken the same way. Severity HIGH is correct: core admin filtering/search is completely non-functional across three sections, though no data loss or security impact.
- **Root cause:** The BE controller-layer HTTP contract broke: the handler's accepted-parameter surface (named @Query decorators) and the ValidationPipe's whitelist surface (the DTO class of the catch-all @Query()) are two disconnected declarations of the same query contract. NestJS validates the whole query object against whichever DTO the catch-all names, so any filter param not declared on that DTO is a forbidden non-whitelisted property. It drifted because PaginationQueryDto was treated as a reusable base to bolt ad-hoc named @Query filters next to, and nothing in the type system or test suite ties 'params the handler reads' to 'params the validation whitelist allows' — the mixed pattern compiles cleanly, works on unfiltered requests, and only fails when a filter is actually sent, so it propagated by copy-paste into billing, audit, and support controllers.
- **Fix design:** Pattern-level fix (systemic class: DTO-whitelist rejection from mixed @Query declarations), per the architectural hierarchy. TIER 1 — make the wrong shape impossible locally: collapse each mixed handler to a SINGLE @Query() parameter typed by a per-endpoint query DTO that extends PaginationQueryDto, so the validation whitelist and the handler's parameter surface become the same declaration by construction. For this endpoint: add ListCustomPlansQueryDto extends PaginationQueryDto to apps/admin-api-service/src/billing/dto/billing.dto.ts with @IsOptional()@IsUUID() tenantId, @IsOptional()@IsEnum(CustomPlanStatus) status, @IsOptional()@IsEnum(PlanTier) tier, @IsOptional()@IsString() search; change listCustomPlans to async listCustomPlans(@Query() query: ListCustomPlansQueryDto) and build CustomPlanFilter from it. This is strictly stronger than today: status/tier gain real enum validation (currently any string flows through unvalidated). Apply the same transformation to every sibling instance found: audit.controller.ts listAuditLogs (ListAuditLogsQueryDto: tenantId/performedBy/severity(@IsEnum)/startDate/endDate(@IsISO8601)/search), and ticket.controller.ts filtered handlers (ListTicketsQueryDto with status/priority/category enums + assignedTo/tenantId/search; a status-only variant for tenant/assigned routes; an includeInternal @IsOptional()@IsIn(['true','false']) property for comments/replies). No 'as any', no pipe overrides, no allowlisting extra props on the shared PaginationQueryDto (that would silently accept junk on pagination-only routes). FE requires no change — it already sends exactly these param names. TIER 2 — make the correct test setup automatic: extract the inline defaults in configureValidationPipe (create-service-app.ts) into an exported buildValidationPipeOptions(isProduction) factory in libs/backend-common so integration specs construct the byte-identical production pipe instead of hand-copying options that can drift. TIER 3 — make regressions detectable: (a) an architecture spec that reflects over every admin-api controller via ROUTE_ARGS_METADATA and fails any route mixing a named @Query('x') with a class-metatyped catch-all @Query() — outlawing the entire defect class at test time; (b) an integration spec that boots the billing controller behind buildValidationPipeOptions and asserts GET /billing/custom-plans?status=draft&search=x reaches the handler (200) while ?status=bogus returns 400 with an enum constraint, plus equivalent cases for audit and ticket routes.
- **Files to change:**
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/audit/dto/audit-query.dto.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `apps/admin-api-service/src/support/dto/ticket-query.dto.ts`
  - `libs/backend-common/src/bootstrap/create-service-app.ts`
  - `apps/admin-api-service/src/__tests__/architecture/query-param-contract.architecture.spec.ts`
  - `apps/admin-api-service/src/__tests__/integration/admin-query-contract.spec.ts`
- **Proof of fix:** New architecture spec apps/admin-api-service/src/__tests__/architecture/query-param-contract.architecture.spec.ts: iterates all controllers in the admin-api module, reads ROUTE_ARGS_METADATA + design:paramtypes per handler, and FAILS if any route combines a named @Query('x') param with a catch-all @Query() whose metatype is a decorated class — proving the defect class cannot re-enter. New integration spec apps/admin-api-service/src/__tests__/integration/admin-query-contract.spec.ts: boots a Nest test app with new ValidationPipe(buildValidationPipeOptions(false)) (the exported real config, not a copy) and asserts (1) GET /billing/custom-plans?status=draft&search=x&page=1&limit=20 returns 200 and the service receives {status:'draft',search:'x',page:1,limit:20}; (2) ?status=not_a_status returns 400 citing the isEnum constraint; (3) same pass/fail pairs for /audit-logs?severity=... and /support/tickets?status=...&priority=.... Both specs red on current HEAD (integration case 1 gets 400 today), green after the fix; run via nx affected --target=test.
- **Effort:** M

### APA-115 [MEDIUM] FE CustomPlanStatus.CANCELLED does not exist in the backend

- **Status:** DESIGNED (brief)
- **Symptom:** The page offers a 'Cancelled' filter and summary card, but the backend enum and the custom_plans_status_enum DB type contain only draft/pending_approval/approved/active/expired/rejected. Even with the 400 fixed, filtering 'cancelled' would raise a Postgres invalid-enum error; the card count is permanently 0.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/billing.ts:74-82 (CANCELLED = 'cancelled')`
  - `apps/admin-api-service/src/billing/entities/custom-plan.entity.ts:18-25 (no CANCELLED)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:237 (enum without 'cancelled')`
- **Root cause:** FE CustomPlanStatus (services/types/billing.ts:81) declares CANCELLED='cancelled', but the backend TS enum (custom-plan.entity.ts:18-25) and the Postgres custom_plans_status_enum (Baseline migration:237) contain only draft/pending_approval/approved/active/expired/rejected, and no service transition ever sets a cancelled status. Unlike PlanTier (pinned by tests/invariants/tier-enum-ssot.spec.ts), CustomPlanStatus has no SSoT invariant, so the FE enum silently drifted. Selecting the Cancelled filter sends status=cancelled into a parameterized enum comparison in listCustomPlans, raising a Postgres 22P02 invalid-enum error, and the summary card count is permanently 0.
- **Fix design:** Realign the enum to the actual backend SSoT and make future drift detectable. Since there is no cancel transition anywhere in CustomPlanService and no DB value, remove CANCELLED from the FE enum plus its STATUS_CONFIG and STATUS_FILTERS entries in CustomPlansListPage. Add an invariant spec (mirroring tier-enum-ssot) that pins the FE CustomPlanStatus members to the backend entity enum member-for-member so any future addition without a matching entity+migration change fails CI. (If product genuinely wants cancellation, that is a separate feature: ALTER TYPE to add 'cancelled', a cancelPlan() transition + guard + controller route + FE action — but the drift itself is fixed by aligning to the SSoT.) Tier 3: make-detectable.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/pages/CustomPlansListPage.tsx`
  - `tests/invariants/custom-plan-status-enum-ssot.spec.ts`
- **Effort:** M

### APA-116 [LOW] Clone copies stale approval artifacts

- **Status:** DESIGNED (brief)
- **Symptom:** clonePlan spreads the source entity, resetting id/status/approvedBy/approvedAt/subscriptionId but carrying over rejectionReason and the original validFrom/validTo onto the new draft.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts:419-435`
- **Root cause:** clonePlan (custom-plan.service.ts:419-435) builds the clone by spreading the entire source entity and then nulling only a subset of lifecycle fields (id/tenantId/name/status/approvedBy/approvedAt/subscriptionId/createdAt/updatedAt). rejectionReason and the validity window (validFrom/validTo) are not reset, so a cloned draft inherits the source's rejection note and its original (possibly past) effective dates. Allowlist-by-omission is inherently drift-prone: any lifecycle field added later also silently carries over.
- **Fix design:** Invert to an explicit allowlist: construct the clone only from the fields that legitimately transfer (name base, description, tier, billingCycle, modules, discountPercent/Amount/Reason, currency, notes) and derive every lifecycle/approval field fresh (status=DRAFT, approvedBy/approvedAt/subscriptionId/rejectionReason=null, validFrom=today, validTo cleared). This makes 'what carries over' explicit and makes accidental leakage of new fields impossible. Add a unit test asserting a cloned plan has rejectionReason=null, a fresh validFrom, and no approval artifacts.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
  - `apps/admin-api-service/src/billing/__tests__/custom-plan.service.spec.ts`
- **Effort:** S


## CustomPlanBuilderPage — `/admin/billing/custom-plans/new` — verdict: **WORKING**

**Chain:** Full round-trip verified: module list from admin.module_pricing + auth.modules; live quote via POST /billing/pricing/calculate -> PricingCalculatorService reading the same module_pricing rows (with FREE-tier zeroing and discount-code support); Create/Save-as-Draft -> POST /billing/custom-plans -> CustomPlanService recomputes pricing server-side and persists to admin.custom_plans; auto-submit -> POST /custom-plans/:id/submit. Route is registered (Module.tsx:137) and the legacy /custom-plan-builder path redirects here (Module.tsx:138). Caveat: the plans it creates feed the broken Activate step audited on the list page.

**Endpoints exercised:** `GET /billing/module-pricing/with-modules`; `POST /billing/pricing/calculate`; `POST /billing/custom-plans`; `POST /billing/custom-plans/:planId/submit`

**DB tables:** `admin.module_pricing`, `auth.modules`, `admin.custom_plans`

### APA-117 [MEDIUM] Silent client-side pricing fallback with hardcoded multipliers

- **Status:** DESIGNED (brief)
- **Symptom:** If POST /billing/pricing/calculate fails, the catch block fabricates a PricingCalculation from local math using hardcoded tier multipliers (ENTERPRISE 0.7, PROFESSIONAL 0.9) instead of the DB tierMultipliers, ignoring cycle discounts and tax — the operator sees a quote that can diverge from what the server persists on create, with no error indication.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx:150-172 (catch -> setPricing(localTotal ...))`
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx:181-205 (hardcoded 0.7/0.9 multipliers)`
- **Root cause:** The calculatePricing catch block (CustomPlanBuilderPage.tsx:150-172) substitutes a client-side reimplementation (calculateLocalPricing, 181-205) using hardcoded tier multipliers (ENTERPRISE 0.7, PROFESSIONAL 0.9), ignoring DB tierMultipliers, billing-cycle discounts, and tax. Pricing is server-authoritative (createCustomPlan recomputes via calculatePlanPricing from real DB pricing), so the fallback both hides the backend failure and shows a quote that will not match what is persisted. It is a duplicated-source-of-truth defect plus a silent-failure mask.
- **Fix design:** Delete calculateLocalPricing and the fallback entirely; the server's PricingCalculatorService is the single source of truth. On calculate failure, set an explicit error state and setPricing(null), and gate the Create/Submit and Save-as-Draft actions so a plan cannot be created without a valid server quote (Create button already partly gated; add pricing!==null). Tier 1/2: server-only pricing becomes the only path, so a fabricated quote can never be shown.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx`
- **Effort:** S

### APA-118 [MEDIUM] POST /billing/pricing/calculate and /billing/custom-plans bodies unvalidated

- **Status:** DESIGNED (brief)
- **Symptom:** QuoteRequest and CreateCustomPlanDto are TS interfaces (service exports), so the global ValidationPipe skips them entirely — negative quantities/discounts and arbitrary extra fields pass straight into pricing math and jsonb persistence; the only guard is the Math.max(0, total) floor.
- **Evidence:**
  - `apps/admin-api-service/src/billing/billing.controller.ts:506-509 (@Body() request: QuoteRequest) and 561-566 (@Body() dto: CreateCustomPlanDto)`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts:32-52 (interface CreateCustomPlanDto)`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts:558-574 (calculateFinalTotal floor)`
- **Root cause:** QuoteRequest (@Body() at billing.controller.ts:507) and CreateCustomPlanDto (@Body() at 562) are TypeScript interfaces (custom-plan.service.ts:32-52). Interfaces have no runtime representation, so Nest's global ValidationPipe (whitelist/forbidNonWhitelisted/transform) reflects metatype Object, skips validation, and passes the body through unchecked — negative quantities, negative discountPercent/Amount, and arbitrary extra keys flow straight into pricing math and jsonb columns; the only guard is calculateFinalTotal's Math.max(0,total) floor. This is the systemic 'interface-as-DTO silently disables ValidationPipe' class; several billing endpoints (create, update, quote, set-module-pricing) share it.
- **Fix design:** Replace the interface @Body() types with decorated class DTOs (dto/quote-request.dto.ts, dto/create-custom-plan.dto.ts) using class-validator: @IsUUID/@IsString/@IsEnum on scalars, @ValidateNested + @Type for nested modules/quantities (which become classes), @Min(0) on all quantities and discountAmount, @Min(0)@Max(100) on discountPercent, @IsOptional where appropriate; classes can implement the existing service interfaces. Because an interface silently disables validation with zero signal, add a pattern-level architecture spec that scans admin-api controllers and fails if any @Body() parameter's type is not a validation class — this makes the whole class detectable at build/test time (tier 3) and forces conversion of the sibling interface-DTOs the gate surfaces.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/quote-request.dto.ts`
  - `apps/admin-api-service/src/billing/dto/create-custom-plan.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
  - `apps/admin-api-service/src/__tests__/architecture/body-dto-must-be-class.spec.ts`
- **Effort:** L

### APA-119 [LOW] Raw icon names rendered instead of emoji

- **Status:** DESIGNED (brief)
- **Symptom:** auth.modules.icon stores names like 'fish'; ModulePricingPage maps them to emoji but this page renders module.moduleIcon verbatim, showing literal text like 'fish' in module cards.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx:476 and 511 ({module.moduleIcon || '📦'})`
  - `web/modules/admin-panel/src/pages/ModulePricingPage.tsx:46-76 (ICON_MAP the builder skips)`
- **Root cause:** The icon-name-to-emoji mapping (ICON_MAP + getModuleIcon) lives only inside ModulePricingPage.tsx; CustomPlanBuilderPage renders module.moduleIcon raw at lines 476 and 511, so auth.modules.icon names like 'fish' display as literal text. Root cause is a page-local, non-shared mapping helper (copy/duplication gap), not a data problem.
- **Fix design:** Extract ICON_MAP + getModuleIcon into a single shared admin-panel util (src/utils/moduleIcon.ts) as the SSoT for icon rendering; have ModulePricingPage import it (removing its local copy) and use it at CustomPlanBuilderPage lines 476 and 511. Optionally, resolve the emoji server-side in getAllModulePricingsWithModuleInfo so the API returns a display icon directly (tier 2, automatic) — but the shared FE helper is the minimal architectural dedupe.
- **Files to change:**
  - `web/modules/admin-panel/src/utils/moduleIcon.ts`
  - `web/modules/admin-panel/src/pages/ModulePricingPage.tsx`
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx`
- **Effort:** S

### APA-120 [LOW] Hardcoded discount claims in tier/cycle selectors

- **Status:** DESIGNED (brief)
- **Symptom:** Option labels assert fixed discounts ('Professional (10% off)', 'Annual (15% off)') that are actually data-driven via tierMultipliers and BILLING_CYCLE_DISCOUNTS — labels will lie whenever pricing config changes.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx:417-419 and 430-433`
- **Root cause:** The tier and billing-cycle <option> labels (CustomPlanBuilderPage.tsx:417-419, 430-433) and the tier-info panel (694-699) embed literal discount percentages ('Professional (10% off)', 'Enterprise (30% off)', 'Annual (15% off)') that duplicate — and can contradict — the authoritative data-driven pricing (per-module tierMultipliers + backend BILLING_CYCLE_DISCOUNTS). Worse, tier discount is per-module, so a single global percentage label is intrinsically inaccurate. Hardcoded copy is a second source of truth for numbers the backend owns.
- **Fix design:** Remove the hardcoded percentages from the tier/cycle option labels and the tier-info panel; let the computed server quote (Pricing Summary, pricing.tierDiscount) display the real, per-config discount instead of a static string. For billing-cycle, if a label hint is desired, expose BILLING_CYCLE_DISCOUNTS from the backend (config or pricing response) and render the label from that data rather than a literal. Tier 2: the displayed discount always derives from the real pricing source.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/CustomPlanBuilderPage.tsx`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
- **Effort:** S


## UsageDashboardPage — `/admin/billing/usage` — verdict: **PARTIAL**

**Chain:** All four calls (summary/tenants/trends/top-tenants) match real routes and run real aggregate SQL through UsageAggregationReadOnly against billing.usage_aggregations (a billing-service-owned table present in billing's Baseline migration; entity correctly synchronize:false, schema 'billing'). Envelope shapes pass through correctly. The fatal gap is upstream: nothing in the platform ever writes usage events, so the dashboard reads a real but permanently empty table.

**Endpoints exercised:** `GET /billing/usage/summary`; `GET /billing/usage/tenants`; `GET /billing/usage/trends`; `GET /billing/usage/top-tenants`

**DB tables:** `billing.usage_aggregations`

### APA-121 [HIGH] Usage metering has no ingestion source — dashboard is permanently empty

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** billing-service's UsageMeteringService.recordUsage/recordUsageBatch have zero production callers (only spec files invoke them), billing-service exposes no NATS/HTTP usage-ingestion endpoint (its only @MessagePatterns are the admin billing commands), and the 'metering:tenant:*' Redis keys are written solely by billing-service's own sync loop. The aggregator cron therefore never has readings to roll up into billing.usage_aggregations, so every widget on this page (and any metered-billing invoice math) shows zero forever.
- **Evidence:**
  - `apps/billing-service/src/modules/metering/usage-metering.service.ts:501,536 (recordUsage/recordUsageBatch definitions; grep across apps/ excluding __tests__ finds no callers)`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:153-440 (only admin command MessagePatterns — no usage subject)`
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts:93-101 (admin side is read-only by design)`
- **Verification:** Verified end-to-end. The only write path into billing.usage_aggregations is UsageAggregatorService.persistDirtyData, fed solely by the in-process EventEmitter2 'usage.recorded' event (usage-aggregator.service.ts:494), which only UsageMeteringService.processEvent emits (usage-metering.service.ts:597), reachable only via recordUsage/recordUsageBatch (lines 501/536) — which have zero production callers repo-wide (grep hits: the service itself, spec files, docs; the sensor-service hit is a comment borrowing the 'eviction sweep pattern'). Billing-service's entire NATS surface is 11 admin-command @MessagePatterns (billing-admin-nats.handler.ts:153-440); MeteringModule wires no controller/handler; libs/event-contracts has no usage-ingestion contract or subject in platform-event-registry.ts. The admin side (UsageMeteringManagementService) is read-only against the same table, so UsageDashboardPage is permanently zero. Blast radius exceeds the dashboard: GetTenantBillingHandler.getPersistedMonthUsage (tenant-facing usage metrics) and MeteredBillingService.calculateBilling (metered/overage invoice math) read the same empty table, so metered revenue never accrues. Two in-repo admissions corroborate: messaging-rate-limit.interceptor.ts:83 ('billable once messaging metering wires through') and migration 1801700000000-DropRetiredTenantUsageMetrics.ts, which retired a PRIOR usage model 'NO code path ever wrote' — this is the second instance of the same systemic class. HIGH stands (silent revenue under-collection + dead admin surface), not CRITICAL (no data corruption or security breach; failure mode is zeros, fail-safe for tenants).
- **Root cause:** The BE-ingestion link of the chain is missing, and it drifted because the metering bounded context was built inside-out: the ingestion API (recordUsage) was implemented as an in-process service method inside billing-service, while every real usage producer (gateway API calls, sensor readings, alerts sent, active users/farms/ponds/sensors gauges) lives in OTHER services. No cross-service ingestion contract (event interface, JSON schema, NATS subject, ACL) was ever defined in libs/event-contracts, so producers had nothing to publish to and were never wired. The read side (admin dashboard, tenant billing handler, metered invoice math) was then completed against the persisted usage_aggregations table, which masked the missing feed — everything type-checks and returns well-formed zeros. Systemic class: 'table-nobody-writes / dashboard-with-no-producer' — a repeat of the already-retired billing.tenant_usage_metrics (A6 / DB-IDENT-MEDIUM-002); the earlier remediation consolidated the two dead models into one but never gave the survivor an ingestion source, because nothing at build/test time requires a registered producer for a consumed table.
- **Fix design:** Pattern-level fix (make production automatic, make missing producers detectable) plus local application. (1) CONTRACT AT THE SOURCE: add UsageRecordedEvent (eventType 'UsageRecorded', flat per ADR-006, extends BaseEvent; fields tenantId, meterType, quantity, unit, source, resourceId?, plus BaseEvent eventId used as the idempotency key) to libs/event-contracts/src/billing-events.ts; move MeterType into the contract lib and have billing-service import it (kills the FE/BE/billing triple-definition drift risk); add a JSON Schema validator schemas/billing-usage-events.schema.ts (trust-boundary crossing per repo Event Contract Rules) and register the subject 'billing.usage.recorded' in platform-event-registry.ts with an explicit acl {publish: [gateway-api, sensor-service, alert-engine, messaging-service], subscribe: [billing-service]}. (2) SHARED PRODUCER (make correct behavior automatic): new UsageMeteringPublisher in libs/backend-common/src/metering/ that wraps createBaseEvent() + NATS publish behind one record(meterType, quantity, opts) method, so every service produces usage through one audited path instead of bespoke publishing. (3) BILLING INGESTION ENDPOINT: new @EventPattern handler apps/billing-service/src/modules/metering/handlers/usage-ingestion-nats.handler.ts subscribed to the registry subject, validating payloads against the JSON schema and delegating to UsageMeteringService.recordUsage with eventId as idempotencyKey (existing dedup map makes at-least-once NATS delivery safe); register it in MeteringModule and wire the microservice transport. NATS authz per ADR-015: add the subject to infrastructure/nats/services.yaml and regenerate nats.conf via scripts/nats/generate-nats-conf.py in the same commit. (4) WIRE REAL PRODUCERS: gateway-api response interceptor records API_CALLS per authenticated tenant; sensor-service ingestion persist path records SENSOR_READINGS (batch counts); alert-engine dispatch records ALERTS_SENT. Gauge meters (USERS/FARMS/PONDS/SENSORS_ACTIVE) that cannot land this session get a CRITICAL/HIGH tracked finding with owner+deadline per repo discipline — never shipped silently. (5) DETECTION GATE (prevents recurrence of the systemic class): an integration spec that publishes a UsageRecorded event over NATS and asserts a billing.usage_aggregations HOURLY row appears and the admin usage-summary endpoint returns non-zero; plus extend the event-registry invariant tests so a subject consumed by billing must declare at least one producer in its acl.
- **Files to change:**
  - `libs/event-contracts/src/billing-events.ts`
  - `libs/event-contracts/src/schemas/billing-usage-events.schema.ts`
  - `libs/event-contracts/src/schemas/index.ts`
  - `libs/event-contracts/src/index.ts`
  - `libs/event-contracts/src/platform-event-registry.ts`
  - `libs/backend-common/src/metering/usage-metering.publisher.ts`
  - `libs/backend-common/src/index.ts`
  - `apps/billing-service/src/modules/metering/usage-metering.service.ts`
  - `apps/billing-service/src/modules/metering/handlers/usage-ingestion-nats.handler.ts`
  - `apps/billing-service/src/modules/metering/metering.module.ts`
  - `apps/gateway-api/src/interceptors/api-usage-metering.interceptor.ts`
  - `apps/gateway-api/src/app.module.ts`
  - `apps/sensor-service/src/ingestion (persist-path service: call UsageMeteringPublisher for SENSOR_READINGS)`
  - `apps/alert-engine/src (dispatch path: call UsageMeteringPublisher for ALERTS_SENT)`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf (regenerated via scripts/nats/generate-nats-conf.py)`
  - `apps/billing-service/src/modules/metering/__tests__/usage-ingestion-nats.handler.spec.ts`
  - `e2e/tests/integration/usage-metering-ingestion.spec.ts`
- **Proof of fix:** New e2e/tests/integration/usage-metering-ingestion.spec.ts: publish a schema-valid UsageRecorded event on 'billing.usage.recorded' via NATS -> assert a billing.usage_aggregations HOURLY row materializes (via the aggregator flush) -> assert admin-api GET /billing/usage summary/trends endpoints return non-zero for that tenant/meter (proves the exact chain UsageDashboardPage renders). New apps/billing-service/src/modules/metering/__tests__/usage-ingestion-nats.handler.spec.ts: schema-invalid payload is rejected (never reaches recordUsage); valid payload delegates with eventId as idempotencyKey; duplicate eventId is deduplicated. Extend libs/event-contracts/src/__tests__ registry invariants: the billing.usage.recorded entry must declare non-empty publish acl (detects a future 'consumer with no producer'). Existing e2e/tests/integration/nats-invariants.spec.ts verifies the regenerated nats.conf matches services.yaml. Gateway/sensor/alert producer unit specs assert one publisher call per metered action.
- **Effort:** L

### APA-122 [MEDIUM] getUsageSummary swallows DB errors and returns zeros

- **Status:** DESIGNED (brief)
- **Symptom:** The summary endpoint catches every error and returns {totalTenants:0, totalEvents:0, meterBreakdown:[]} — a broken cross-schema read renders as the friendly 'No usage data available' empty state instead of an error, making failures indistinguishable from genuinely empty data.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts:169-177 (catch -> zeroed stats)`
  - `web/modules/admin-panel/src/pages/UsageDashboardPage.tsx:590-598 (empty state on empty meterBreakdown)`
- **Root cause:** getUsageSummary (usage-metering-management.service.ts:169-177) wraps its query in a try/catch that on any failure logs and returns a fully zeroed UsageSummaryStats. The FE (UsageDashboardPage.tsx:590-598) renders 'No usage data available' whenever meterBreakdown is empty, so a broken cross-schema read is indistinguishable from a legitimately empty period. Every other read method in the same service lets errors propagate, so this one is an inconsistent silent-failure mask.
- **Fix design:** Remove the swallow: delete the try/catch (or rethrow) so the exception propagates to the controller and returns a non-2xx, matching the rest of the service. In UsageDashboardPage add an explicit error branch (error banner) for the summary query rejection, distinct from the empty-data state the page currently shows. Add a service spec asserting getUsageSummary rejects when the repository throws. Tier 1/3: failures become visible and testable rather than rendered as empty.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts`
  - `web/modules/admin-panel/src/pages/UsageDashboardPage.tsx`
  - `apps/admin-api-service/src/billing/__tests__/usage-metering-management.service.spec.ts`
- **Effort:** S

### APA-123 [MEDIUM] 'Metered Billing Pricing Tiers' panel is hardcoded static content

- **Status:** DESIGNED (brief)
- **Symptom:** The included quantities and per-unit rates ('$0.0005-0.001/call', '5-500 GB' etc.) are a literal array in the page, unrelated to any pricing table — fabricated pricing presented as live configuration.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/UsageDashboardPage.tsx:727-731 (hardcoded meter/included/rate array)`
- **Root cause:** The 'Metered Billing Pricing Tiers' panel (UsageDashboardPage.tsx:720-748) renders a literal in-component array of meter names, included-quantity ranges, and per-unit rate ranges that exist nowhere in the data model — the ModulePricing model prices per-metric-per-module via pricingMetrics[].price + tierMultipliers and has no included-range/rate-card concept, and no metered_rate table backs these numbers. It is fabricated pricing shown to operators as authoritative live configuration ('See plan management for full pricing details').
- **Fix design:** Root-cause fix is removal: delete the fabricated static panel, since presenting invented numbers as configuration is the defect and there is no source to bind it to. If published metered/overage rates are a genuine product requirement, model them properly instead of hardcoding — a metered_rate_card table in the admin schema (entity + Baseline-style migration + read endpoint + FE type + api fn) — and render the panel from that data. Do not present static invented pricing as live under any circumstances.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/UsageDashboardPage.tsx`
- **Effort:** S

### APA-124 [LOW] tenantName never populated — rows show truncated UUIDs

- **Status:** DESIGNED (brief)
- **Symptom:** TenantUsageOverview/TopTenantUsage declare tenantName but the service never joins auth.tenants, so the FE fallback tenantId.slice(0,8) is what every row displays.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts:229-241 and 392-398 (no tenantName in mapping)`
  - `web/modules/admin-panel/src/pages/UsageDashboardPage.tsx:192,235 (tenant.tenantName || tenant.tenantId.slice(0, 8))`
- **Root cause:** TenantUsageOverview and TopTenantUsage declare an optional tenantName (usage-metering-management.service.ts:36, 62), but the service never resolves it — the return mappings (229-241 for getTenantUsageOverview, 392-398 for getTopTenantsByUsage) omit tenantName and no query joins auth.tenants. It is therefore always undefined and the FE always falls back to tenantId.slice(0,8) (UsageDashboardPage.tsx:192, 235). A declared-but-never-populated contract hole.
- **Fix design:** Populate tenantName from the authoritative tenant record in auth.tenants (per D14). In getAllTenantsUsage and getTopTenantsByUsage, after collecting the tenantId set, run a single batched cross-schema lookup `SELECT id, name FROM auth.tenants WHERE id = ANY($1)` (the same pattern module-pricing.service uses for auth.modules) and map names onto results; do the same for getTenantUsageOverview. Once consistently populated, make tenantName required in the return types (tier 1) so a missing name is a compile-time gap rather than a silent UUID fallback. Add a service spec asserting tenantName is resolved.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `apps/admin-api-service/src/billing/__tests__/usage-metering-management.service.spec.ts`
- **Effort:** M

### APA-125 [LOW] getAllTenantsUsage issues N+1 queries

- **Status:** DESIGNED (brief)
- **Symptom:** After the distinct-tenant query, it loops calling getTenantUsageOverview per tenant (default limit 50) — up to 51 sequential aggregate queries per dashboard load.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts:285-294`
- **Root cause:** getAllTenantsUsage (usage-metering-management.service.ts:285-294) runs a distinct-tenant query (limit 50) then a sequential for-loop that awaits getTenantUsageOverview per tenant. Each overview is itself a GROUP BY aggregate query (lines 197-212), so a dashboard load fires 1 distinct + 1 count + up to 50 sequential per-tenant aggregates = an N+1 fan-out whose query count scales with the page size.
- **Fix design:** Root-cause is per-tenant iteration of a query that can be expressed set-based. Rewrite getTenantUsageOverview's aggregate to also SELECT/GROUP BY ua.tenantId, add a private buildOverviewsForTenants(tenantIds[]) that runs ONE query with WHERE ua.tenantId IN (:...tenantIds) GROUP BY tenantId, meterType, unit, then partitions the raw rows into TenantUsageOverview[] in JS. getAllTenantsUsage calls it once with the page's tenantIds; getTenantUsageOverview becomes a thin single-id wrapper over the same builder so the two paths cannot diverge (tier 2: correct behavior automatic). Collapses 51 queries to 3 (distinct + count + one grouped fetch), independent of page size.
- **Files to change:**
  - `apps/admin-api-service/src/billing/services/usage-metering-management.service.ts`
  - `apps/admin-api-service/src/billing/services/__tests__/usage-metering-management.service.spec.ts`
- **Effort:** M


## Cross-cutting findings

### APA-126 [HIGH] Two disconnected plan catalogs: admin.plan_definitions is never enforced at subscription time

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The Plan Management page CRUDs admin.plan_definitions, but billing-service — the single writer for subscriptions — resolves provisioning plans exclusively from its own billing.plans catalog (seeded from the shared PLAN_CATALOG constant by its PlanSeedService) and deliberately avoids admin.plan_definitions. There is no sync between the two tables. Consequence: seeding, editing prices/limits, or deprecating a plan in the admin panel has zero effect on what tenants are actually subscribed to or billed; deprecating a plan in admin does not stop billing-service from provisioning that tier. The audit requirement 'plan CRUD persists and is enforced at subscription time' fails on the enforcement half.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts:100-179 (CRUD against admin.plan_definitions)`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:579-616 (resolveProvisioningPlan -> billing Plan repository, 'cross-tenant CATALOG table')`
  - `apps/billing-service/src/billing/entities/plan.entity.ts:72 (comment: avoids hot-path call to admin.plan_definitions)`
  - `apps/billing-service/src/billing/seed/plan-seed.service.ts (billing.plans seeded from PLAN_CATALOG, not from admin edits)`
- **Verification:** Refutation attempt failed — every escape hatch checked and closed. (1) FE Plan Management provably targets the admin catalog: PlanManagementPage.tsx:34 -> billingApi.getPlans/createPlan/updatePlan/deprecatePlan (services/api/billing.ts:43-61) -> admin-api REST /billing/plans* (billing.controller.ts:116-183) -> PlanDefinitionService -> admin.plan_definitions. (2) Enforcement provably targets the other catalog: subscription creation via admin panel REST is hard-blocked (billing.controller.ts:313-320 throws ConflictException 'billing-service-owned'); the only real subscription writer is billing-service, reached via NATS (BillingAdminCommandClientService), and its resolveProvisioningPlan (billing-admin-nats.handler.ts:579-629) and ChangeSubscriptionPlanHandler (change-subscription-plan.handler.ts:71,94-108) both resolve plans exclusively from billing.plans via manager.getRepository(Plan). Tenant provisioning sends only a tier string (tenant-provisioning-workflow.service.ts:1017,1102 toBillingCommandPlanTier) — admin.plan_definitions is never consulted. (3) No sync exists: grep for plan_definitions/PlanDefinition across billing-service hits only comments; no PlanCreated/PlanUpdated/PlanDeprecated event exists in libs/event-contracts; PlanSeedService seeds billing.plans from the PLAN_CATALOG constant and explicitly skips existing rows. plan.entity.ts:70-75 even documents that Stripe IDs were denormalized onto billing.plans specifically to AVOID reading admin.plan_definitions. (4) The 2026-06-25 owner decision in libs/event-contracts/src/billing/plan-catalog.ts:31-41 ('billing.plans is the value authority') unified only the STATIC limit constants; the live-editable admin CRUD surface was left writing a table nothing enforces. Concrete failure: SUPER_ADMIN deprecates STARTER or edits its price in the admin panel; admin.plan_definitions updates; the next tenant provisioned on tier=starter still resolves the active billing.plans STARTER row at the old price/limits (resolveProvisioningPlan filters only billing.plans isActive), and the invoice scheduler continues billing off billing.plans-derived subscription pricing. Bonus confirmation of the disconnect: the admin-side change-plan NATS command forwards planIds, but the only plan IDs the admin FE can ever list are admin.plan_definitions UUIDs, which do not exist in billing.plans — ChangeSubscriptionPlanHandler would 404 ('Plan with id X not found'). Severity HIGH is correct: operator-facing business-integrity failure (plan governance silently no-ops), but not CRITICAL — no privilege/tenancy breach and billing stays internally self-consistent.
- **Root cause:** The FE->BE chain is intact; the break is that the admin write path terminates in a database table no enforcement path reads. Historically admin-api owned a full local billing model (admin.plan_definitions + local subscription services). The billing revival then made billing-service the SSoT for subscription state (D14) and moved every subscription MUTATION behind NATS admin commands (create-subscription and change-plan endpoints in admin-api now throw or forward), and SSOT-C-13 unified the static per-tier limit NUMBERS into the PLAN_CATALOG constant — but the plan-catalog CRUD surface itself was never migrated. admin-api kept PlanDefinition entity/service/controller writing admin.plan_definitions while every enforcement site (resolveProvisioningPlan, ChangeSubscriptionPlanHandler, Stripe price resolution via billing.plans.stripe_price_ids, invoice scheduler) reads billing.plans, whose rows are seeded once from PLAN_CATALOG and only writable through billing-service's own CreatePlan/UpdatePlan/DeactivatePlan CQRS handlers (exposed only on billing's GraphQL resolver, which the admin panel does not use). Result: a UI-editable config-table-nobody-reads. This is the systemic 'admin-api holds a local shadow copy of another service's enforced store' class — the same drift mechanism SSOT-C-13 cured for constants recurring at the table level.
- **Fix design:** Pattern-level fix (tier 1 — make the wrong behavior impossible): ONE plan catalog with ONE writer, following the already-recorded authority decision (plan-catalog.ts 2026-06-25: billing.plans is the value authority; D14: billing is the subscription SSoT). Do NOT build an admin->billing sync/event mirror — that preserves dual truth and is exactly the compat-shim class CLAUDE.md bans. Instead make the admin panel a client of billing's enforced catalog through the billing-admin NATS command channel that every other billing mutation already uses. Local application: (a) Contracts — add PLAN catalog admin commands (LIST_PLANS, GET_PLAN, CREATE_PLAN, UPDATE_PLAN, DEPRECATE_PLAN) with typed command/result interfaces to libs/event-contracts/src/billing-admin-commands.ts (register subjects alongside the existing BILLING_ADMIN_COMMAND_SUBJECTS). (b) billing-service — extend billing-admin-nats.handler.ts (same idempotency-receipt discipline) to dispatch these subjects to the ALREADY-EXISTING CreatePlan/UpdatePlan/DeactivatePlan CQRS handlers; extend Plan entity + an additive migration with the admin-governed commercial/presentation fields admin.plan_definitions carries today (visibility, isRecommended, trialDays, gracePeriodDays, per-cycle pricing block, marketing copy, icon/color/badge) so the unified catalog is a superset — nullable columns, blue-green safe; DeactivatePlan already gates provisioning because resolveProvisioningPlan and ChangeSubscriptionPlanHandler filter isActive, so deprecation becomes enforced automatically the moment the write lands in billing.plans. (c) admin-api — repoint the /billing/plans* controller routes to new BillingAdminCommandClientService methods; delete PlanDefinitionService's CRUD/seed and the PlanDefinition entity; one-shot data migration folds any live admin.plan_definitions edits into billing.plans, then a follow-on migration drops admin.plan_definitions (tracked in the same PR); SubscriptionPlanChangeService.previewPlanChange must read the billing catalog via the query channel so preview and execution use the same plan IDs (this also fixes the latent change-plan ID mismatch). (d) FE — update services/types/billing.ts PlanDefinition to the unified contract shape and adjust services/api/billing.ts + PlanManagementPage.tsx field usage. (e) Systemic gate (tier 3) — new invariant spec forbidding any admin-api entity that shadows another service's enforced catalog table (greps admin-api entities for plan/pricing catalog duplicates, and asserts admin.plan_definitions no longer exists in the baseline+migrations), so the config-table-nobody-reads class cannot silently reappear.
- **Files to change:**
  - `libs/event-contracts/src/billing-admin-commands.ts`
  - `libs/event-contracts/src/platform-event-registry.ts`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts`
  - `apps/billing-service/src/billing/handlers/create-plan.handler.ts`
  - `apps/billing-service/src/billing/handlers/update-plan.handler.ts`
  - `apps/billing-service/src/billing/handlers/deactivate-plan.handler.ts`
  - `apps/billing-service/src/billing/entities/plan.entity.ts`
  - `apps/billing-service/src/database/migrations/<new>-ExtendPlanCatalogAdminFields.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/billing-admin-command-client.service.ts`
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts`
  - `apps/admin-api-service/src/billing/entities/plan-definition.entity.ts`
  - `apps/admin-api-service/src/billing/services/subscription-plan-change.service.ts`
  - `apps/admin-api-service/src/billing/billing.module.ts`
  - `apps/admin-api-service/src/migrations/<new>-MigrateAndDropPlanDefinitions.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/pages/PlanManagementPage.tsx`
  - `e2e/tests/integration/plan-catalog-enforcement.spec.ts`
  - `tests/invariants/plan-catalog-single-authority.spec.ts`
- **Proof of fix:** New e2e/tests/integration/plan-catalog-enforcement.spec.ts: (1) admin API updatePlan(price/limits) -> provision a tenant on that tier -> assert the created billing.subscriptions row carries the edited price/limits; (2) admin API deprecatePlan -> provisioning that tier returns CATALOG_MISSING/NotFound and change-plan to it is rejected ('deactivated'); (3) plan IDs returned by admin GET /billing/plans resolve successfully in ChangeSubscriptionPlanHandler (kills the cross-catalog ID mismatch). Extend apps/billing-service/src/billing/__tests__/plan-crud.handler.spec.ts to cover the NATS admin subjects dispatching to the CQRS handlers with idempotency receipts. New tests/invariants/plan-catalog-single-authority.spec.ts: asserts no admin-api entity/migration declares a plan-catalog table (admin.plan_definitions absent) and that the only @Entity mapping a plan catalog is billing Plan — making regression of the shadow-catalog class build-time detectable. Existing e2e/tests/integration/schema-invariants.spec.ts must stay green after the table drop.
- **Effort:** L

### APA-127 [HIGH] Discount codes are never applied in any real revenue flow

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** admin.discount_codes validation/redemption is real code, but the only mutation path that records a redemption is POST /billing/discounts/apply — an endpoint no audited page calls. billing-service (invoice generation, subscription provisioning, renewals — the actual money paths) contains no reference to admin.discount_codes; grep of apps/billing-service finds none. The pricing calculator applies codes only to ephemeral quotes that are never persisted or linked to invoices. Net effect: an admin can create and 'validate' codes, but no subscription or invoice amount is ever automatically discounted, and currentRedemptions/redemption analytics only move if someone manually POSTs the admin apply endpoint.
- **Evidence:**
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:321-385 (applyDiscount writes admin.discount_redemptions — admin-api only)`
  - `apps/admin-api-service/src/billing/billing.controller.ts:261-274 (the sole /discounts/apply surface; no FE page invokes billingApi.applyDiscount)`
  - `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts:180-193 (codes applied to quotes only)`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts:153-236 (provisioning computes totals from module items — no discount-code lookup)`
- **Verification:** Verified end-to-end. (1) FE: DiscountCodePage.tsx calls only list/stats/generate/create/deactivate; repo-wide grep shows billingApi.applyDiscount and validateDiscountCode are defined in services/api/billing.ts:77-88 with zero callers. (2) The sole writer of admin.discount_redemptions is DiscountCodeService.applyDiscount (discount-code.service.ts:321-385), reachable only via POST /billing/discounts/apply (billing.controller.ts:261-274) — an endpoint nothing invokes. (3) billing-service has zero references to admin.discount_codes: provisioning (billing-admin-nats.handler.ts:210-216) sets basePrice = sum(moduleItems.total) where moduleItems come from resolveProvisioningModuleItems (module-assignment.service.ts:393-397) which calls calculatePricing WITHOUT a discountCode (discountAmount = tierDiscount only); renewal invoices (billing-scheduler.service.ts:291-340) bill raw pricing.basePrice with no discount state on billing.subscriptions, making DiscountDuration/durationInMonths dead columns; CreateInvoiceHandler (create-invoice.handler.ts:76-135) accepts a caller-typed discount number and free-string discountCode label with no registry validation and no redemption write. (4) auth-service has no discount references; MeteredBillingService.applyDiscount takes caller-supplied type/value and has no production callers. Bonus defect: quote-time validateCode uses hardcoded tenantId 'system-quote' (pricing-calculator.service.ts:322-327) so per-tenant limits are never evaluated. HIGH confirmed (not CRITICAL: no incorrect automatic charge occurs; the harm is an inert financial instrument — tenants promised discounts are billed full price, redemption caps/analytics permanently zero). Systemic class: config-table-nobody-reads + FE-api-fn-with-no-caller.
- **Root cause:** The BE-to-BE contract link broke at the single-writer boundary. Discount codes were built as a self-contained CRUD+validate+apply feature inside admin-api-service (admin.discount_codes / admin.discount_redemptions, HTTP-only apply), while every real money path — subscription provisioning, scheduler-generated renewal invoices, admin invoice creation — is owned by billing-service behind the NATS command boundary. When that boundary was hardened (ORPHAN-CRITICAL-393/394: admin-api resolves priced moduleItems, billing writes them verbatim), the resolved-pricing contract (BillingTenantProvisioningCommand in libs/event-contracts/src/billing-admin-commands.ts) was never given a discount slot: resolveProvisioningModuleItems omits discountCode from calculatePricing, billing.subscriptions persists no discount state for the scheduler to read, invoices.discount_code is an unvalidated free string, and InvoiceGeneratedEvent carries no discount fields for admin-api to close the redemption loop. Redemption therefore drifted to a manual admin endpoint no page calls — the config-table-nobody-reads pattern applied to a revenue-bearing catalog.
- **Fix design:** Architectural fix at the contract source, preserving both schema-ownership (admin-api owns admin.*, billing owns billing.*) and the single-writer rule — same resolved-snapshot pattern already established for moduleItems (ORPHAN-CRITICAL-393). Tier 1 (make wrong shape unrepresentable): in libs/event-contracts/src/billing-admin-commands.ts add a ResolvedDiscount snapshot type {discountCodeId, code, type, value, duration, durationInMonths?, amountMonthly} to BillingTenantProvisioningCommand, and on the admin create-invoice input REPLACE the independent `discount?: number` + `discountCode?: string` pair with one structured `discount?: {discountCodeId, code, amount}` object so a code can never be persisted without a registry-resolved amount (free-string labels become a compile error at both ends). Tier 2 (make correct behavior automatic): (a) admin-api resolves/validates the code once — CreateTenantPage gains a discount-code field wired into the quote AND the provisioning DTO (tenant.dto.ts, class-validator); tenant-provisioning-workflow passes the validated snapshot in the command; calculatePricing/validateCode take the real tenantId instead of 'system-quote'. (b) billing persists discount state: nullable discount_code_id/discount_code/discount_type/discount_value/discount_duration/discount_months_remaining columns on billing.subscriptions (new migration, blue-green safe); provisioning handler applies amountMonthly to basePrice and stores duration; billing-scheduler applies the persisted discount to each renewal while months_remaining > 0 (or FOREVER), decrements it, and stamps invoice.discount/discountCode. (c) close the redemption loop event-wise: extend InvoiceGeneratedEvent (billing-events.ts + JSON Schema in schemas/) with discountCodeId/discountAmount; a new admin-api NATS subscriber records admin.discount_redemptions idempotently keyed by invoiceId and increments currentRedemptions — replacing manual apply as the only redemption writer; the initial provisioning redemption is recorded by the saga on success, idempotent on operationId. (d) DELETE POST /billing/discounts/apply and billingApi.applyDiscount (unconsumed side-effect surface that would double-count if ever called); keep /discounts/validate for quote-time checks. Tier 3 gates listed under verification, including the pattern-level dead-api-fn detector for the systemic class.
- **Files to change:**
  - `libs/event-contracts/src/billing-admin-commands.ts`
  - `libs/event-contracts/src/billing-events.ts`
  - `libs/event-contracts/src/schemas/invoice-generated.schema.json`
  - `apps/admin-api-service/src/modules/tenant-management/services/module-assignment.service.ts`
  - `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/handlers/invoice-generated-redemption.handler.ts`
  - `apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts`
  - `apps/admin-api-service/src/tenant/dto/tenant.dto.ts`
  - `apps/billing-service/src/billing/entities/subscription.entity.ts`
  - `apps/billing-service/src/database/migrations/1800000000001-AddSubscriptionDiscount.ts`
  - `apps/billing-service/src/billing/handlers/billing-admin-nats.handler.ts`
  - `apps/billing-service/src/billing/handlers/create-invoice.handler.ts`
  - `apps/billing-service/src/billing/dto/create-invoice.input.ts`
  - `apps/billing-service/src/billing/billing-scheduler.service.ts`
  - `web/modules/admin-panel/src/pages/CreateTenantPage.tsx`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `web/modules/admin-panel/src/services/types/billing.ts`
- **Proof of fix:** (1) NEW apps/billing-service/src/billing/__tests__/billing-scheduler.discount.spec.ts: a subscription persisted with a REPEATING discount produces a renewal invoice with discounted total + stamped code, decrements discount_months_remaining, and stops discounting at 0; FOREVER keeps applying; no-discount subscriptions bill basePrice unchanged. (2) EXTEND apps/billing-service/src/billing/handlers/__tests__/billing-admin-nats.handler.spec.ts: provisioning with a ResolvedDiscount snapshot persists the discount columns and discounted basePrice; a command carrying a bare code string without a snapshot fails compilation (contract) and a snapshot-less legacy payload is rejected VALIDATION_ERROR at the boundary. (3) NEW apps/admin-api-service/src/billing/__tests__/discount-redemption-loop.spec.ts: InvoiceGenerated with discount fields yields exactly one admin.discount_redemptions row (idempotent on invoiceId, replay-safe) and increments currentRedemptions; asserts the controller route table no longer exposes POST /billing/discounts/apply. (4) PATTERN-LEVEL gate for the systemic class: NEW web/modules/admin-panel/src/__tests__/api-surface-usage.spec.ts — every exported fn in services/api/*.ts must be referenced by at least one page/component/hook, failing the build on any future dead admin-api endpoint.
- **Effort:** L

### APA-128 [MEDIUM] Service-exported interface 'DTOs' bypass the global ValidationPipe across the billing surface

- **Status:** DESIGNED (brief)
- **Symptom:** CreatePlanDto, UpdatePlanDto, CreateDiscountCodeDto, UpdateDiscountCodeDto, SetModulePricingDto, CreateCustomPlanDto, UpdateCustomPlanDto, QuoteRequest, and PlanChangeRequest are TypeScript interfaces imported from service files, so their @Body() metatype erases to Object and the global ValidationPipe (whitelist:true, forbidNonWhitelisted:true, transform:true) skips them entirely. Nine billing write endpoints on a financial admin surface accept arbitrary payload shapes with no runtime validation — contrary to the platform's own mandated ValidationPipe posture. (All are still behind the SUPER_ADMIN PlatformAdminGuard, which was verified as a global APP_GUARD with RS256 verify + role check, so this is a defense-in-depth gap rather than an open hole.)
- **Evidence:**
  - `apps/admin-api-service/src/billing/billing.controller.ts:142,150,227,234,376,477,507,562,569 (interface-typed @Body params)`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:21-54 and plan-definition.service.ts:16-57 and module-pricing.service.ts:19-28 (interface definitions)`
  - `apps/admin-api-service/src/app.module.ts:277-290 (PlatformAdminGuard as APP_GUARD) and guards/platform-admin.guard.ts:151-179 (SUPER_ADMIN enforcement)`
- **Root cause:** CreatePlanDto/UpdatePlanDto (plan-definition.service.ts:16-57), CreateDiscountCodeDto/UpdateDiscountCodeDto (discount-code.service.ts:21-54), SetModulePricingDto (module-pricing.service.ts:19-28), CreateCustomPlanDto/UpdateCustomPlanDto, QuoteRequest and PlanChangeRequest are TypeScript interfaces co-located with business logic and used directly as @Body() types in billing.controller.ts (142,150,227,234,376,477,562,569). Interfaces erase to nothing at runtime, so the reflected param metatype is Object; NestJS ValidationPipe.toValidate() returns false for Object, so whitelist/forbidNonWhitelisted/transform are complete no-ops. Nine financial-admin write endpoints accept arbitrary payloads. This is the systemic 'unvalidated interface-DTO' class — same footgun everywhere an interface is used as @Body(). Guard (SUPER_ADMIN APP_GUARD) still applies, so it is defense-in-depth, not an open hole.
- **Fix design:** Promote each to a class DTO in billing/dto/ with class-validator decorators (@IsString/@IsEnum/@IsNumber/@IsOptional; nested @ValidateNested()+@Type() classes for PlanLimits/PlanPricing/PlanFeatures, PricingMetric[]/TierMultipliers, quote/plan-change shapes). Model ONLY client-supplied fields — drop server-injected createdBy/updatedBy from the request DTO since the controller already spreads userId in. Services import the class as their param type (or a structural input type it satisfies) so domain layer stays decorator-free. Highest tier: make future drift detectable — add an architecture spec that reflects every controller's ROUTE_ARGS metadata and asserts each @Body() metatype is a class carrying class-validator metadata (rejects Object/interface-typed bodies) so a new interface @Body() fails CI.
- **Files to change:**
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/services/plan-definition.service.ts`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
  - `apps/admin-api-service/src/billing/services/pricing-calculator.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-management.service.ts`
  - `apps/admin-api-service/src/__tests__/e2e/body-dto-validation.architecture.spec.ts`
- **Effort:** L

### APA-129 [MEDIUM] Unmanaged envelope/pagination contract between ResponseInterceptor and hand-written FE types

- **Status:** DESIGNED (brief)
- **Symptom:** ResponseInterceptor lifts any handler result containing both 'data' and 'total' keys into {data, meta:{page,...}}, and the FE http-client re-flattens meta.page results into {data,...meta}. Because FE types are hand-written with no codegen, every endpoint whose service returns the {data,total,page,limit} shape silently changes contract at the boundary: discounts list (broken page), tenant redemptions, and module-pricing history all return {data:[...],...} where FE types expect bare arrays. Endpoints returning {items,...} or {subscriptions,...} dodge the lift only by accident of key naming. This shape-dependent magic is the root cause of the DiscountCodePage break and a standing trap for every new billing endpoint.
- **Evidence:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts:46-65 (key-sniffing lift condition)`
  - `web/modules/admin-panel/src/services/http-client.ts:341-351 (meta.page re-flattening)`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts:114,410 and module-pricing.service.ts:287 (three {data,total,page,limit} producers vs array-typed FE signatures in services/api/billing.ts:64,94,96)`
- **Root cause:** The pagination envelope is negotiated by key-sniffing on BOTH sides with no shared contract or codegen. ResponseInterceptor (response.interceptor.ts:46-65) lifts any result containing both 'data' and 'total' into {data, meta:{page,limit,total,totalPages}}; the FE http-client (http-client.ts:341-351) re-flattens results whose meta has a 'page' key into {data,...meta}. So discount-code.service.findAll (:114), getTenantRedemptions (:410) and module-pricing.getPricingHistory (:287) all emit {data,total,page,limit} and get lifted, but the FE signatures getDiscountCodes/getTenantRedemptions/history (services/api/billing.ts:64,96) are typed as bare arrays — silent contract break (the DiscountCodePage crash). Meanwhile getRedemptions ({redemptions,total}) and getSubscriptions ({subscriptions,total}) dodge the lift only because they lack a 'data' key. Whether the magic fires depends on accidental key naming — a standing trap for every new list endpoint.
- **Fix design:** Replace key-sniffing with an explicit, typed pagination contract (tier 1). Introduce a canonical Paginated<T> = {data:T[]; total; page; limit; totalPages} plus a paginate() helper in a shared module; make ALL list services return it (rename {redemptions}->data, {subscriptions}->data, {items}->data). Change ResponseInterceptor to lift ONLY a branded marker (a non-enumerable Symbol tag set by paginate(), or instanceof PaginatedResult) instead of the 'data'+'total' heuristic, so ordinary DTOs that happen to carry those keys are never misread. On FE, key the http-client re-flatten off that same stable envelope marker (meta present with total/page from a tagged list response), and retype every list api fn as Paginated<T> instead of T[]. Highest tier for the hand-written-types gap: add a cross-boundary contract spec (e2e/tests/integration/response-envelope-contract.spec.ts) enumerating list endpoints, asserting each returns the canonical envelope AND that the FE Paginated<T> matches, so envelope drift fails CI rather than surfacing as a runtime .map crash.
- **Files to change:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts`
  - `apps/admin-api-service/src/billing/services/discount-code.service.ts`
  - `apps/admin-api-service/src/billing/services/module-pricing.service.ts`
  - `apps/admin-api-service/src/billing/services/subscription-management.service.ts`
  - `web/modules/admin-panel/src/services/http-client.ts`
  - `web/modules/admin-panel/src/services/api/billing.ts`
  - `e2e/tests/integration/response-envelope-contract.spec.ts`
- **Effort:** L

## Finding registry anchors

Registry IDs (`docs/reviews/_registry/findings.jsonl`) tracking findings in this document:

- **ADMIN-CRITICAL-082** — APA-106: RC-1's **backend** half had already landed — every admin-api list producer returns `createStandardPaginatedResult`, the interceptor lifts `items` into the envelope's `data` slot, and the `admin-api-pagination-canonical` gate is green — which is exactly why this looked closed from the producer side while two pages stayed permanently empty. The **consumer** half was never finished. `getDiscountCodes` was declared `DiscountCode[]` against that paginated producer, so the page received `{data,total,page,limit,totalPages}` and asked `Array.isArray(codesResult) ? codesResult : []`. An envelope is never an array, so the guard had **exactly one possible outcome**: every load selected `[]`. Every discount code persisted to `admin.discount_codes` and none was ever visible, deactivatable or inspectable. What makes this class worse than a crash is that the guard was written to be *safe*: no stack trace, no error toast, no failed request in the network tab — just a clean, confident "no rows" that nobody reports. `MaintenancePage` carried the identical defect, and there the api type was **already correct** — an `as unknown as MaintenanceWindow[]` cast is what let the page array-test the envelope anyway. Removing that cast surfaced a drifted contract underneath: the canonical `MaintenanceWindow` disagreed with the entity on `scope` (no `region`), `type` (three members against the enum's five), `estimatedDurationMinutes`, `affectedTenants` and `updatedAt` — while the page carried a *more accurate* shadow copy of the same name. Correcting the canonical type then let the compiler find a **live form defect**: the submit handler cast `type` to `'scheduled' | 'emergency' | 'rolling'`, a union the backend enum does not contain, while the dropdown correctly offers `rolling_update`. The runtime value was right all along; the cast was the lie, and it is what kept the drift invisible. The create payload also moved off `Omit<MaintenanceWindow, …>` onto a DTO-shaped input — the same read-model-as-write-contract anti-pattern closed in APA-150. Tier-3: `admin-panel-paginated-consumer.spec.ts` derives the paginated api surface from the declared generics and forbids `Array.isArray` on the **envelope** (`Array.isArray(x.data)` is correct and deliberately unmatched), scoping each search between bindings so a name re-bound in a sibling function is not blamed for another's guard.

Registry IDs (`docs/reviews/_registry/findings.jsonl`) tracking findings in this document:

- **ADMIN-MEDIUM-059** — APA-122: `getUsageSummary` was the LONE silent-failure mask in `UsageMeteringManagementService` — it wrapped its whole body in try/catch and returned fully-zeroed stats, so a broken cross-schema read reached the Usage dashboard as HTTP 200 with an empty `meterBreakdown`, indistinguishable from a genuinely empty period (every sibling read — `getTenantUsageOverview`, `getAllTenantsUsage`, `getUsageTrends`, `getTopTenantsByUsage` — already propagates). Fix: deleted the swallow, plus the now-dead logger field and unused `Logger` import. A log-and-rethrow was deliberately NOT used (no sibling read logs; Nest logs unhandled exceptions at the framework level), unlike APA-053 where the surrounding class does log-and-rethrow. No FE change needed: `UsageDashboardPage` already renders a red error banner + Retry on `(summaryError && !summary)` — that branch was simply unreachable while the backend returned 2xx. Tier-3: `usage-metering-management.service.spec.ts`; red-proven.
- **ADMIN-MEDIUM-057** — APA-107: `generateUniqueCode` emitted `PREFIX_XXXXXXXX` (underscore-joined) but `create()` silently stripped the underscore via `replace(/[^A-Z0-9]/g,'')`, so the discount code shown to the admin was NOT the one stored or looked up (and `generateUniqueCode`'s own uniqueness check ran against the un-normalized candidate). Fix (Tier-1, one canonical form + loud rejection): a single `normalizeCode()` helper; `generateUniqueCode` composes the canonical prefix (no underscore) so generated === stored === looked-up, and `create()` throws `BadRequestException` for any input carrying a character outside `[A-Z0-9]` instead of silently mutating it. No migration (no stored code ever contained an underscore), no FE change. Tier-3: `discount-code.service.spec.ts` pins the generate→create round-trip and the rejection; red-proven.
- **ADMIN-HIGH-024** — Phase-1 RC-2 systemic class: interface-typed `@Body`/`@Query` params across admin-api (billing, modules, messaging-admin, settings, tenant-config) silently disabled the global ValidationPipe, and an unvalidated `sortBy` was interpolated raw into SQL `ORDER BY`. Converted all 31 flagged whole-object request params to validated DTO classes, hardened `sortBy` against a column allowlist SSoT (`@IsIn` at both DTOs + sink re-clamp), and added the `controller-dto-validation.architecture` gate (no allowlist) that fails on any interface-typed body/query. Closes APA-067/076/094/103/118/128/179/220/249/348/364/355/045/039 (+ the APA-258 FE validation-error-detail fix).
