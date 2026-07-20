# System Management — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## FeatureTogglesPage — `/admin/system/features` — verdict: **PARTIAL**

**Chain:** List/create/delete work end-to-end: FE systemSettingsApi (web/modules/admin-panel/src/services/api/settings.ts:85-101) -> nginx rewrite /api -> /api/v1 (infrastructure/nginx/droplet.conf:377-383) -> GlobalSettingsController @Controller('system/settings') (apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:426) -> GlobalSettingsService real TypeORM queries against admin.feature_toggles (services/global-settings.service.ts:166-200), table created by Baseline migration (apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:56-59). SUPER_ADMIN enforced by global APP_GUARD PlatformAdminGuard (src/app.module.ts:283-289, src/guards/platform-admin.guard.ts:151-177). However the page's headline Enable/Disable action hits a route that does not exist, the Edit form is always rejected by DTO validation, and no code anywhere in the platform ever reads or evaluates the toggles - they gate nothing.

**Endpoints exercised:** `GET /api/v1/system/settings/feature-toggles`; `POST /api/v1/system/settings/feature-toggles`; `PUT /api/v1/system/settings/feature-toggles/:id`; `DELETE /api/v1/system/settings/feature-toggles/:id`; `POST /api/v1/system/settings/feature-toggles/:id/toggle (FE-only, no backend route)`; `GET /api/v1/system/settings/feature-toggles/key/:key (FE-only, no backend route)`; `POST /api/v1/system/settings/feature-toggles/evaluate`

**DB tables:** `admin.feature_toggles`

### APA-260 [CRITICAL] Enable/Disable button calls POST feature-toggles/:id/toggle which has no backend route (404)

- **Status:** PENDING
- **Symptom:** FE toggleFeature posts to `/system/settings/feature-toggles/${id}/toggle` (services/api/settings.ts:95-96) and the page's primary Enable/Disable button uses it (FeatureTogglesPage.tsx:105-120). GlobalSettingsController defines only POST feature-toggles, GET, GET/:id, PUT/:id, DELETE/:id, POST evaluate, POST refresh-cache (global-settings.controller.ts:434-489) - there is no :id/toggle route. Every toggle attempt 404s; the contract test knowingly allowlists this drift instead of failing (apps/admin-api-service/src/__tests__/contract-validation.spec.ts:634-639: 'Backend uses PUT ... with status field').
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:95-96`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:105-120`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:434-489`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:634-639`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-261 [HIGH] Edit form always 400s: FE sends scope and isExperimental but UpdateFeatureToggleDto does not whitelist them

- **Status:** PENDING
- **Symptom:** handleUpdate sends {name, description, scope, category, rolloutPercentage, isExperimental} (FeatureTogglesPage.tsx:153-160). UpdateFeatureToggleDto (global-settings.controller.ts:86-132) has no `scope` and no `isExperimental` fields. The platform-wide ValidationPipe runs with whitelist:true + forbidNonWhitelisted:true (libs/backend-common/src/bootstrap/create-service-app.ts:458-461), so every update request is rejected with 400. Saving an edit can never succeed.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:153-160`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:86-132`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-461`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-262 [HIGH] Feature toggles are persisted but consumed by nothing - no gating code exists anywhere

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The only callers of the evaluate endpoint / getFeatureToggleByKey are the admin panel's own unused API wrappers (services/api/settings.ts:88, 97-101). Repo-wide grep finds no backend service, gateway middleware, or frontend module that reads admin.feature_toggles or calls /feature-toggles/evaluate to gate behavior. Creating/enabling a toggle has zero effect on the platform - the page is administrative theater over a real table.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:88`
  - `web/modules/admin-panel/src/services/api/settings.ts:97-101`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:477-483`
- **Verification:** Confirmed on re-read. The write chain (FeatureTogglesPage -> admin-api CRUD -> admin.feature_toggles) is intact, and the evaluation engine (global-settings.service.ts:202-303: status, schedule, tenant allow/deny, conditions, percentage bucket, variants) is real — but toggle state propagates only into a process-local Map (featureToggleCache, line 67) inside admin-api itself; there is no event publication, no snapshot RPC, no consumer client, and no FE hook anywhere in the platform. Two latent contract breaks on this exact surface prove zero calls ever happened: (1) the FE evaluate wrapper (settings.ts:97-101) POSTs {key, context} in the body while the controller (global-settings.controller.ts:477-483) reads @Query('key') plus a flat EvaluateFeatureToggleDto — with the platform ValidationPipe (whitelist+forbidNonWhitelisted) that body is a guaranteed 400; (2) FeatureTogglesPage.tsx:108 calls toggleFeature -> POST /system/settings/feature-toggles/:id/toggle, a route the controller does not declare (404 — the page's enable/disable switch is itself broken). This is an instance of the systemic config-table-nobody-reads class, with FE-route-with-no-backend and DTO-shape-mismatch instances riding on the same surface. The repo already remediated the sibling instance (ORPHAN-HIGH-373: legacy admin-api settings stores retired, real dynamic config moved to config-service with the config-runtime contract + backend-common config-client), which is the established pattern this fix must join.
- **Root cause:** The broken link is the DB->platform consumption edge: the feature was built store-first (UI + CRUD + table + evaluator) and the chain terminates at admin.feature_toggles — no consumption contract was ever defined. No FeatureToggleChanged event exists in libs/event-contracts, no NATS snapshot subject, no consumer client in libs/backend-common, no gateway endpoint or shared-ui hook, and no typed binding between toggle keys and the code paths they should gate (keys are free-text created at runtime, so nothing can compile against them). It drifted because the platform's real dynamic-config distribution architecture was built later around config-service (ConfigurationChanged outbox signal + config.runtime.* request-reply + libs/backend-common/src/config-client, per config-runtime.ts), and the ORPHAN-HIGH-373 remediation retired the analogous admin-api settings stores but left feature_toggles stranded on the pre-distribution pattern. With no consumer to exercise the contract, the evaluate endpoint (query-vs-body mismatch) and the FE toggle switch (missing /:id/toggle route) silently rotted — the absence of any contract test on this surface is the detection gap that let the theater persist.
- **Fix design:** Systemic class: config-table-nobody-reads. Fix at pattern level by giving feature toggles the same runtime-distribution contract the repo already established for config-service (config-runtime.ts precedent), plus a typed key registry that makes orphan toggles structurally impossible.

PATTERN LEVEL — feature-toggle runtime contract (Tier 1 + 2):
1. New contract module libs/event-contracts/src/feature-toggle-runtime.ts (exported via index.ts, mirroring config-runtime.ts): (a) FEATURE_TOGGLE_SUBJECTS = { SNAPSHOT: 'feature.toggles.snapshot' } — ADR-031-style NATS request-reply, cert-CN identity (exact precedent: INGEST_BACKEND_POLICY_SUBJECTS + apps/admin-api-service/src/policy/services/policy-snapshot.responder.ts); (b) FeatureToggleRule — the wire snapshot shape (key/scope/status/conditions/rolloutPercentage/rolloutSchedule/enabledTenants/disabledTenants/variants/defaultValue), keeping the TypeORM entity as persistence-only per the domain/persistence split; (c) FeatureToggleChangedEvent extends BaseEvent (eventType 'FeatureToggleChanged', metadata-only: key, status, changedAt — no rules payload; consumers re-pull the snapshot), with a *.schema.ts validator in schemas/ and registration in platform-event-registry.ts; (d) FEATURE_KEYS typed registry: const object of { key, description, defaultEnabled, owner } with type FeatureKey = keyof typeof FEATURE_KEYS — every consumer API takes FeatureKey, so checking an undeclared flag is a compile error, and admin-api rejects create/update for keys outside the registry, so a toggle that gates nothing cannot be created (Tier 1); (e) the pure evaluator moved out of GlobalSettingsService (evaluateFeatureToggle/evaluateWithVariants/evaluateConditions/calculateBucket) into the contract lib so admin-api and every consumer produce identical decisions — single evaluation-semantics SSoT (precedent: canonicalConfigRuntimeBody lives in config-runtime.ts).
2. Distribution (Tier 2 — automatic): admin-api adds FeatureToggleSnapshotResponder (clone of PolicySnapshotResponder) serving all rules on feature.toggles.snapshot; GlobalSettingsService create/update/delete/toggle writes FeatureToggleChanged through the existing admin_outbox (apps/admin-api-service/src/outbox/) in the same transaction — the process-local Map stops being the propagation mechanism. NATS grants added in infrastructure/nats/services.yaml + regenerated nats.conf in the same commit (ADR-015).
3. Consumer client libs/backend-common/src/feature-flags/ (FeatureFlagsModule + FeatureFlagsService): snapshot pull on init + TTL re-pull (lost-signal cover, same design as config-client) + FeatureToggleChanged subscription for immediate invalidation; local evaluation via the shared evaluator; fail-closed to the registry's defaultEnabled when the snapshot is unavailable.
4. FE path: gateway-api controller GET /api/v1/feature-flags returning the evaluated Record<FeatureKey, {enabled, variant?, value?}> for the authenticated tenant/user (uses FeatureFlagsService); web/shared-ui useFeatureFlags()/useFeatureFlag(key: FeatureKey) on TanStack Query keyed with createTenantQueryKey (web/CLAUDE.md invariant); shell/modules consume the hook. Seed FEATURE_KEYS with at least one real production gate wired end-to-end (product-owner-selected, e.g. experimental-module visibility in shell nav) so the chain is exercised, not resurrected as theater.

LOCAL APPLICATION — fix the broken admin-panel contract at the source (no shims): EvaluateFeatureToggleDto gains @IsString() key! plus the typed context fields and the controller drops @Query('key'), matching the body the FE wrapper already sends; add the missing @Post('feature-toggles/:id/toggle') route with an { enabled: boolean } DTO mapping to status ENABLED/DISABLED (FeatureTogglesPage.tsx:108 currently 404s); add GET feature-toggles/keys returning FEATURE_KEYS so the create form's free-text key input becomes a select; align web/modules/admin-panel/src/services/types/settings.ts FeatureToggle type with the entity/DTO in the same change.

If the product owner instead rules feature flags out of scope for the platform, the only honest alternative is full removal (page + routes + service + entity + table-drop migration) — a partial keep is re-shipping the theater. Default recommendation is completion, because the evaluator and admin UX already exist and the platform has flag-shaped needs (isExperimental, tenant rollout).
- **Files to change:**
  - `libs/event-contracts/src/feature-toggle-runtime.ts`
  - `libs/event-contracts/src/schemas/feature-toggle-runtime.schema.ts`
  - `libs/event-contracts/src/platform-event-registry.ts`
  - `libs/event-contracts/src/index.ts`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts`
  - `apps/admin-api-service/src/system-management/services/feature-toggle-snapshot.responder.ts`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`
  - `apps/admin-api-service/src/system-management/system-management.module.ts`
  - `apps/admin-api-service/src/system-management/__tests__/feature-toggle-contract.spec.ts`
  - `libs/backend-common/src/feature-flags/feature-flags.module.ts`
  - `libs/backend-common/src/feature-flags/feature-flags.service.ts`
  - `libs/backend-common/src/index.ts`
  - `apps/gateway-api/src/routes/feature-flags.controller.ts`
  - `web/shared-ui/src/hooks/useFeatureFlags.ts`
  - `web/shared-ui/src/hooks/index.ts`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `web/modules/admin-panel/src/services/types/settings.ts`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `tests/invariants/feature-toggle-consumption.spec.ts`
  - `e2e/tests/integration/nats-invariants.spec.ts`
- **Proof of fix:** (1) NEW tests/invariants/feature-toggle-consumption.spec.ts — asserts every FEATURE_KEYS entry has at least one real consumer callsite (FeatureFlagsService.isEnabled/getVariant or useFeatureFlag) outside the flag infrastructure itself, by scanning actual source (not a maintained pass-list): a key declared but consumed nowhere fails CI, which is the structural gate that prevents the config-table-nobody-reads class from regrowing. (2) NEW apps/admin-api-service/src/system-management/__tests__/feature-toggle-contract.spec.ts — integration test bootstrapping the real ValidationPipe (whitelist+forbidNonWhitelisted) and driving the exact request shapes the FE wrappers in web/modules/admin-panel/src/services/api/settings.ts emit: evaluate with body {key,...} returns 200 (currently 400), POST /:id/toggle exists and flips status (currently 404), create with an unregistered key returns 400; also asserts every create/update/delete/toggle writes a FeatureToggleChanged row into admin_outbox in the same transaction. (3) EXTEND e2e/tests/integration/nats-invariants.spec.ts — feature.toggles.snapshot grant present in services.yaml SSoT and generated nats.conf, cert-CN only (ADR-015). (4) NEW libs/backend-common/src/feature-flags/__tests__/feature-flags.service.spec.ts — snapshot pull on init, FeatureToggleChanged invalidation, TTL re-pull, fail-closed to registry defaultEnabled when snapshot unavailable. (5) Shared-evaluator unit specs move with the code into libs/event-contracts/src/__tests__ (bucket determinism, variant weights, schedule windows, tenant allow/deny) proving admin-api and consumers share one semantics. (6) E2E proof of the full chain in e2e/tests/: toggle a flag via the admin-api route and observe the gateway GET /api/v1/feature-flags response change for a tenant principal.
- **Effort:** L

### APA-263 [MEDIUM] evaluateFeature FE contract mismatched with backend (key in query vs body) - would 400 if ever used

- **Status:** PENDING
- **Symptom:** FE posts body {key, context} (settings.ts:97-101); backend expects key as @Query('key') and the body to be EvaluateFeatureToggleDto (global-settings.controller.ts:477-483, DTO at 134-158) which whitelists neither `key` nor `context` - forbidNonWhitelisted rejects it. Same for getFeatureToggleByKey: GET feature-toggles/key/:key has no backend route (allowlisted at contract-validation.spec.ts:628-632). Both are dead endpoints in the FE API layer.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:88`
  - `web/modules/admin-panel/src/services/api/settings.ts:97-101`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:477-483`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:628-632`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-264 [LOW] No pagination UI despite server-side pagination (default limit 50) - toggles beyond 50 are invisible

