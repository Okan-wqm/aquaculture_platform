# Cross-cutting: Routing & Navigation — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## Cross-cutting findings

### APA-251 [CRITICAL] Feature-toggle switch (FeatureTogglesPage primary action) calls a route that does not exist on the backend

- **Status:** PENDING
- **Symptom:** systemSettingsApi.toggleFeature() sends POST /api/system/settings/feature-toggles/:id/toggle. After the droplet nginx rewrite this reaches admin-api as /api/v1/system/settings/feature-toggles/:id/toggle, but GlobalSettingsController ('system/settings') declares only feature-toggles (POST create, GET list), feature-toggles/:id (GET/PUT/DELETE), feature-toggles/evaluate and feature-toggles/refresh-cache — there is no ':id/toggle' route, so Nest returns 404 on every click. FeatureTogglesPage.tsx:108 wires this directly to the on/off switch, i.e. the page's primary flow can never succeed against the real API. Related dead route on the same controller: getFeatureToggleByKey() GETs feature-toggles/key/:key which also has no backend match.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/settings.ts:95-96 (toggleFeature POST `/system/settings/feature-toggles/${id}/toggle`)`
  - `web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:108 (await systemSettingsApi.toggleFeature(toggle.id, newEnabled))`
  - `apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts:434-491 (feature-toggle routes: no ':id/toggle', no 'key/:key')`
  - `web/modules/admin-panel/src/services/api/settings.ts:88 (getFeatureToggleByKey `/system/settings/feature-toggles/key/${key}`)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-252 [HIGH] docker-compose.prod.yml stack routes /api/ to gateway-api, which has no admin proxy — entire admin panel REST surface 404s on that stack

- **Status:** PENDING
- **Symptom:** nginx.prod.conf 'location /api/' proxies to upstream 'gateway' with no path rewrite. gateway-api's only REST controllers are 'api' (csp-report only), 'api/marine', 'api/v1/sensors', 'upload', 'health', 'metrics' — nothing handles /api/users, /api/analytics/*, /api/billing/*, etc. The ServiceProxyService that contains an admin-api-service config is dead code: it is never registered in any module and has zero consumers in gateway-api/src; even if wired, its config uses stripPrefix '/api' with no addPrefix, so it would forward '/users' to a service whose routes live under '/api/v1/users' (contrast auth-service which correctly sets addPrefix '/api/v1'). Only the droplet stack works: droplet.conf's /api/ catch-all rewrites ^/api/(.*) to /api/v1/$1 and proxies directly to admin-api-service:3000, which matches admin-api's bootstrap (globalPrefix default 'api/v1' + URI versioning defaultVersion ['1', VERSION_NEUTRAL]). The /api/health/ carve-out (rewrite to /health/, matching the prefix-excluded HealthController) and the /api/upload/, /api/v2/ai/, /api/csp-report carve-outs do not collide with any admin-panel path prefix.
- **Evidence:**
  - `infrastructure/docker/nginx/nginx.prod.conf:213-216 (location /api/ -> proxy_pass http://gateway, no rewrite)`
  - `docker-compose.prod.yml:751 (mounts nginx.prod.conf)`
  - `apps/gateway-api/src/proxy/service-proxy.service.ts:942-949 (adminApiService config: stripPrefix '/api', no addPrefix)`
  - `apps/gateway-api/src/proxy/service-proxy.service.ts:896-904 (authService has addPrefix '/api/v1' — admin config omits it)`
  - `grep 'ServiceProxyService' across apps/gateway-api/src: zero references outside its own file (not provided in any module)`
  - `apps/gateway-api/src/csp-report/csp-report.controller.ts:63 (@Controller('api') serves only POST csp-report)`
  - `infrastructure/nginx/droplet.conf:377-394 (working path: rewrite ^/api/(.*) /api/v1/$1 -> admin-api-service:3000)`
  - `infrastructure/nginx/droplet.conf:305-319 (/api/health/ carve-out -> /health/ unversioned)`
  - `apps/admin-api-service/src/main.ts:16-19 (URI versioning, defaultVersion ['1', VERSION_NEUTRAL])`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:610,807-810 (globalPrefix default 'api/v1'), 251-255 (health/metrics excluded)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-253 [HIGH] No dev-mode route to admin-api: shell vite has no /api proxy and the default/dev compose stacks have no outer nginx

- **Status:** PENDING
- **Symptom:** http-client.ts and blob-client.ts default ADMIN_API_URL to '/api' (VITE_ADMIN_API_URL is never set anywhere in the repo — no compose env, no vite define). The shell vite dev server (port 3000) declares no server.proxy at all, so /api/* in `npm run dev:web` hits the vite server and 404s. In docker-compose.yml / docker-compose.dev.yml, localhost:8080 maps straight to the shell container whose nginx (shell.conf) deliberately removed all /api proxying (ARCH-NM-003 comment: 'must be routed through the outer nginx reverse proxy'), but neither compose file defines that outer nginx — /api/users falls through to the SPA fallback and returns index.html with HTTP 200, which apiFetch then feeds to JSON.parse (http-client.ts:341) producing an unhandled SyntaxError rather than a clean API error. The admin panel's backend surface is unreachable in every non-droplet run mode.
- **Evidence:**
  - `web/modules/admin-panel/src/services/http-client.ts:22-23 (ADMIN_API_URL default '/api')`
  - `web/modules/admin-panel/src/services/blob-client.ts:4`
  - `web/shell/vite.config.ts:48-60 (server block: port/cors only, no proxy)`
  - `infrastructure/docker/nginx/shell.conf:5-7 (ARCH-NM-003: backend API proxies removed) and full file: no /api location, 'location /' try_files fallback to /index.html`
  - `docker-compose.yml:676 (shell 8080:80; no nginx reverse-proxy service in file)`
  - `docker-compose.dev.yml:536 (same)`
  - `web/modules/admin-panel/src/services/http-client.ts:336-351 (200 + HTML body -> JSON.parse throws; only fetch TypeErrors are retried/handled)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-254 [HIGH] 19 additional admin-panel API functions target routes that do not exist (or wrong method) on admin-api — phantom endpoints in the contract layer

- **Status:** PENDING
- **Symptom:** Exhaustive method-by-method match of all 475 apiFetch call sites in services/api/*.ts against all 603 admin-api route declarations (accounting for the nginx /api -> /api/v1 rewrite and VERSION_NEUTRAL mounting) shows 455 resolve to a real controller route; the remainder can never succeed. Besides the UI-wired toggleFeature (separate CRITICAL), the phantom functions are: database.ts:57 resetSchema (POST /database/schemas/:t/reset), :59 optimizeSchema, :61 analyzeSchema — SchemaController has no reset/optimize/analyze; database.ts:108 getMigration (GET /database/migrations/:id), :110 createMigration (POST root), :112 runMigration (POST :id/run), :114 rollbackMigration (POST :id/rollback), :115 getPendingMigrations (GET pending) — MigrationController only exposes available/summary/history/batch/* and tenant/:tenantId/* variants; database.ts:157 scheduleBackup (POST /database/backups/schedule vs GET-only route); database.ts:198 getDatabaseStats, :200 getTableStats, :202 runVacuum, :204 runAnalyze — MonitoringController has none of stats/tables/vacuum/analyze (only analyze-query); security.ts:45-46 getUserActivities (GET /security/activities/user/:userId — controller has sessions/user/:userId but not user/:userId); settings.ts:88 getFeatureToggleByKey; settings.ts:177 updateErrorGroupStatus (PUT /system/errors/groups/:id/status — controller has PUT groups/:id and POST resolve/ignore, no /status); settings.ts:204 drainQueue (POST /system/jobs/queues/:name/drain — only pause/resume exist); settings.ts:230 cleanupJobs (POST /system/jobs/cleanup — no such POST route); tenant-config.ts:324-328 testWebhook (POST /settings/tenant/:t/webhooks/:id/test — FE comment itself admits 'no backend endpoint yet'); reports.ts:67-68 getQuickReport (GET against /reports/quick/* which are POST-only). None of these 19 are currently referenced by any page/component (grep across pages/ and components/ excluding tests found zero call sites), so they are dead-but-exported contract drift; the misleading in-file comments 'Backend endpoint coverage: resetSchema...' (database.ts:55) and 'Backend endpoint coverage: getDatabaseStats...' (database.ts:197) falsely assert coverage and invite future wiring that will 404. All other FE path prefixes map to mounted controllers: /admin/tenants + /tenants (tenant.controller.ts:77,136), /analytics, /reports, /audit-logs, /billing, /database/{schemas,migrations,backups,monitoring,explorer}, /debug, /health (prefix-excluded + nginx carve-out), /impersonation, /messaging, /modules, /security/{activities,audit,compliance,monitoring}, /settings{,/email-templates,/ip-access,/tenant}, /support/{tickets,messages,announcements,onboarding}, /system{,/errors,/settings,/jobs,/performance}, /users. tenants.ts:66-68 retryProvisioningOperation resolves correctly to POST tenants/provisioning/:operationId/retry (tenant.controller.ts:117).
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/database.ts:55-61,105-115,150-157,197-204`
  - `apps/admin-api-service/src/database-management/controllers/schema.controller.ts:72-193 (no reset/optimize/analyze)`
  - `apps/admin-api-service/src/database-management/controllers/migration.controller.ts:98-198 (no root POST, no :id GET/run/rollback, no bare 'pending')`
  - `apps/admin-api-service/src/database-management/controllers/backup.controller.ts:147 (@Get('schedule') only)`
  - `apps/admin-api-service/src/database-management/controllers/monitoring.controller.ts:49-125 (no stats/tables/vacuum/analyze)`
  - `web/modules/admin-panel/src/services/api/security.ts:45-46 vs apps/admin-api-service/src/security/controllers/activity-log.controller.ts:224-329`
  - `web/modules/admin-panel/src/services/api/settings.ts:88,177,204,230`
  - `apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts:276-327 (no groups/:id/status)`
  - `apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts:301-458 (no queues/:name/drain, no POST cleanup)`
  - `web/modules/admin-panel/src/services/api/tenant-config.ts:323-328 ('testWebhook kept for backward compat (no backend endpoint yet)') vs apps/admin-api-service/src/settings/controllers/tenant-configuration.controller.ts:214-236`
  - `web/modules/admin-panel/src/services/api/reports.ts:64-68 vs apps/admin-api-service/src/analytics/controllers/reports.controller.ts:311-329 (quick/* are POST)`
  - `web/modules/admin-panel/src/services/api/tenants.ts:66-68 vs apps/admin-api-service/src/tenant/tenant.controller.ts:108-117 (retry path verified working)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-255 [HIGH] 10 mounted admin routes are unreachable: no sidebar entry and no in-page link (7 messaging pages, provisioning settings, billing plans, billing usage)

- **Status:** PENDING
- **Symptom:** The live navigation is the shell's MainLayout.tsx hand-maintained admin nav list, and it omits: the entire /admin/messaging/* section (monitoring, tenants, audit, compliance, retention, ai-dashboard, ai-personas — all routed in Module.tsx:141-147), /admin/settings/provisioning (Module.tsx:181; nav shows only General/Email/Integrations at MainLayout.tsx:142-144), /admin/billing/plans (PlanManagementPage, Module.tsx:131) and /admin/billing/usage (UsageDashboardPage, Module.tsx:135) — ADMIN_BILLING_ROUTES in shared-ui contains no 'plans' or 'usage' entry at all (its visible set is billing, module-pricing, subscriptions, invoices, payments, discounts, custom-plans). Grep across admin-panel pages/ and components/ finds zero <Link>/navigate references to any of these paths outside the dead admin-nav-items.tsx copy, so a SUPER_ADMIN can only reach these 10 shipped pages by typing URLs. (BillingReportsPage is fine — reachable via BillingDashboardPage.tsx:486.) No dead links were found in the opposite direction: every path in the live MainLayout admin nav, the visible ADMIN_BILLING_NAV_ITEMS, and AdminDashboard's quickLinks (AdminDashboard.tsx:51-57) resolves to a Module.tsx route.
- **Evidence:**
  - `web/shell/src/layouts/MainLayout.tsx:38-145 (live admin nav: no messaging section, settings children = general/email/integrations only)`
  - `web/modules/admin-panel/src/Module.tsx:131,135,141-147,181 (routes exist)`
  - `web/shared-ui/src/authz/admin-billing-routes.ts:29-126 (no plans/usage entries; visible filter)`
  - `grep 'billing/plans|billing/usage|settings/provisioning|/admin/messaging' over web/modules/admin-panel/src/pages+components: only hits are in dead components/admin-nav-items.tsx:180-186,224`
  - `web/modules/admin-panel/src/pages/BillingDashboardPage.tsx:486 (billing/reports reachable)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-256 [MEDIUM] Duplicate, already-drifted navigation SSoT: admin-panel's AdminLayout/admin-nav-items are dead code; the shell re-implements the menu by hand

- **Status:** PENDING
- **Symptom:** admin-panel exports AdminLayout + adminNavItems (components/index.ts:5-6) but nothing imports them — Module.tsx:5 notes the layout lives in the shell, and the shell's MainLayout.tsx duplicates the item list manually instead of consuming the exported SSoT. The two copies have already diverged: the dead copy contains the messaging section (7 items), settings-provisioning, and an api-docs external link hardcoded to http://localhost:3008/docs (broken outside localhost and Swagger is prod-disabled per SEC-L14); the live shell copy has none of these. This duplication is the root cause of the unreachable-pages finding above. Additionally routes/adminRoutes.ts — the only typed route-constant module — covers just 4 of the ~50 routes (dashboard, analytics, analyticsReports, audit) and is used by only two pages, so there is no compile-time guard tying nav links to Module.tsx routes; every other link is a raw string.
- **Evidence:**
  - `web/modules/admin-panel/src/components/index.ts:5-6 (exports)`
  - `grep 'AdminLayout' across web/shell/src: zero imports; web/shell/src/App.tsx:18,59,184,276 (MainLayout + adminPanel/Module mounted at /admin/*)`
  - `web/modules/admin-panel/src/Module.tsx:5 ('AdminLayout Shell'de kullanılıyor' — but shell does not import it)`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx:180-186,224,227 (drifted dead copy incl. localhost:3008 api-docs link)`
  - `web/shell/src/layouts/MainLayout.tsx:38-145 (hand-duplicated live copy)`
  - `web/modules/admin-panel/src/routes/adminRoutes.ts:1-6 (4 constants)`
  - `web/modules/admin-panel/src/pages/AdminDashboard.tsx:11,56 + pages/AnalyticsDashboardPage.tsx:13,526 (only consumers)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-257 [MEDIUM] CSRF double-submit is inert platform-wide: XSRF-TOKEN cookie is never issued and X-CSRF-Token is never validated

- **Status:** PENDING
- **Symptom:** http-client.ts attaches X-CSRF-Token from the XSRF-TOKEN cookie on POST/PUT/PATCH/DELETE and its docblock asserts 'the server set this cookie and will reject mutating requests whose X-CSRF-Token header does not match'. No such server component exists: grep for XSRF/csrf across apps/admin-api-service/src, apps/gateway-api/src, libs/backend-common/src, and all nginx configs finds no cookie issuance and no verification middleware (the only hits are unrelated threat-type strings in security-monitoring). Since the cookie is never set, getCsrfTokenFromCookie() returns null and the header is silently never sent; nothing rejects on mismatch. Actual mutation protection rests solely on the Bearer Authorization header (which is CSRF-resistant), so this is a dead control plus a false security claim in code comments rather than an exploitable hole — but any future move to cookie-based auth would ship with zero real CSRF defense while appearing to have one.
- **Evidence:**
  - `web/modules/admin-panel/src/services/http-client.ts:63-69,96-106,256-263 (client half of double-submit)`
  - `grep -rln 'XSRF|csrf' apps/admin-api-service/src libs/backend-common/src: only security-monitoring.controller.ts and security.entity.ts (unrelated); zero hits in apps/gateway-api/src, infrastructure/nginx, infrastructure/docker/nginx`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-258 [MEDIUM] Validation-error detail is lost end-to-end: ValidationPipe's message array is dropped by the FE error parser

- **Status:** PENDING
- **Symptom:** The platform ValidationPipe runs with whitelist+forbidNonWhitelisted (configureValidationPipe in the shared bootstrap), so extra/invalid body fields yield BadRequestException whose response body carries message: string[]. GlobalExceptionFilter passes that value through as 'message' in its flat {success:false, statusCode, message, error, timestamp, path, requestId} envelope. The FE parseApiErrorBody only accepts typeof message === 'string', so the array is discarded and apiFetch surfaces the generic 'HTTP 400' — the user sees no field-level reason for any 400 caused by DTO validation (including forbidNonWhitelisted rejections of drifted FE payload fields). Also note the error envelope is flat, not nested under 'error' (ErrorEnvelope interface at filter lines 22-25 is defined but unused) — the FE reads the flat shape, so that part is compatible; and body.code never exists (backend emits numeric statusCode + error name), so ApiError.code is always undefined — currently harmless since no admin-panel code branches on error.code, but the FE type advertises a field the backend never populates.
- **Evidence:**
  - `apps/admin-api-service/src/filters/global-exception.filter.ts:53-58 (flat spread envelope), 77-95 (message passthrough, no 'code' field), 22-25 (unused nested ErrorEnvelope)`
  - `web/modules/admin-panel/src/services/http-client.ts:175-185 (parseApiErrorBody: string-only message, expects 'code'), 297-305 (fallback 'HTTP ' + status)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:787 (configureValidationPipe global)`
  - `grep '.code ===|error.code|err.code' across admin-panel src: no consumer of ApiError.code`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-259 [LOW] Response envelope parity verified, with two structural fragilities in the pagination heuristic

- **Status:** PENDING
- **Symptom:** Verified working: ResponseInterceptor is registered as a global APP_INTERCEPTOR and emits {success:true, data, meta:{timestamp}} — or {success:true, data, meta:{total,page,limit,totalPages,timestamp}} when a handler returns an object with both 'data' and 'total' keys — exactly the envelope parseApiEnvelope expects ('success' + 'data' present), and the FE's meta.page re-spread reproduces the hand-written PaginatedResult {data,total,page,limit,totalPages} (plus a harmless extra 'timestamp' key). /health* responses skip the envelope (SKIP_PREFIXES) and the FE's raw-JSON fallback (return json as T) handles them; the blob download route writes via @Res() so it bypasses the interceptor correctly. Fragilities: (1) pagination detection is duck-typed on the exact key pair data+total — a paginated handler returning any other shape gets double-wrapped into the non-paginated branch and the FE would then hand pages an envelope-shaped object, while any domain payload that coincidentally contains 'data' and 'total' keys is silently rewritten into pagination meta; (2) in the pagination branch meta.page is emitted even when the source object lacks 'page' (key present, value undefined), which still triggers the FE's `'page' in meta` unwrap and yields page:undefined typed as number. Both are latent, not currently misfiring on the routes traced in this section.
- **Evidence:**
  - `apps/admin-api-service/src/shared/response.interceptor.ts:23-24,44-74 (skip list, duck-typed pagination, meta shape)`
  - `apps/admin-api-service/src/app.module.ts:291-294 (global APP_INTERCEPTOR registration)`
  - `web/modules/admin-panel/src/services/http-client.ts:187-197,341-351 (parseApiEnvelope + meta.page unwrap + raw fallback)`
  - `web/modules/admin-panel/src/services/types/common.ts:5-11 (PaginatedResult)`
  - `apps/admin-api-service/src/analytics/controllers/reports.controller.ts:295-305 (@Res() download bypasses interceptor)`
  - `apps/admin-api-service/src/health/health.controller.ts:151-167 (unwrapped health payloads consumed raw by FE system.ts:13-16)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