- **Status:** PENDING
- **Symptom:** queryFeatureToggles paginates with default limit 50 (global-settings.service.ts:192-196) and returns total, but the page never passes page/limit and renders no pager (FeatureTogglesPage.tsx:67-72), silently truncating the list.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts:192-196`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:67-72`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## MaintenancePage — `/admin/system/maintenance` — verdict: **BROKEN**

**Chain:** Backend chain is real: GlobalSettingsController system/settings/maintenance routes (global-settings.controller.ts:495-580) -> GlobalSettingsService real TypeORM CRUD on admin.maintenance_modes (global-settings.service.ts:376-584), table created in Baseline migration (1800000000000-Baseline.ts:38-41), plus a cron that auto-starts scheduled windows (global-settings.service.ts:819-833). But the page cannot list (envelope shape mismatch always yields []), cannot create (payload field rejected by forbidNonWhitelisted), Edit silently POSTs a duplicate instead of PUT, and - decisively - no gateway/middleware/frontend consumer of maintenance state exists, so a maintenance window blocks nothing.

**Endpoints exercised:** `GET /api/v1/system/settings/maintenance`; `POST /api/v1/system/settings/maintenance`; `PUT /api/v1/system/settings/maintenance/:id (defined in FE api, never invoked by page)`; `POST /api/v1/system/settings/maintenance/:id/start`; `POST /api/v1/system/settings/maintenance/:id/end`; `POST /api/v1/system/settings/maintenance/:id/cancel`; `POST /api/v1/system/settings/maintenance/:id/extend`; `GET /api/v1/system/settings/maintenance/check (no consumer anywhere)`

**DB tables:** `admin.maintenance_modes`

### APA-265 [HIGH] Maintenance list is always empty: FE expects a bare array but receives {items,total}

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** queryMaintenanceModes returns {items,total} (global-settings.service.ts:551, 582-583). ResponseInterceptor only lifts {data,total} shapes into meta (shared/response.interceptor.ts:47-65), so the envelope is {success,data:{items,total},meta:{timestamp}} with no meta.page; http-client returns envelope.data = {items,total} (services/http-client.ts:341-349). The page then does `Array.isArray(response) ? response : []` (MaintenancePage.tsx:92) - always []. Existing windows in admin.maintenance_modes are never displayed, and start/end/cancel/extend buttons only render on list rows, so every management action is unreachable after a reload.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts:582-583`
  - `apps/admin-api-service/src/shared/response.interceptor.ts:47-65`
  - `web/modules/admin-panel/src/services/http-client.ts:341-349`
  - `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:92`
- **Verification:** Prior adversarial verdict (real, HIGH) stands; re-reading the current code confirms every link. queryMaintenanceModes returns {items,total} (global-settings.service.ts:551,582-583); the controller passes it through (global-settings.controller.ts:504-525); ResponseInterceptor lifts only payloads with a 'data' key (response.interceptor.ts:47-65) so the envelope is {success,data:{items,total},meta:{timestamp}}; apiFetch sees no meta.page and returns envelope.data (http-client.ts:341-349); MaintenancePage.tsx:92 does Array.isArray(response) ? response : [] which is always []. This is a confirmed instance of a systemic class: at least 12 admin-api service methods return the GraphQL-idiom {items,total} REST payload the envelope cannot lift (global-settings.service.ts:199,583,716,782; error-tracking.service.ts:377,406,451; job-queue.service.ts:543,564; impersonation.service.ts:973; feature-flag-debug.service.ts:165; debug-tools.service.ts:288; custom-plan.service.ts:91-95) while the FE api layer declares PaginatedResult<T> for each. The interceptor contract exists only as duck-typing with no shared type, so nothing binds producer shape to the lift at build or test time.
- **Root cause:** The break is at the BE service-to-envelope link, caused by two co-existing pagination vocabularies with no reified contract between them. The platform pagination SSoT (libs/backend-common/src/pagination/pagination.dto.ts) canonicalizes {items,total,...} for GraphQL (IStandardPaginatedResult); the admin REST surface has a different implicit contract — ResponseInterceptor duck-lifts {data,total,page,limit,totalPages} into meta, and the FE http-client reassembles PaginatedResult when meta.page exists. That REST contract lives only as an inline structural check in response.interceptor.ts:47-52, imported by nobody, so system-management/impersonation/billing services drifted to the GraphQL items-idiom and the interceptor silently wrapped instead of lifting — 200 OK, no compile error, no failing test. The FE then compounded the drift: services/api/settings.ts correctly declares PaginatedResult<MaintenanceWindow>, but MaintenancePage.tsx ignores its own declared type with a banned defensive shim (Array.isArray ? : [], lines 92/255) and forbidden 'as unknown as' casts (lines 93/136), plus a page-local duplicate MaintenanceWindow interface that hid the fact that the shared FE type (services/types/settings.ts:120-138) is itself stale against the entity enums (nonexistent 'rolling' type, missing rolling_update/database_migration/security_patch, missing 'region' scope, missing estimatedDurationMinutes/updatedAt). Because start/end/cancel/extend buttons render only on list rows, the silent shape mismatch makes the entire maintenance-management surface unreachable.
- **Fix design:** SYSTEMIC CLASS: envelope/shape mismatch ({items,total} REST returns the envelope cannot lift) — fix at pattern level plus local application.

PATTERN (tier 1+2: reify the wire contract; tier 3: gate it):
1. New libs/backend-common/src/pagination/rest-page.ts (decorator-free): export interface RestPage<T> { data: T[]; total: number; page: number; limit: number; totalPages: number }, factory toRestPage<T>(items: T[], total: number, page: number, limit: number): RestPage<T> (computes totalPages), and guard isRestPage(value: unknown): value is RestPage<unknown> requiring data-is-array plus all four numeric fields. Export from libs/backend-common/src/pagination/index.ts. This is the single server-side twin of the FE PaginatedResult<T> (web/modules/admin-panel/src/services/types/common.ts).
2. ResponseInterceptor: replace the inline "'data' in data && 'total' in data" duck check with isRestPage(data) imported from the shared module. Boundary and producers now share one definition; partial shapes can no longer half-lift (today {data,total} without page lifts with page:undefined and the FE "'page' in meta" check still passes — that hole closes).
3. Convert EVERY admin-api {items,total} producer to return RestPage<T> via toRestPage(), with explicit RestPage<X> return types on service methods so malformed construction is a compile error: global-settings.service (queryFeatureToggles, queryMaintenanceModes, queryVersions, provisioning-templates empty result), error-tracking.service (3 methods), job-queue.service (2), impersonation.service.querySessions, feature-flag-debug.service, debug-tools.service, custom-plan.service (delete its local items-shaped PaginatedResult). Annotate the corresponding controller list endpoints Promise<RestPage<...>>. No allowlist, no stragglers — the gate below forbids them.
4. New invariant gate tests/invariants/admin-rest-pagination-ssot.spec.ts: (a) static scan of apps/admin-api-service/src (excluding __tests__) fails on any '{ items:' paginated return shape or IStandardPaginatedResult usage — admin-api is REST-only, the GraphQL items-idiom has no consumer that can read it through the envelope; zero-entry baseline, no drift allowlist; (b) asserts response.interceptor.ts imports isRestPage from the pagination SSoT and contains no inline shape check. New behavior spec apps/admin-api-service/src/shared/__tests__/response.interceptor.spec.ts: toRestPage payload lifts to {success,data:[...],meta:{total,page,limit,totalPages,timestamp}}; non-page payload wraps whole with timestamp-only meta.

LOCAL APPLICATION (this finding's chain):
5. queryMaintenanceModes resolves page/limit defaults once and returns toRestPage(items,total,page,limit); controller declares Promise<RestPage<MaintenanceMode>>. The interceptor then emits meta.page, so apiFetch returns {data,total,page,limit,totalPages} — exactly the PaginatedResult<MaintenanceWindow> already declared in services/api/settings.ts:104-105. Zero FE http-client or api-fn changes.
6. Fix the FE type at the source: align services/types/settings.ts MaintenanceWindow to the entity enums/columns (scope adds 'region'; type becomes scheduled|emergency|rolling_update|database_migration|security_patch; add estimatedDurationMinutes, updatedAt, affectedTenants). createMaintenanceWindow's Omit<> param type inherits the correction.
7. MaintenancePage.tsx: delete the page-local duplicate MaintenanceWindow interface (lines 16-36), import the shared type; loadData becomes const result = await systemSettingsApi.getMaintenanceWindows(); setMaintenanceList(result.data); delete both Array.isArray shims (lines 92, 255) and both 'as unknown as' casts (lines 93, 136 — handleCreate uses the typed createMaintenanceWindow return directly). The compiler now enforces the contract end to end; the previously-unreachable start/end/cancel/extend/edit actions render from real rows.
Sibling FE pages consuming the other converted endpoints (errors, jobs, feature-toggles, sessions, debug) get the corrected BE emission from this class-wide fix; any page-local shims they carry are remediated under their own finding keys.
- **Files to change:**
  - `libs/backend-common/src/pagination/rest-page.ts`
  - `libs/backend-common/src/pagination/index.ts`
  - `apps/admin-api-service/src/shared/response.interceptor.ts`
  - `apps/admin-api-service/src/shared/__tests__/response.interceptor.spec.ts`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/services/feature-flag-debug.service.ts`
  - `apps/admin-api-service/src/impersonation/services/debug-tools.service.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.service.token-redaction.spec.ts`
  - `apps/admin-api-service/src/billing/services/custom-plan.service.ts`
  - `tests/invariants/admin-rest-pagination-ssot.spec.ts`
  - `web/modules/admin-panel/src/services/types/settings.ts`
  - `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx`
  - `web/modules/admin-panel/src/pages/system/__tests__/MaintenancePage.spec.tsx`
- **Proof of fix:** (1) NEW tests/invariants/admin-rest-pagination-ssot.spec.ts — zero-allowlist static gate: no '{ items:' paginated return shapes anywhere in apps/admin-api-service/src, and response.interceptor.ts must import isRestPage from @aquaculture/backend-common/pagination; this makes any regression of the whole class build-time detectable. (2) NEW apps/admin-api-service/src/shared/__tests__/response.interceptor.spec.ts — toRestPage(items,total,page,limit) payload produces envelope meta {total,page,limit,totalPages}; incomplete shapes wrap whole (proves the lift contract). (3) NEW web/modules/admin-panel/src/pages/system/__tests__/MaintenancePage.spec.tsx — mock systemSettingsApi.getMaintenanceWindows resolving a PaginatedResult with scheduled and in_progress windows; assert rows render with titles and that Start Now/Cancel/End Maintenance buttons are in the document (proves the dead management surface is reachable), and assert setMaintenanceList consumed result.data (no empty-list fallback path exists to assert — it is deleted). (4) EXISTING apps/admin-api-service/src/__tests__/contract-validation.spec.ts (admin-route-contract CI target) stays green — routes unchanged; impersonation.service.token-redaction.spec.ts updated to destructure {data} and stays green. (5) nx affected --target=test and --target=lint green; npm run type-check proves the FE page compiles against the shared MaintenanceWindow type with no casts.
- **Effort:** M

### APA-266 [HIGH] Schedule Maintenance always 400s: payload includes createdBy which CreateMaintenanceDto does not whitelist

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** handleCreate sends `createdBy: 'admin'` (MaintenancePage.tsx:120-132, field at 130). CreateMaintenanceDto (global-settings.controller.ts:160-212) has no createdBy property. With the global ValidationPipe's forbidNonWhitelisted:true (create-service-app.ts:458-461) every create request is rejected with 400 - the page's primary flow (scheduling a window) can never succeed.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:120-132`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:160-212`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-461`
- **Verification:** Prior verdict adopted (already adversarially verified). Re-grounded in current code: MaintenancePage.tsx:130 sends createdBy:'admin'; systemSettingsApi.createMaintenanceWindow (services/api/settings.ts:107-108) POSTs it verbatim; CreateMaintenanceDto (global-settings.controller.ts:160-212) whitelists everything else in the payload but not createdBy; the global ValidationPipe (create-service-app.ts:458-497, applied :787, no admin-api override) rejects with 400. HIGH not CRITICAL: the page's primary flow is dead, but no data corruption or security breach occurs. This is an instance of TWO systemic classes: (1) client-asserted actor identity — also CustomPlanBuilderPage.tsx:274/314, DiscountCodePage.tsx:43/95/610, SubscriptionManagementPage.tsx:77/95 ('TODO: get from auth context'), ErrorTrackingPage.tsx:132, support.ts/database.ts request types, and backend DeployVersionDto.deployedBy / RollbackVersionDto.rolledBackBy; billing.ts:70/254 already ships the banned strip-it-client-side shim for the same class; (2) FE-type drift — hand-written request types derived via Omit<> from response models instead of from the backend DTO, made undetectable by MaintenancePage's private duplicate MaintenanceWindow interface bridged with 'as unknown as' casts.
- **Root cause:** The FE→BE contract broke at the request-DTO boundary, and it broke because actor attribution was modeled on the wrong side of the trust boundary. The backend correctly refused to whitelist createdBy (client-asserted actor identity is spoofable audit data), but it also never derives the actor itself: createMaintenanceMode (controller :495-502) ignores req.user even though MaintenanceMode has createdBy/updatedBy columns (:126-130) and the service signature accepts createdBy? (:391) — so the server abdicated attribution. The FE filled that vacuum: the hand-written response model MaintenanceWindow (services/types/settings.ts:120-138) declares createdBy: string, and the create-payload type is Omit<> of that response model (services/api/settings.ts:107) which does NOT omit createdBy — so the FE type system REQUIRES sending it, and the page satisfies it with the 'admin' placeholder (comment: 'Would come from auth context'). The drift went uncaught because (a) MaintenancePage keeps a private duplicate MaintenanceWindow interface bridged with 'as unknown as' casts, disconnecting even the FE's own type layer, and (b) no build/test gate compares FE payload shapes against Nest DTO whitelists, so forbidNonWhitelisted turned silent type drift into a hard runtime 400.
- **Fix design:** PATTERN LEVEL (client-asserted actor identity — Tier 1, make it impossible): actor identity is ALWAYS server-derived from the RS256-verified JWT; no request DTO in admin-api may declare an actor field. (a) Add requireAuthUser(req): AuthenticatedUser to apps/admin-api-service/src/shared/authenticated-request.ts — throws UnauthorizedException if req.user is absent (unreachable behind the global PlatformAdminGuard APP_GUARD; the throw replaces the existing defensive `user?.email || user?.id || 'admin'` fallback chain with an explicit contract). (b) Tighten GlobalSettingsService.createMaintenanceMode's param from `createdBy?: string` to required `createdBy: string` so a controller that forgets to supply the actor fails compilation (same for updateMaintenanceMode → updatedBy). (c) Tier-3 gate: new source-scanning invariant spec that fails if any class-validator request DTO under apps/admin-api-service/src/**/controllers/ declares an actor-named property (createdBy|updatedBy|deployedBy|rolledBackBy|resolvedBy|performedBy), preventing recurrence platform-wide in admin-api.
LOCAL APPLICATION (backend): global-settings.controller.ts — createMaintenanceMode gains @Req() req; pass createdBy = requireAuthUser(req).email ?? requireAuthUser(req).id into the service (email is an optional JWT claim; id is compiler-required). updateMaintenanceMode likewise sets updatedBy (column exists, currently never written). Apply the same pattern to the sibling violations in this controller: delete deployedBy from DeployVersionDto (DTO becomes empty → drop the body param) and rolledBackBy from RollbackVersionDto (keeps reason), deriving both from requireAuthUser — grep confirms no FE caller sends them, so no consumer breaks. Do NOT add createdBy to CreateMaintenanceDto: whitelisting it would ship spoofable audit attribution.
LOCAL APPLICATION (frontend, fixing the type at the SOURCE): services/types/settings.ts — correct MaintenanceWindow to mirror the entity (scope gains 'region'; type becomes the real 5-value enum scheduled|emergency|rolling_update|database_migration|security_patch; add estimatedDurationMinutes, affectedTenants, updatedBy?, updatedAt) and add an explicit CreateMaintenanceWindowRequest that mirrors CreateMaintenanceDto exactly (no createdBy, no status/actual*/id/timestamps) plus UpdateMaintenanceWindowRequest = Partial<CreateMaintenanceWindowRequest>. services/api/settings.ts — createMaintenanceWindow/updateMaintenanceWindow take these request types instead of Omit<>-of-response-model, so the request contract is no longer derived from the response shape. MaintenancePage.tsx — delete the page-local duplicate MaintenanceWindow interface and import the shared type; delete `createdBy: 'admin'` from apiData and annotate `const apiData: CreateMaintenanceWindowRequest = {...}` so TS excess-property checking makes reintroducing createdBy a compile error; remove the now-unnecessary `as 'scheduled'|'emergency'|'rolling'` narrowing casts (the unified type accepts all five real values, incidentally fixing the latent bug where the form offers rolling_update/database_migration/security_patch but the payload type forbade them) and the `as unknown as MaintenanceWindow` cast on the create response.
- **Files to change:**
  - `apps/admin-api-service/src/shared/authenticated-request.ts`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts`
  - `web/modules/admin-panel/src/services/types/settings.ts`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx`
  - `apps/admin-api-service/src/system-management/__tests__/global-settings.maintenance-contract.spec.ts`
  - `tests/invariants/admin-api-actor-attribution.spec.ts`
- **Proof of fix:** New spec apps/admin-api-service/src/system-management/__tests__/global-settings.maintenance-contract.spec.ts: boot a Nest testing module with GlobalSettingsController, mocked GlobalSettingsService/repos (reuse the mock-repo helpers from the adjacent provisioning-config.spec.ts), the REAL platform pipe options ({whitelist:true, forbidNonWhitelisted:true, transform:true}) and a guard stub that attaches req.user={id,sub,email,...}; assert (1) POST /system/settings/maintenance with the exact FE-shaped payload (no createdBy) → 201 and the service receives createdBy === the JWT identity (never 'admin'), (2) the same payload WITH createdBy:'admin' → 400 (proves the whitelist stays authoritative and was not loosened), (3) PUT sets updatedBy from the JWT. Pattern gate: new tests/invariants/admin-api-actor-attribution.spec.ts scans admin-api controller sources and fails on any request-DTO actor-field declaration (would flag DeployVersionDto/RollbackVersionDto today, green after this fix). FE compile-time proof: npm run type-check — with createMaintenanceWindow typed against CreateMaintenanceWindowRequest and apiData annotated, re-adding createdBy to the payload is a tsc error. Then nx affected --target=test && nx affected --target=lint green.
- **Effort:** M

### APA-267 [CRITICAL] Maintenance mode blocks nothing - checkMaintenanceMode has zero consumers

- **Status:** PENDING
- **Symptom:** GET system/settings/maintenance/check (global-settings.controller.ts:527-540) and GlobalSettingsService.checkMaintenanceMode (global-settings.service.ts:469-519) are called by no gateway middleware, no service guard, and no frontend shell code - grep of gateway-api/src for 'maintenance' returns nothing, and the only web reference is the unused FE wrapper checkMaintenanceStatus (services/api/settings.ts:119-120). The cron auto-starts windows every minute (global-settings.service.ts:819-833) but an 'in_progress' global maintenance has no effect on any request path. Flags like allowReadOnlyAccess/bypassForSuperAdmins/whitelistedIPs are stored and never enforced.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:527-540`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts:469-519`
  - `web/modules/admin-panel/src/services/api/settings.ts:119-120`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-268 [HIGH] Edit modal submits via handleCreate - updates are silently turned into duplicate creations

- **Status:** PENDING
- **Symptom:** The modal footer button is `onClick={handleCreate}` for both create and edit modes (MaintenancePage.tsx:715-720); the label says 'Update' but the handler always POSTs a new window. systemSettingsApi.updateMaintenanceWindow (settings.ts:109-110) is never called anywhere. Even if the create 400 were fixed, editing would fork a duplicate row instead of updating.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:715-720`
  - `web/modules/admin-panel/src/services/api/settings.ts:109-110`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## PerformanceDashboardPage — `/admin/system/performance` — verdict: **PARTIAL**

**Chain:** FE (settings.ts:129-154) -> PerformanceController @Controller('system/performance') (performance.controller.ts:80) -> PerformanceMonitoringService. Real parts: database metrics are genuine pg_stat_activity/pg_stat_database queries (performance-monitoring.service.ts:333-395); container health is real HTTP probes to service /health/live endpoints through the circuit breaker (l.464-548); CPU/memory/disk come from os.cpus()/os.totalmem()/fs.statfsSync (l.436-457); snapshots are persisted per minute to admin.performance_snapshots (l.768-801, Baseline.ts:35-37). Fake/dead parts: all application metrics (response time, error rate, throughput, apdex, service breakdown) are read from admin.performance_metrics which has NO producer - not Prometheus, not observability-service - so they are permanently zero. Not fabricated random numbers, but structurally-empty telemetry rendered as a healthy system.

**Endpoints exercised:** `GET /api/v1/system/performance/dashboard`; `GET /api/v1/system/performance/infrastructure`; `GET /api/v1/system/performance/database`; `POST /api/v1/system/performance/metrics (ingestion endpoint, zero callers)`; `POST /api/v1/system/performance/metrics/request (ingestion endpoint, zero callers)`

**DB tables:** `admin.performance_metrics`, `admin.performance_snapshots`

### APA-269 [HIGH] Application metrics have no producer - response time/error rate/throughput/apdex are permanently zero and rendered as healthy

- **Status:** PENDING
- **Symptom:** getApplicationMetrics/getServiceBreakdown/trends all read admin.performance_metrics (performance-monitoring.service.ts:228-285, 587-618, 638-666). The only writers are POST /system/performance/metrics and /metrics/request (performance.controller.ts:260-278), which sit behind the global SUPER_ADMIN PlatformAdminGuard (app.module.ts:283-289) and have zero callers repo-wide (grep: recordRequestMetric referenced only by its own controller). No HTTP-metrics interceptor feeds it, and observability-service/Prometheus (ServiceMetricsModule, app.module.ts:215-218) is a separate scrape surface never consulted by this dashboard. Result: the dashboard permanently shows 0ms response time, 0% error rate, apdex 1, empty trends and 'No service data available' regardless of real system behavior - silent wrong data.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:228-285`
  - `apps/admin-api-service/src/system-management/controllers/performance.controller.ts:260-278`
  - `apps/admin-api-service/src/app.module.ts:283-289`
  - `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:638-666`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-270 [HIGH] 'Infrastructure Metrics' are the admin-api container's own OS stats presented as platform infrastructure

- **Status:** PENDING
- **Symptom:** cpuUsage/memoryUsage/diskUsage come from os.cpus(), os.totalmem()/freemem() and fs.statfsSync('/') inside the admin-api process (performance-monitoring.service.ts:436-457) - i.e. one container's cgroup view, not platform telemetry. The page titles this 'Infrastructure Metrics' and colors thresholds off it (PerformanceDashboardPage.tsx:503-592). Operators see admin-api's own container load and will read it as fleet health.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:436-457`
  - `web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx:503-592`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-271 [MEDIUM] Time-range selector is a silent no-op: FE sends start/end, backend reads startDate/endDate

- **Status:** PENDING
- **Symptom:** FE builds `?start=...&end=...` (settings.ts:129-130 spreads timeRange {start,end}; PerformanceDashboardPage.tsx:116-119). The controller reads @Query('startDate')/@Query('endDate') (performance.controller.ts:88-98), so both are always undefined and the service falls back to its default last-hour window (performance-monitoring.service.ts:577-578). Selecting 'Son 5 Dakika' vs 'Son 24 Saat' changes nothing; no error is surfaced.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:129-130`
  - `web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx:116-119`
  - `apps/admin-api-service/src/system-management/controllers/performance.controller.ts:88-98`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-272 [MEDIUM] Health probes hardcode droplet docker hostnames; charts are an explicit placeholder

- **Status:** PENDING
- **Symptom:** Service probes target fixed hostnames aqua-auth/aqua-gateway/... (performance-monitoring.service.ts:465-476) - outside the droplet compose network containerCount/healthyContainers read 0/0. The 'Performance Trends' card is a hardcoded 'Interactive Charts Coming Soon' placeholder (PerformanceDashboardPage.tsx:594-633); trends data (always empty anyway) is only shown as a datapoint count.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:465-476`
  - `web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx:594-633`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-273 [LOW] When no snapshot exists the FE fabricates healthScore 100 / apdex 1 defaults

- **Status:** PENDING
- **Symptom:** If currentSnapshot is null (fresh deploy), the FE mapping substitutes healthScore 100, errorRate 0, apdex 1 (PerformanceDashboardPage.tsx:130-141) - an invented perfect score instead of an honest empty state. The top-level `healthScore` the backend actually computes (performance-monitoring.service.ts:624-635) is ignored by the FE mapping.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/PerformanceDashboardPage.tsx:130-141`
  - `apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts:624-635`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## ErrorTrackingPage — `/admin/system/errors` — verdict: **BROKEN**

**Chain:** Backend is a genuine Sentry-style implementation: ErrorTrackingController system/errors routes (error-tracking.controller.ts:197-407) -> ErrorTrackingService with real fingerprinting, grouping, regression detection and dashboard aggregation against admin.error_groups / admin.error_occurrences / admin.error_alert_rules (error-tracking.service.ts:85-175, 650-751; tables in Baseline.ts:65-69). But the chain is dead at both ends: ingestion (POST /system/errors/report) has zero callers and is unreachable to services because the global guard demands a SUPER_ADMIN user JWT, so the tables are permanently empty; and on the FE, the paginated-envelope mismatch sets errorGroups to undefined causing a render crash the moment the API succeeds. Status actions additionally hit a nonexistent route (acknowledge) or a non-whitelisted body field (resolve). Alert-rule notification handlers are log-only stubs.

**Endpoints exercised:** `GET /api/v1/system/errors/dashboard`; `GET /api/v1/system/errors/groups`; `GET /api/v1/system/errors/groups/:id/occurrences`; `PUT /api/v1/system/errors/groups/:id/status (FE-only, backend is PUT groups/:id)`; `POST /api/v1/system/errors/groups/:id/resolve`; `POST /api/v1/system/errors/groups/:id/ignore`; `POST /api/v1/system/errors/report (ingestion, zero callers)`

**DB tables:** `admin.error_groups`, `admin.error_occurrences`, `admin.error_alert_rules`

### APA-274 [CRITICAL] No error ingestion exists: POST /system/errors/report has zero callers and is blocked for services by the SUPER_ADMIN guard

- **Status:** PENDING
- **Symptom:** reportError (error-tracking.controller.ts:235-237) is the only write path into admin.error_occurrences/error_groups. Repo-wide grep finds no service, gateway hook, exception filter, or frontend that calls /system/errors/report (only a docs mention in docs/audits/tenant-platform/2026-03-14/discovery/d20-observability.md:346). The global APP_GUARD PlatformAdminGuard requires a SUPER_ADMIN user token on every admin-api route (app.module.ts:283-289, platform-admin.guard.ts:151-177), so backend services could not report errors even if they tried. The tracking tables are structurally empty; the page will forever say 'All systems are running smoothly' (ErrorTrackingPage.tsx:346-351) while real errors go untracked.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:235-237`
  - `apps/admin-api-service/src/app.module.ts:283-289`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:151-177`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx:346-351`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-275 [CRITICAL] Page crashes on any successful load once data exists: reads .data from an {items,total} response

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** queryErrorGroups returns {items,total} (error-tracking.service.ts:376-377); after the ResponseInterceptor/http-client unwrap (response.interceptor.ts:47-65, http-client.ts:341-349) the FE receives {items,total}, but the page does setErrorGroups(groupsData.data) (ErrorTrackingPage.tsx:82) - undefined. The next render executes `errorGroups.map(...)` at ErrorTrackingPage.tsx:170 and throws TypeError, unmounting the page. Same bug in the detail modal: occurrencesData.data (l.118-119) is undefined -> errorOccurrences.length crashes (l.505,517). The FE PaginatedResult type ({data,total,page,...}, services/types/common.ts:5-11) never matches what the backend sends.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx:82`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx:170`
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:376-377`
  - `web/modules/admin-panel/src/services/types/common.ts:5-11`
- **Verification:** Confirmed end-to-end by reading every link: queryErrorGroups/getOccurrencesForGroup return {items,total} (apps/admin-api-service/src/system-management/services/error-tracking.service.ts:376-377, 399-406); the ResponseInterceptor pagination lift is duck-typed on 'data' in payload && 'total' in payload (src/shared/response.interceptor.ts:47-65), so {items,total} falls through to the generic wrap with meta={timestamp} only; the FE http-client (web/modules/admin-panel/src/services/http-client.ts:341-349) reconstructs a PaginatedResult only when 'page' in meta, otherwise returns envelope.data — so the page receives raw {items,total}. ErrorTrackingPage.tsx:82 does setErrorGroups(groupsData.data) → undefined; line 170 (errorGroups.map at the top of render, executed unconditionally) throws TypeError and unmounts the page to the shell-level ErrorBoundary (no boundary inside admin-panel). Masking was ruled out: the parallel getErrorDashboard() hits a real @Get('dashboard') route, so Promise.all resolves and the crash path executes. The finding is actually understated: {items:[],total:0} also lacks .data, so the page crashes on EVERY successful load, including an empty error table — the feature is 100% dead, not merely dead-once-data-exists. The detail modal (lines 118-119 → 505/517) is the same defect on the occurrences endpoint (route @Get('groups/:groupId/occurrences') is real). CRITICAL stands: total, unconditional loss of a SUPER_ADMIN observability page. Systemic class confirmed: {items,total} drift exists in 6 services (20 occurrences) while ~26 sites use the canonical {data,total,page,limit} shape the interceptor lifts correctly.
- **Root cause:** The BE service layer drifted from the platform pagination shape ({data,total,page,limit}) to an ad-hoc {items,total} in error-tracking (and 5 sibling services). The break propagated because the ResponseInterceptor's pagination lift is structurally duck-typed ('data' && 'total' keys) and silently degrades to generic wrapping instead of failing loudly, so the wire carried data:{items,total} with no meta.page; the FE http-client therefore unwrapped to {items,total} while the hand-written FE PaginatedResult&lt;T&gt; type and the page code (.data) encoded the canonical contract. No artifact in the chain — nominal types, interceptor, or a contract test — binds service return shape to the FE type, so the drift compiled clean on both sides and shipped undetected. The FE page itself is written correctly against the declared contract; the backend + interceptor are the broken links.
- **Fix design:** Pattern-level fix (tier 1 make-wrong-shape-impossible + tier 3 detectable), applied at the source; the FE page and PaginatedResult type need NO changes — they already encode the contract. (1) Create the canonical pagination contract in apps/admin-api-service/src/shared/pagination.ts: an exported PaginatedResponse&lt;T&gt; class {data:T[]; total:number; page:number; limit:number; totalPages:number} plus a paginate&lt;T&gt;(items, total, page, limit) factory that computes totalPages — the ONLY way to produce a paginated body. (2) Convert error-tracking.service.ts queryErrorGroups, getOccurrencesForGroup, and queryOccurrences to return PaginatedResponse&lt;T&gt; via paginate(), passing through the already-computed page/limit; declare Promise&lt;PaginatedResponse&lt;...&gt;&gt; return types on the corresponding controller methods (explicit return types are already mandated repo-wide). (3) Apply the same conversion to the remaining drifted services in the class — job-queue.service.ts, global-settings.service.ts, feature-flag-debug.service.ts, impersonation.service.ts, debug-tools.service.ts — auditing each endpoint's FE consumer in the same change (some may have compensated by reading .items; fix those consumer callsites to PaginatedResult in the same commit, per contract-at-the-source discipline). Mechanically swap the ~26 already-canonical `return {data,total,page,limit}` literals to paginate() so totalPages is always present. (4) Nominalize the interceptor: ResponseInterceptor lifts to meta on `payload instanceof PaginatedResponse` and DELETE the structural 'data'/'total' duck-type branch — after step 3's full sweep, an ad-hoc object literal can never accidentally trigger or accidentally miss the lift; a paginated body that skips paginate() becomes structurally impossible to serialize in the lifted form. (5) Detection gate: a repo invariant spec that fails on any admin-api-service service method returning an object literal with items+total (or data+total outside pagination.ts), plus a supertest contract spec asserting the wire envelope for the two error-tracking endpoints carries meta.page/limit/totalPages and array data. No FE defensive coding, no compat shim in http-client — the wire moves to the shape the FE contract always declared.
- **Files to change:**
  - `apps/admin-api-service/src/shared/pagination.ts`
  - `apps/admin-api-service/src/shared/response.interceptor.ts`
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts`
  - `apps/admin-api-service/src/impersonation/services/feature-flag-debug.service.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/services/debug-tools.service.ts`
  - `apps/admin-api-service/src/system-management/__tests__/pagination-envelope.contract.spec.ts`
  - `tests/invariants/admin-api-pagination-shape.spec.ts`
- **Proof of fix:** New supertest contract spec apps/admin-api-service/src/system-management/__tests__/pagination-envelope.contract.spec.ts: boot the system-management module with a seeded repo double and assert GET /system/errors/groups and GET /system/errors/groups/:id/occurrences respond {success:true, data:[...], meta:{total,page,limit,totalPages,timestamp}} — i.e. meta.page is defined and body.data is an array (this fails red on current code because data is {items,total} and meta.page is absent, and goes green with the fix). New repo invariant tests/invariants/admin-api-pagination-shape.spec.ts: statically scans apps/admin-api-service/src/**/services/*.ts and fails on any returned object literal with items+total or data+total pagination shape outside src/shared/pagination.ts, locking the class shut (catches the 5 sibling drifted services and any future drift). FE regression: web/modules/admin-panel/src/pages/system/__tests__/ErrorTrackingPage.spec.tsx renders the page with apiFetch mocked to the exact post-unwrap wire shape ({data:[group],total:1,page:1,limit:20,totalPages:1}) and asserts the group list renders without throwing, plus opens the detail modal against the occurrences shape.
- **Effort:** M

### APA-276 [HIGH] Acknowledge action 404s (route mismatch) and Resolve action 400s (non-whitelisted body field); both errors swallowed to console

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** FE updateErrorStatus PUTs `/system/errors/groups/${id}/status` (settings.ts:176-177) but the backend route is PUT groups/:id with no /status suffix (error-tracking.controller.ts:276-277) -> 404. FE resolveError posts {resolvedBy, notes} (settings.ts:178-179, invoked with 'admin' at ErrorTrackingPage.tsx:132) but ResolveErrorGroupDto whitelists only userId/notes (error-tracking.controller.ts:95-105) -> forbidNonWhitelisted 400. Both handlers only console.error (ErrorTrackingPage.tsx:136-138, 161-163) - no user-visible failure, and the optimistic stats decrement at l.135/148 leaves wrong counts on screen.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:176-179`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:276-277`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:95-105`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx:128-163`
- **Verification:** CONFIRMED by independent re-read of all wiring. (1) Acknowledge 404: ErrorTrackingPage.tsx:154-164 calls updateErrorStatus(id,'acknowledged') which PUTs /system/errors/groups/${id}/status (settings.ts:176-177), but error-tracking.controller.ts registers only PUT groups/:id (l.276), POST groups/:id/resolve (l.296), POST groups/:id/acknowledge (l.309), POST groups/:id/ignore (l.314); a repo-wide grep confirms no :id/status route exists under system/errors anywhere in admin-api-service, and Nest :id params match a single segment — the request 404s. Controller is live via SystemManagementModule (app.module.ts:231). (2) Resolve 400: resolveError(id,'admin') sends {"resolvedBy":"admin"} (settings.ts:178-179; undefined notes stripped by JSON.stringify) but ResolveErrorGroupDto whitelists only userId/notes (controller l.95-105); admin-api main.ts uses bootstrapService with no validationPipeOverrides, so createServiceApp's default whitelist:true+forbidNonWhitelisted:true (create-service-app.ts:458-460) rejects it with 400. (3) Swallowed: http-client.ts:309-311 throws 4xx without retry; both page catch blocks only console.error (l.136-138, 161-163) and never use the page's existing setError toast (l.582-591). REFUTED sub-claim: the "optimistic stats decrement leaves wrong counts" is wrong — the setStats decrement at l.135 is AFTER the await that throws, so it never runs on failure; counts are not corrupted (l.148 is in handleIgnore, whose route exists and works). Severity stays HIGH: two of three triage actions on a SUPER_ADMIN ops page fail on every invocation with zero user feedback — complete silent feature failure, but not a security/data-integrity issue so not CRITICAL.
- **Root cause:** The FE→BE link broke at the hand-written API client: web/modules/admin-panel/src/services/api/settings.ts was authored against an imagined REST shape (a PUT .../status sub-route and a resolvedBy field) instead of the actual Nest controller contract (PUT groups/:id with UpdateErrorGroupDto; POST groups/:id/resolve with {userId, notes}; a dedicated POST groups/:id/acknowledge the FE never uses). Nothing binds the FE's endpoint strings and body literals to the controller's routes/DTOs at build or test time, so the drift was invisible until runtime — an instance of the systemic FE-route/DTO-drift class already seen in this audit. Two aggravating local defects: the page hardcodes 'admin' as the resolving user instead of the authenticated identity, and both action handlers swallow the thrown ApiError with console.error instead of the page's existing error surface, converting a hard contract break into a silent no-op.
- **Fix design:** SYSTEMIC CLASS: FE-route/DTO drift in a hand-written client — fix at the pattern level plus the local application. LOCAL (align to the controller SSoT, no BE change needed): in settings.ts (a) add acknowledgeError(id) => POST `/system/errors/groups/${id}/acknowledge` (exact parallel of the existing ignoreError, hitting the dedicated backend route); (b) change updateErrorStatus to PUT `/system/errors/groups/${id}` with a body typed as the UpdateErrorGroupDto shape {status?, assignedTo?, notes?, linkedTicketUrl?}; (c) change resolveError(id, userId?, notes?) to send {userId, notes} matching ResolveErrorGroupDto. In ErrorTrackingPage.tsx: handleAcknowledge calls acknowledgeError(id); handleResolve passes the authenticated admin's user id from the shared-ui session (not the hardcoded 'admin'); both catch blocks route failures through the page's existing setError toast (mechanism already rendered at l.582-591) instead of console.error-only; after a successful mutation refresh counts from the server via loadData() rather than hand-adjusted setStats decrements (server state is the SSoT — makes correct counts automatic). PATTERN (tier 1, make drift impossible): the admin-api already emits a Swagger document (main.ts swagger config); add an Nx target that dumps openapi.json and wire an OpenAPI-codegen step into `npm run codegen` producing request/response types consumed by services/api/*.ts, so an invented field like resolvedBy becomes a tsc error — the hand-written services/types/* for these endpoints are replaced by generated types. PATTERN (tier 3, make remaining drift detectable now): add a route-contract spec that boots AppModule via Test.createTestingModule, enumerates the registered (method, path) pairs from the HTTP adapter's router, and asserts every endpoint in a small importable FE route manifest exists — seeded with the error-tracking set; this spec fails today on the phantom /status route and gates future drift in CI. No defensive code, no compat shim, no BE route aliasing: the controller contract is the source and the FE is regenerated/retyped from it.
- **Files to change:**
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx`
  - `web/modules/admin-panel/src/services/types/settings.ts`
  - `apps/admin-api-service/src/__tests__/contract/admin-panel-routes.contract.spec.ts`
  - `package.json`
- **Proof of fix:** New spec apps/admin-api-service/src/__tests__/contract/admin-panel-routes.contract.spec.ts: boots AppModule, asserts PUT /api/v1/system/errors/groups/:id, POST .../:id/resolve, POST .../:id/acknowledge, POST .../:id/ignore are registered AND that every route in the FE manifest resolves (red today on the phantom /status path, green after the fix). New FE spec web/modules/admin-panel/src/pages/system/__tests__/ErrorTrackingPage.spec.tsx: (a) mock resolveError/acknowledgeError to reject and assert the error toast renders (no silent console-only failure) and stats are unchanged; (b) on success assert acknowledgeError hits the /acknowledge endpoint and resolveError's body is exactly {userId: <session user id>, notes?} with no resolvedBy key. npm run type-check must fail if a request-body field drifts once bodies are typed from the generated/shared contract types. All run under nx affected --target=test.
- **Effort:** M

### APA-277 [MEDIUM] Dashboard stat drift: FE reads unresolvedErrors/criticalErrors which the backend never returns

- **Status:** PENDING
- **Symptom:** getErrorDashboard returns totalErrors, newErrors, unresolvedGroups, errorsByService, errorsBySeverity, recentErrors, topErrorGroups, errorTrend (error-tracking.service.ts:735-751). The FE api type and page read dashboardData.unresolvedErrors and dashboardData.criticalErrors (settings.ts:157-165; ErrorTrackingPage.tsx:83-90) - both undefined, so the 'Unresolved' and 'Critical' stat cards render blank. Also FE getErrorGroups sends startDate/endDate (ErrorTrackingPage.tsx:76-77) which queryErrorGroups (error-tracking.controller.ts:244-269) never accepts - the date filter is a silent no-op.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:735-751`
  - `web/modules/admin-panel/src/services/api/settings.ts:157-165`
  - `web/modules/admin-panel/src/pages/system/ErrorTrackingPage.tsx:83-90`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:244-269`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-278 [MEDIUM] Alert-rule notification actions are log-only stubs (email/slack/webhook never sent)

- **Status:** PENDING
- **Symptom:** sendEmailNotification/sendSlackNotification/sendWebhookNotification just this.logger.log with 'In production, this would integrate...' comments (error-tracking.service.ts:631-644). notification-service is never called. Any error alert rule configured via the API fires into a log line only.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts:631-644`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## JobQueuePage — `/admin/system/jobs` — verdict: **BROKEN**

**Chain:** The 'queue' is a homegrown DB-table queue owned by admin-api itself: JobQueueController system/jobs (job-queue.controller.ts:292-463) -> JobQueueService with a @Cron(EVERY_10_SECONDS) in-process worker polling admin.background_jobs / admin.job_queues / admin.job_execution_logs (job-queue.service.ts:237-296; tables in Baseline.ts:42-51). It is NOT BullMQ/Redis and NOT connected to any real platform work: registerHandler has zero callers (grep: only alert-engine's unrelated notification dispatcher matches), so executeJob always logs 'No handler registered' and returns (job-queue.service.ts:299-303) - any job would sit PENDING forever - and no service outside this module ever enqueues (grep 'background_jobs|createJob' hits only system-management + migrations). On top of that, FE contract drift empties every tab: the jobs list always shows 'No jobs found' and the queues tab is always blank, making retry/cancel/pause/resume unreachable even though those backend routes exist and do real DB updates.

**Endpoints exercised:** `GET /api/v1/system/jobs/dashboard`; `GET /api/v1/system/jobs`; `POST /api/v1/system/jobs/:id/retry`; `POST /api/v1/system/jobs/:id/cancel`; `POST /api/v1/system/jobs/queues/:name/pause`; `POST /api/v1/system/jobs/queues/:name/resume`; `GET /api/v1/system/jobs/scheduled (FE-only, shadowed by GET :id)`; `GET /api/v1/system/jobs/failed (FE-only, shadowed by GET :id)`; `POST /api/v1/system/jobs/cleanup (FE-only, no backend route)`

**DB tables:** `admin.background_jobs`, `admin.job_queues`, `admin.job_execution_logs`

### APA-279 [HIGH] Jobs list is always empty: getJobs reads response.data from an {items,total} payload and the guard silently swallows it

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** queryJobs returns {items,total} (job-queue.service.ts:542-543); after envelope unwrap the FE receives {items,total} but reads response?.data (JobQueuePage.tsx:88-90) and the Array.isArray guard silently substitutes []. The initial dashboard load briefly sets jobs=recentJobs (l.69), but the activeTab==='jobs' effect (l.101-105) immediately overwrites with [] - so the table renders 'No jobs found' permanently (l.414-419), and the per-row Retry/Cancel buttons (l.490-505) are unreachable despite POST :id/retry and :id/cancel being real, working DB updates (job-queue.service.ts:452-485).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:81-95`
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:101-105`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:542-543`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:452-485`
- **Verification:** Confirmed end-to-end. GET /system/jobs (JobQueueController.queryJobs) returns the service's raw {items,total} (job-queue.service.ts:543). ResponseInterceptor's pagination branch duck-types on 'data' in payload && 'total' in payload (response.interceptor.ts:47-52), so {items,total} does NOT match and ships nested as {success,data:{items,total},meta:{timestamp}}. FE apiFetch unwrap (http-client.ts:343-349) finds no meta.page, returns envelope.data = {items,total}; JobQueuePage reads response?.data (undefined) and Array.isArray silently substitutes [] (JobQueuePage.tsx:88-90). Route system/jobs is wired (Module.tsx:166). One correction: 'renders No jobs found permanently' is overstated — loadDashboard (9-query Promise.all) and loadJobs race on mount, and the dashboard usually resolves last, seeding the table with its 10 recentJobs (l.70). But any search/filter/tab interaction re-fires loadJobs and deterministically empties the table with no recovery; filtering, search, pagination, and per-row Retry/Cancel beyond the racy 10-row seed never work. Complete break of the page's query/manage path but no data loss or security exposure, and partial visibility survives via the dashboard seed — HIGH, not CRITICAL. Systemic class confirmed: error-tracking.service.ts, global-settings.service.ts (feature toggles, maintenance), and impersonation services all return {items,total} to FE callers typed PaginatedResult — the same silent-empty bug exists on those pages.
- **Root cause:** The BE→FE wire contract link broke: admin-api-service has two coexisting pagination shapes with no shared type binding them. The canonical page-based shape {data,total,page,limit,totalPages} (users/tenant/modules/audit/ip-access/billing) is what ResponseInterceptor lifts into meta and what FE apiFetch reconstitutes into PaginatedResult when meta.page exists. The system-management and impersonation modules instead adopted the offset-style {items,total} shape (mirroring @aquaculture/backend-common/pagination's createPaginatedResult) and their controllers return it raw. Nothing enforces agreement across the three layers: the interceptor duck-types on key names, the FE types are hand-written assertions with no codegen or runtime validation, and JobQueuePage's defensive Array.isArray(response?.data) guard (a CLAUDE.md-banned pattern) converts the type lie into a silent empty list instead of a visible failure. A secondary trap: even renaming items→data would not fix it, because queryJobs omits page/limit/totalPages, meta.page would serialize away as undefined, and the FE 'page' in meta check would still fail — the drift is in the whole paginated-return contract, not one key name.
- **Fix design:** Pattern-level fix (Tier 1 + Tier 3) plus local application. (1) Create the single wire-contract SSoT in apps/admin-api-service/src/shared/pagination.ts: export interface PagedResult<T> { data: T[]; total: number; page: number; limit: number; totalPages: number } and a constructor toPagedResult<T>(items: T[], total: number, page: number, limit: number): PagedResult<T> that computes totalPages — co-located with the existing PaginationQueryDto and matched to ResponseInterceptor's lift and the FE's meta.page reconstruction. (2) Local application: job-queue.service.ts queryJobs and getJobLogs return PagedResult (they already compute page/limit; wrap via toPagedResult), and job-queue.controller.ts declares explicit Promise<PagedResult<BackgroundJob>> / Promise<PagedResult<JobExecutionLog>> return types on queryJobs/getJobLogs — the compiler then makes returning {items,total} impossible (Tier 1, and satisfies the 'explicit return type on every public function' rule). (3) Class sweep in the same module: apply the identical PagedResult migration to error-tracking.service.ts (queryErrorGroups/occurrences) and global-settings.service.ts (feature toggles, maintenance windows, versions) plus their controllers' return types; impersonation services are the same class — if they cannot land in the same PR, open tracked findings per the traceability rule rather than leaving them silent. (4) FE: JobQueuePage.tsx loadJobs consumes the typed contract directly — const result = await systemSettingsApi.getJobs(...); setJobs(result.data) — deleting the response?.data + Array.isArray silent-substitution guard so any future shape drift surfaces as the error state instead of an empty table; also delete the setJobs(dashboardData.recentJobs) seeding in loadDashboard (l.70) so the jobs table has exactly one data source (loadJobs) and the mount race disappears. No FE type changes needed: PaginatedResult already declares the canonical shape — the backend moves to the contract, the FE stops defending against its absence. (5) Detection gate (Tier 3): a supertest contract spec boots the system-management module with ResponseInterceptor and mocked repos and asserts the wire body for GET /system/jobs and GET /system/jobs/:id/logs is {success:true, data:Array, meta:{total,page,limit,totalPages}} — pinning the interceptor duck-type, the service shape, and the FE unwrap precondition (meta.page present) in one test.
- **Files to change:**
  - `apps/admin-api-service/src/shared/pagination.ts`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts`
  - `apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts`
  - `apps/admin-api-service/src/system-management/services/error-tracking.service.ts`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts`
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx`
  - `apps/admin-api-service/src/system-management/__tests__/job-queue.pagination-contract.spec.ts`
  - `web/modules/admin-panel/src/pages/system/__tests__/JobQueuePage.spec.tsx`
- **Proof of fix:** New spec apps/admin-api-service/src/system-management/__tests__/job-queue.pagination-contract.spec.ts: supertest against the system-management module with ResponseInterceptor applied and mocked jobRepo, seed 2 jobs (one failed), assert GET /system/jobs responds {success:true, data:[...2 jobs], meta:{total:2, page:1, limit:20, totalPages:1}} and same shape for GET /system/jobs/:id/logs — this fails against current code (data would be {items,total} and meta.page absent) and passes after the fix; extend it to the error-tracking and global-settings list endpoints to gate the whole class. New FE spec web/modules/admin-panel/src/pages/system/__tests__/JobQueuePage.spec.tsx: mock systemSettingsApi.getJobs to resolve a PaginatedResult with one failed job, render JobQueuePage, assert the row and its Retry button appear and that changing the status filter re-queries and still renders rows. Compile-time gate: the explicit Promise<PagedResult<T>> controller return types make {items,total} a tsc error (npm run type-check). Run nx affected --target=test and --target=lint green per repo law.
- **Effort:** M

### APA-280 [CRITICAL] The queue executes nothing: no job handler is ever registered and no platform component enqueues into it

- **Status:** PENDING
- **Symptom:** The cron worker resolves handlers from this.jobHandlers (job-queue.service.ts:298-303); registerHandler (l.224-227) has zero callers anywhere in the repo, so every picked-up job hits 'No handler registered for job' and is returned untouched - jobs stay PENDING forever with no error surfaced. No other service writes to admin.background_jobs or calls POST /system/jobs (grep matches only system-management files + migrations), and real background work (notification dispatch, retention crons, etc.) runs elsewhere. The page therefore monitors a queue that can neither receive real work nor execute anything.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:298-303`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:224-227`
  - `apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts:349-356`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-281 [HIGH] Dashboard shape drift empties the Queues tab and blanks stats: FE expects queues/failedToday, backend sends queueStats/failedJobs

- **Status:** PENDING
- **Symptom:** getJobDashboard returns {totalJobs, pendingJobs, runningJobs, failedJobs, completedLast24h, avgProcessingTime, queueStats, recentJobs, failedJobsList, scheduledJobs} (job-queue.service.ts:630-641). FE expects {completedToday, failedToday, avgDuration, queues} (JobQueuePage.tsx:19-28). dashboard.queues is undefined -> safeQueues=[] (l.205) -> Queues tab renders nothing and Pause/Resume (l.560-574) plus the queue filter dropdown (l.352-359) are unreachable; the 'Failed Today' card (l.314) renders blank. Field names also diverge per-queue (pending/running vs pendingCount/activeCount, settings.ts types:227-235 vs JobQueueStats job-queue.service.ts:39-47).
- **Evidence:**
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:630-641`
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:19-28`
  - `web/modules/admin-panel/src/pages/system/JobQueuePage.tsx:205`
  - `web/modules/admin-panel/src/services/types/settings.ts:227-235`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-282 [MEDIUM] Route shadowing and a wrong stat: /jobs/scheduled and /jobs/failed resolve to GET :id; completedLast24h counts all completed jobs ever

- **Status:** PENDING
- **Symptom:** @Get(':id') (job-queue.controller.ts:399-401) is matched by the FE endpoints GET /system/jobs/scheduled and /system/jobs/failed (settings.ts:226-228) -> NotFound/UUID errors; POST /system/jobs/cleanup (settings.ts:229-230) matches no route at all. Backend completedLast24h uses `completedAt: LessThanOrEqual(now)` with the `yesterday` variable computed but unused (job-queue.service.ts:571-595) - it counts every completed job in history, a silently wrong metric.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts:399-401`
  - `web/modules/admin-panel/src/services/api/settings.ts:226-230`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:571-595`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## Cross-cutting findings

### APA-283 [CRITICAL] Systemic paginated-response contract break: backend {items,total} vs FE PaginatedResult {data,...} kills three of five pages

- **Status:** PENDING
- **Symptom:** Every system-management list endpoint returns {items,total} (queryMaintenanceModes global-settings.service.ts:582-583, queryErrorGroups error-tracking.service.ts:376-377, getOccurrencesForGroup l.399-407, queryJobs job-queue.service.ts:542-543, queryFeatureToggles l.198-199). The ResponseInterceptor only promotes {data,total} shapes into meta (response.interceptor.ts:47-65), so http-client's meta.page branch (http-client.ts:343-349) never fires and the FE's hand-written PaginatedResult {data,total,page,limit,totalPages} (services/types/common.ts:5-11) never matches reality. Consequences: MaintenancePage list always empty, JobQueuePage jobs list always empty, ErrorTrackingPage crashes on render. Only FeatureTogglesPage survives via an ad-hoc 'items' normalization labeled BUG-014 (FeatureTogglesPage.tsx:73-86) - proof the drift was seen once and patched locally instead of fixed at the contract.
- **Evidence:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts:47-65`
  - `web/modules/admin-panel/src/services/http-client.ts:341-349`
  - `web/modules/admin-panel/src/services/types/common.ts:5-11`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:73-86`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-284 [CRITICAL] Telemetry ingestion endpoints are architecturally unreachable: SUPER_ADMIN user-JWT guard on service-to-service write paths

- **Status:** PENDING
- **Symptom:** The global APP_GUARD PlatformAdminGuard (app.module.ts:283-289) requires a SUPER_ADMIN user access token on every admin-api route (platform-admin.guard.ts:151-177). That includes the ingestion endpoints the whole observability story depends on: POST /system/errors/report (error-tracking.controller.ts:235-237) and POST /system/performance/metrics[/request] (performance.controller.ts:260-278). Backend services authenticate to each other with signed internal headers, not SUPER_ADMIN JWTs, so no service can ever feed error tracking or application performance metrics. This single design choice is the root cause of both the permanently-empty Error Tracking page and the permanently-zero application metrics on the Performance dashboard.
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:283-289`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:151-177`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:235-237`
  - `apps/admin-api-service/src/system-management/controllers/performance.controller.ts:260-278`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-285 [HIGH] Control-plane theater: feature toggles, maintenance mode, and the job queue all persist real rows that nothing in the platform consumes

- **Status:** PENDING
- **Symptom:** Three of the five features are write-only control planes: feature toggles have no evaluate/gating callers anywhere (only the admin panel's own unused wrappers, settings.ts:88,97-101); maintenance checkMaintenanceMode has no gateway/middleware/shell consumer (grep of gateway-api/src for 'maintenance' is empty); the job queue has no registered handlers and no external producers (registerHandler job-queue.service.ts:224, zero callers). A SUPER_ADMIN can 'enable' a flag, 'start' a global maintenance, or 'create' a job and the platform behaves identically. These pages pass shallow testing (data persists and reloads) while delivering none of their operational purpose.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:88`
  - `apps/admin-api-service/src/system-management/services/global-settings.service.ts:469-519`
  - `apps/admin-api-service/src/system-management/services/job-queue.service.ts:224-227`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:477-483`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-286 [MEDIUM] contract-validation.spec.ts KNOWN_DRIFT allowlist masks live breakage and contains stale/incorrect reasons

- **Status:** PENDING
- **Symptom:** The FE-BE contract test explicitly allowlists the broken routes found in this audit - POST feature-toggles/:id/toggle ('Backend uses PUT ... with status field', spec:634-639) and PUT errors/groups/:id/status - and also allowlists /system/performance/* and /system/errors/* endpoints with the reason 'not in global-settings controller' (spec:641-707) even though those endpoints DO exist in PerformanceController/ErrorTrackingController. The allowlist converts real 404-producing drift into permanent green tests, which is exactly how the toggle button and acknowledge action shipped broken.
- **Evidence:**
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:634-639`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:641-707`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-287 [LOW] Schema/migration discipline is correct for this module (verified, no finding)

- **Status:** PENDING
- **Symptom:** All 11 system-management entities declare schema:'admin' as required for a platform-level service (e.g. feature-toggle.entity.ts:38, maintenance-mode.entity.ts:46, job-queue.entity.ts:52,161,219, error-tracking.entity.ts:65,129,211, performance-metric.entity.ts:63,128), and all tables are created by the active Baseline migration (apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:35-69) with matching indexes; the archived initial migration is outside the runtime glob (app.module.ts:117 'migrations/[0-9]*'). SUPER_ADMIN guarding is uniformly applied via APP_GUARD. Recorded as verified context so other sections do not re-audit it.
- **Evidence:**
  - `apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts:38`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:35-69`
  - `apps/admin-api-service/src/app.module.ts:117`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
