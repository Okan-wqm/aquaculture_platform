# Settings / Email Templates / IP Rules / Audit Log — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## SystemSettingsPage.tsx — `/admin/settings` — verdict: **PARTIAL**

**Chain:** Reads/writes go through federated GraphQL (shell nginx /graphql -> gateway -> config-service subgraph, resolver ConfigurationResolver, table config.configurations) — this chain is real and persists. Two legacy REST endpoints remain: GET /api/settings/system/info and POST /api/settings/config/email/test (nginx rewrites /api/* -> /api/v1/* on admin-api-service; both routes exist and are guarded). HOWEVER: everything the page saves except the Billing tab is functionally inert — SystemSettingService reads only env vars, EmailSenderService sends with env-var SMTP config, and no runtime service (auth, gateway, notification) consumes the email.*, security.*, rate_limit.* or maintenance.* keys from config-service. Only billing.stripe_enabled/billing.stripe_secret_key are consumed at runtime (billing-service ConfigClientModule + DynamicStripeClientProvider).

**Endpoints exercised:** `POST /graphql effectiveConfigurationsByService(service:"platform") -> config-service`; `POST /graphql setConfiguration(...) -> config-service`; `GET /api/v1/settings/system/info`; `POST /api/v1/settings/config/email/test`

**DB tables:** `config.configurations`, `config configuration_history (via setConfiguration reason)`

### APA-340 [CRITICAL] Email, Security, Rate-Limit and Maintenance settings persist but nothing enforces or consumes them (false configuration)

- **Status:** PENDING
- **Symptom:** The page saves email.smtp_*, security.* (password policy, MFA, lockout), rate_limit.* and maintenance.mode_enabled to config.configurations, but no runtime service reads these keys. Repo-wide grep for the keys (security.max_login_attempts, security.password_min_length, maintenance.mode_enabled, rate_limit.global_rpm) matches only the config-service seed migration, tests, and the admin FE mapper. auth-service, gateway-api and notification-service do not import ConfigClientModule (only billing-service does, for billing.* keys). A SUPER_ADMIN who tightens the password policy, enables maintenance mode, or changes SMTP credentials sees 'saved' but the platform behavior does not change — false security. Only the Billing tab (stripe_enabled/stripe_secret_key) has a real runtime consumer.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/platform-configuration.ts:294-354 (write builders for email/security/rate-limit/maintenance keys)`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:160-183,200-280 (all runtime reads are process.env, updates throw 410 Gone)`
  - `apps/billing-service/src/billing/billing.module.ts:9,95-98 (only ConfigClientModule consumer, billing.* keys only)`
  - `libs/backend-common/src/billing/dynamic-stripe-client.provider.ts:55-57,192 (consumes billing.stripe_enabled / billing.stripe_secret_key)`
  - `grep of security.max_login_attempts|maintenance.mode_enabled|rate_limit.global_rpm across repo: matches only apps/config-service/src/database/migrations/1805400000000-SeedPlatformConfigurations.ts, tests, and the FE mapper — no runtime consumer`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-341 [HIGH] 'Send Test' tests the env-var SMTP config, not the settings the admin typed or saved

- **Status:** PENDING
- **Symptom:** The Send Test button posts {to} to /settings/config/email/test. The handler calls EmailSenderService.testConnection()/sendEmail(), which builds its transporter from SystemSettingService.getEmailConfigForSending() — pure process.env SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD reads. The SMTP values in the form (persisted to config-service) are never used by the test, so a green 'SMTP test email sent' does not validate what was saved, and a failing test can contradict correct saved settings. The edited form values are not even sent in the request body.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:560-575 (handleTestEmail sends only fromAddress as 'to')`
  - `apps/admin-api-service/src/settings/settings.controller.ts:206-233 (test uses EmailSenderService only)`
  - `apps/admin-api-service/src/settings/services/email-sender.service.ts:122-160 (transporter from getEmailConfigForSending)`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:172-183,343-358 (env-var only source)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-342 [MEDIUM] System Info tab contract drift — server/database sections never render, returned data not displayed

- **Status:** PENDING
- **Symptom:** FE SystemInfo type expects {platform, server, database}; backend GET /settings/system/info returns {platform:{name,version}, security, rateLimits, maintenance}. The tab therefore renders only a two-field Platform card; the 'Server Information' and 'Database Information' cards are permanently absent, and the security/rateLimits/maintenance payload the backend does return is silently discarded. platform name/version are also hardcoded strings, not live values.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:41-45,438-474 (SystemInfo type + conditional cards)`
  - `apps/admin-api-service/src/settings/settings.controller.ts:389-409 (actual response shape, hardcoded name/version)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-343 [LOW] Retired settings endpoints still exposed and return 410 at runtime

- **Status:** PENDING
- **Symptom:** SettingsController still mounts PUT /settings/key/:key, PUT /settings/bulk, PUT /settings/config/email|security|rate-limits|maintenance|billing and POST /settings/import — all of which unconditionally throw GoneException from SystemSettingService. Dead guarded surface; any stale client gets 410s.
- **Evidence:**
  - `apps/admin-api-service/src/settings/settings.controller.ts:140-177,195-204,249-283,297-334,371-380`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:121-142,418-421`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## EmailTemplatesPage.tsx — `/admin/settings/email` — verdict: **PARTIAL**

**Chain:** List/edit/toggle/delete chain is real: FE /settings/email-templates* -> nginx -> /api/v1/settings/email-templates* -> EmailTemplateController -> EmailTemplateService -> TypeORM repository on admin.email_templates (entity declares schema 'admin'; table + columns created in Baseline migration 1800000000000, defaults seeded at module init). BUT the templates are an orphaned store: no email send path in the platform reads them — notification-service EmailService uses hardcoded inline HTML templates and env SMTP; EmailTemplateService is imported only inside admin-api's settings module; the backend template test-send endpoint is an explicit stub. Additionally the 'New Template' UI flow cannot create anything (state initialized null, all inputs no-op).

**Endpoints exercised:** `GET /api/v1/settings/email-templates`; `POST /api/v1/settings/email-templates`; `PUT /api/v1/settings/email-templates/:id`; `DELETE /api/v1/settings/email-templates/:id`; `GET /api/v1/settings/email-templates/:id/preview (FE fn exists, page previews client-side)`; `POST /api/v1/settings/email-templates/:id/test (FE fn exists, no UI button; backend stub)`

**DB tables:** `admin.email_templates`

### APA-344 [CRITICAL] Email templates are never consumed by any real send path — edits have zero effect on emails actually sent

- **Status:** PENDING
- **Symptom:** Every real email the platform sends (welcome/invitation, alerts, regulatory reports) is generated by notification-service EmailService from hardcoded inline template strings with env-var SMTP config; it never queries admin.email_templates. EmailTemplateService (render/getTemplateByCode) is referenced only inside admin-api's own settings module, whose sole 'send' consumer is the stubbed test endpoint. An admin editing the 'Welcome Email' or 'Password Reset' template — including deactivating a template — changes nothing in production email, while the UI reports 'Template saved successfully'. This is exactly the silent-wrong-data scenario the audit was asked to check.
- **Evidence:**
  - `apps/notification-service/src/notification/services/email.service.ts:224-306,311-391,506-643 (hardcoded generate*Template methods; no repository/template read)`
  - `apps/notification-service/src/notification/services/email.service.ts:134-160 (env-var SMTP transporter)`
  - `grep EmailTemplateService across apps/: only apps/admin-api-service/src/settings/* match`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:162-181 (only send-adjacent consumer is the stub)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-345 [HIGH] 'New Template' creation is impossible — modal state never initializes, typing is a no-op, Save silently does nothing

- **Status:** PENDING
- **Symptom:** The New Template button sets selectedTemplate to null and opens the edit modal. Every input's onChange is setSelectedTemplate(prev => prev ? {...prev, field} : null) — with prev===null this returns null, so no keystroke is ever stored; '+ Add Variable' has the same guard. handleSaveTemplate begins with 'if (!selectedTemplate) return;' so Save exits silently with no request and no feedback. settingsApi.createEmailTemplate (POST) is therefore unreachable dead code; the page's create flow is broken end-to-end while the backend create endpoint works.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:147-150 (setSelectedTemplate(null) then open modal)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:353-359,416-424,493-505 (prev ? ... : null no-op handlers)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:72-87 (early return; create branch unreachable)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-346 [HIGH] Backend template test-send endpoint is a stub — returns 'Test email would be sent (email service integration required)'

- **Status:** PENDING
- **Symptom:** POST /settings/email-templates/:id/test only renders the template and returns a canned message; no email is dispatched even though admin-api has a working EmailSenderService in the same module. The page currently exposes no test-send button, so the capability advertised by the FE api layer (sendTestEmail) and the page docstring ('test etme') does not exist for users, and would be fake if wired.
- **Evidence:**
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:158-181 (stub comment + canned response)`
  - `web/modules/admin-panel/src/services/api/email-templates.ts:25-26 (FE function exists)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:1-6 (docstring promises testing; no button in JSX)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-347 [MEDIUM] DB unique constraint on code makes the tenant-override feature impossible

- **Status:** PENDING
- **Symptom:** admin.email_templates has UNIQUE("code") (entity @Column({unique:true}) + Baseline migration), but EmailTemplateService models per-tenant overrides as a second row with the same code and a tenantId (createTenantOverride, getTemplateByCode fallback). Any POST /settings/email-templates/code/:code/override will violate the unique constraint and 500. Service-level duplicate check is code+tenantId; DB enforces global code uniqueness — the two contracts contradict.
- **Evidence:**
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts:52-60 (@Index unique + @Column unique on code)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:109-111 (UQ + unique index on code)`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:624-665 (creates second row with same code)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-348 [MEDIUM] Template CRUD bodies bypass the global ValidationPipe — DTOs are TS interfaces, no server-side validation

- **Status:** PENDING
- **Symptom:** CreateEmailTemplateDto/UpdateEmailTemplateDto are plain interfaces exported from the service, so the global ValidationPipe (whitelist+forbidNonWhitelisted) skips them (metatype erases to Object). Arbitrary/oversized bodies, wrong-typed variables arrays, or junk categories are persisted unvalidated. Same applies to the variables jsonb payload rendered later in an iframe preview.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:20-43 (interface DTOs)`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:87-101 (@Body typed with interfaces)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489 (global pipe config that these bodies bypass)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-349 [MEDIUM] Enable/Disable toggle failures are swallowed — console.error only, optimistic UI already reconciled

- **Status:** PENDING
- **Symptom:** handleToggleActive catches errors with console.error and sets no error state; on failure the user gets no feedback at all (state is only updated after success, so the row silently stays unchanged with no message). Also console.* usage violates the repo logging rule.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:89-98`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-350 [LOW] Preview API response shape drift (latent)

- **Status:** PENDING
- **Symptom:** FE previewEmailTemplate types the response as {html,text,subject}; backend previewTemplate returns {subject,bodyHtml,bodyText}. The page does client-side preview so nothing breaks today, but any consumer of the FE function would read undefined fields. contract-validation.spec.ts still lists the pre-fix POST/GET drift entries as accepted exceptions.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/email-templates.ts:22-23`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:735-755`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:779-789`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## IpAccessRulesPage.tsx — `/admin/settings/integrations` — verdict: **PARTIAL**

**Chain:** The page's CRUD chain is fully real: /settings/ip-access* -> nginx -> /api/v1/settings/ip-access* -> IpAccessController -> IpAccessService -> TypeORM repository on admin.ip_access_rules (schema declared; table in Baseline migration; response fields match the FE type field-for-field). The manual 'Check' tool runs a real DB evaluation with CIDR matching and records hits. BUT the rules are enforced nowhere: no request path consults IpAccessService — the only IP guard in the platform (gateway-api IpWhitelistGuard) is never registered on any route, is disabled by default, and reads env vars, not this table. The admin-managed whitelist/blacklist is pure theater.

**Endpoints exercised:** `GET /api/v1/settings/ip-access?limit=100`; `POST /api/v1/settings/ip-access`; `PUT /api/v1/settings/ip-access/:id`; `DELETE /api/v1/settings/ip-access/:id`; `POST /api/v1/settings/ip-access/check`

**DB tables:** `admin.ip_access_rules`

### APA-351 [CRITICAL] IP access rules are persisted but enforced by nothing — blacklisting an IP blocks nothing (false security)

- **Status:** PENDING
- **Symptom:** IpAccessService.checkIpAccess is called only by the admin panel's manual Check button (POST /settings/ip-access/check). Repo-wide grep shows no middleware, guard, or gateway component consuming ip_access_rules or IpAccessService. gateway-api's IpWhitelistGuard: (a) appears in no APP_GUARD/@UseGuards registration anywhere (only its own file and spec), (b) defaults to disabled (IP_WHITELIST_ENABLED=false), and (c) sources its lists from IP_WHITELIST/IP_WHITELIST_CIDR env vars with an in-memory tenantWhitelists map that nothing populates from the DB. A SUPER_ADMIN blacklisting an attacker IP, or whitelisting an office range expecting default-deny, changes nothing at any ingress point. The page's 'Total Hits' stat reinforces the illusion — hitCount only increments via the manual Check tool.
- **Evidence:**
  - `grep checkIpAccess|IpAccessService|ip_access across repo: only admin-api settings module + FE + docs match`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts:87-99 (env-var source, enabled=false default), 94 (tenantWhitelists = new Map() never populated from DB)`
  - `grep IpWhitelistGuard in apps/gateway-api/src: only guard file + spec — no registration`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:146-151 (manual check is the sole consumer)`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:266-269 (hitCount only via checkIpAccess)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-352 [MEDIUM] Backend route shadowing: GET /settings/ip-access/stats is captured by @Get(':id')

- **Status:** PENDING
- **Symptom:** @Get('stats') is declared after @Get(':id') in IpAccessController, so /settings/ip-access/stats resolves to getRuleById('stats'); the id column is uuid so the lookup errors (invalid uuid input) instead of returning statistics. The FE dodges this by computing stats client-side, but the server statistics endpoint (incl. mostHitRules) is unreachable.
- **Evidence:**
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:98-101 (@Get(':id')) vs 216-219 (@Get('stats') declared later)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:112 (id uuid)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-353 [MEDIUM] Rule list and stats capped at first 100 rules with no pagination UI

- **Status:** PENDING
- **Symptom:** loadData requests limit=100 and the page renders no pager; the stats cards (Total Rules, counts, Total Hits) are computed from that first-page subset, so once more than 100 rules exist both the table and every stat silently under-report. Backend getAllRules also loads ALL rules into memory before slicing (in-process pagination).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:60-73 (limit:100 + client-side stats)`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:62-82 (in-memory slice pagination)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-354 [MEDIUM] Bulk Add loops single-create and aborts on first failure, leaving partial inserts; backend bulk endpoints unused

- **Status:** PENDING
- **Symptom:** handleBulkAdd issues one POST per line; a duplicate (409) or invalid IP mid-list throws, aborting the remaining IPs while earlier ones are already committed — the error banner gives no per-IP breakdown. The purpose-built POST /settings/ip-access/{whitelist,blacklist}/bulk endpoints (ArrayMaxSize 500, per-IP validation, added/skipped/errors report) are never called by the FE. Note the bulk endpoints' @IsIP would also reject CIDR entries the single-create path accepts, so the two paths have divergent contracts.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:107-130 (sequential loop, single try/catch)`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:37-46,161-195 (unused bulk endpoints; @IsIP each)`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:425-433 (single-create accepts CIDR)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-355 [LOW] CRUD DTOs are TS interfaces — global ValidationPipe skipped; FE 'isActive' on create silently ignored

- **Status:** PENDING
- **Symptom:** CreateIpAccessRuleDto/UpdateIpAccessRuleDto are interfaces, so bodies bypass whitelist validation (service does its own IP/CIDR regex — IPv6 regex only matches full uncompressed form, rejecting '::1'-style addresses). The FE sends isActive on create but the service unconditionally sets isActive:true.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:17-31 (interface DTOs), 144-148 (isActive:true override), 425-432 (simplified IPv6 regex)`
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:90-96 (isActive in payload)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## AuditLogPage.tsx — `/admin/audit` — verdict: **PARTIAL**

**Chain:** The ledger itself is real and well-protected: GET /api/v1/audit-logs -> AuditLogController -> AuditLogService -> admin.audit_logs (schema declared, Baseline migration with append-only UPDATE/DELETE-blocking trigger, legalHold column, inet ipAddress; reads are meta-audited). The default page load (page+limit only) and the statistics cards work against real aggregation queries. BUT every filter control and the Export button are broken by the global ValidationPipe: the controller mixes named @Query params with an un-named @Query() PaginationQueryDto, so any query string containing filter keys (action/severity/entityType/tenantId/search/startDate/endDate) fails forbidNonWhitelisted with 400, and Export's limit=10000 violates @Max(100). On top of that the FE severity vocabulary and the metadata field name don't match the backend.

**Endpoints exercised:** `GET /api/v1/audit-logs?page&limit(&filters)`; `GET /api/v1/audit-logs/statistics`; `GET /api/v1/tenants?limit=100 (filter dropdown via tenantsApi.list)`

**DB tables:** `admin.audit_logs`, `auth.tenants (indirectly, tenant dropdown)`

### APA-356 [HIGH] Every filter on the audit page returns 400 — @Query() DTO + forbidNonWhitelisted rejects the filter keys

- **Status:** PENDING
- **Symptom:** queryAuditLogs declares named @Query('action'|'severity'|...) params AND '@Query() pagination?: PaginationQueryDto'. The global ValidationPipe (whitelist:true, forbidNonWhitelisted:true — libs/backend-common bootstrap, no overrides in admin-api main.ts) validates the ENTIRE req.query object against PaginationQueryDto for the un-named param; any request carrying action/severity/entityType/tenantId/search/startDate/endDate therefore 400s ('property X should not exist'). The unfiltered default load (page,limit) succeeds, so the page looks healthy until a filter is touched, then flips to the error card. In production disableErrorMessages masks the reason entirely.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.controller.ts:42-54 (named filters + @Query() PaginationQueryDto on one handler)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489 (global whitelist+forbidNonWhitelisted pipe)`
  - `apps/admin-api-service/src/main.ts:10-36 (no validationPipeOverrides)`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25 (only page/limit/sortBy/sortOrder whitelisted)`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:290-307 (filters appended to same query string)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-357 [HIGH] Export always fails (limit=10000 > @Max(100)); even if accepted it would silently truncate to 100 rows

- **Status:** PENDING
- **Symptom:** handleExport always sends limit=10000; PaginationQueryDto caps limit at @Max(100) so the request 400s and the user gets 'Export failed'. Were the DTO cap removed, AuditLogService.query clamps take to Math.min(limit,100), so a 'full CSV export' would silently contain at most 100 of potentially thousands of records — silent data loss in a compliance export.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:339-374 (limit:'10000')`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:11-16 (@Max(100))`
  - `apps/admin-api-service/src/audit/audit.service.ts:119-120 (take = Math.min(limit,100))`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-358 [HIGH] Severity vocabulary drift: FE uses low/medium/high/critical, backend enum is info/warning/critical

- **Status:** PENDING
- **Symptom:** The FE AuditLog type and the severity filter dropdown use 'low'|'medium'|'high'|'critical'; the DB enum is 'info'|'warning'|'critical' (admin.audit_logs_severity_enum). Three of four filter options could never match a row (independent of the 400 issue), and rows with severity 'info'/'warning' render with the fallback gray badge instead of their intended styling. Only the 'Critical Events' stat card happens to align.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/audit.ts:13`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:69-75,120-128`
  - `apps/admin-api-service/src/audit/audit.entity.ts:54-58`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:7`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-359 [HIGH] Detail modal 'Metadata' section can never display — FE reads log.metadata, backend field is 'details'

- **Status:** PENDING
- **Symptom:** The backend entity/response carries the structured payload in 'details' (plus previousValue/newValue); the FE type declares 'metadata' and the modal gates on log.metadata && Object.keys(log.metadata).length — always undefined, so the audit entry's actual payload (the substance of the audit record) is silently hidden from reviewers. previousValue/newValue are not rendered at all.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/audit.ts:14`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:211-218`
  - `apps/admin-api-service/src/audit/audit.entity.ts:122-129`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-360 [MEDIUM] Search is doubly broken: uuid ILIKE would raise a DB error that the service converts into a silent empty result

- **Status:** PENDING
- **Symptom:** Beyond the 400 from forbidNonWhitelisted, the search SQL includes 'audit.entityId ILIKE :search' on a uuid column — Postgres has no uuid~~*text operator, so the query would error; query()'s catch block then returns {data:[],total:0} with HTTP 200, and the page shows 'No audit logs found'. The same catch swallows ANY DB failure into an empty page (silent failure on a compliance surface). The search also never matches performedByEmail despite the placeholder 'Search by user...'.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.service.ts:178-188 (entityId ILIKE), 199-211 (catch returns empty page)`
  - `apps/admin-api-service/src/audit/audit.entity.ts:100-101 (entityId uuid)`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:508-509 (placeholder promises user search)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-361 [LOW] Table column sort flags are cosmetic and CSV export omits tenant/metadata columns

- **Status:** PENDING
- **Symptom:** Columns are marked sortable but no sort parameter is ever sent (backend orders createdAt DESC only; PaginationQueryDto sortBy is ignored by AuditLogService). The CSV includes 7 columns and drops tenantId, userAgent and details even for the rows it does fetch. CSV cell escaping/formula-injection protection is present and correct.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:377-436 (sortable flags, no sort wiring), 352-361 (CSV columns)`
  - `apps/admin-api-service/src/audit/audit.service.ts:122-124 (fixed ORDER BY)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## Cross-cutting findings

### APA-362 [HIGH] Service-wide footgun: mixing named @Query params with an un-named @Query() PaginationQueryDto 400s every filtered list under the global forbidNonWhitelisted pipe

- **Status:** PENDING
- **Symptom:** The pattern found on the audit endpoint is repeated across admin-api: support/controllers/ticket.controller.ts (6 handlers) and billing/billing.controller.ts (3 handlers) combine filter @Query('x') params with '@Query() pagination?: PaginationQueryDto'. Under the shared bootstrap's ValidationPipe (whitelist + forbidNonWhitelisted, no admin-api overrides) the whole query object is validated against the 4-property DTO, so any filter/search/status query param on those endpoints is rejected with 400. Architectural fix: give each endpoint a real query DTO containing its filters (or extend PaginationQueryDto per-resource) so the type system matches the wire contract — do not relax the pipe.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.controller.ts:42-54`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:170,201,236,249,357,397`
  - `apps/admin-api-service/src/billing/billing.controller.ts:433,468,538`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-363 [HIGH] Admin 'configuration' is split across three disconnected stores; the admin panel writes the one nothing reads

- **Status:** PENDING
- **Symptom:** Runtime behavior comes from env vars (SystemSettingService, EmailSenderService, notification-service EmailService, gateway IpWhitelistGuard); the admin panel writes config-service rows (config.configurations) that only billing-service consumes; and the legacy admin.system_settings store is dropped with its endpoints returning 410. For email/SMTP specifically there are two independent senders (admin-api EmailSenderService and notification-service EmailService), both env-configured, neither reading either the saved config-service SMTP settings or the admin.email_templates content. Until the remaining services adopt the ConfigClientModule pattern billing-service already uses (and notification-service reads admin/email templates or owns them), the settings and email-template pages are administrative theater.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:160-183,343-358`
  - `apps/notification-service/src/notification/services/email.service.ts:120-160`
  - `apps/billing-service/src/billing/billing.module.ts:9,95-98 (the working precedent)`
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts:39-47 (410/dropped-store note)`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts:87-99`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-364 [MEDIUM] Settings-module CRUD DTOs are TypeScript interfaces, so the global ValidationPipe validates nothing on those bodies

- **Status:** PENDING
- **Symptom:** CreateEmailTemplateDto/UpdateEmailTemplateDto/RenderTemplateDto and CreateIpAccessRuleDto/UpdateIpAccessRuleDto are interfaces exported from services; their runtime metatype is Object so whitelist/forbidNonWhitelisted/type validation are all skipped. Only CheckIpAccessDto/BulkIpDto/TestEmailConfigDto and the settings-controller config DTOs are real class-validator classes. SUPER_ADMIN-only exposure lowers the risk, but it contradicts the platform's own validation standard and lets malformed jsonb (variables), unbounded HTML bodies, and junk enum values reach the DB.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:20-49`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:17-31`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:26-46 (contrast: validated classes)`
  - `apps/admin-api-service/src/settings/settings.controller.ts:42-88 (contrast: validated classes)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-365 [LOW] Auth/guard coverage verified — no unguarded endpoints in this section

- **Status:** PENDING
- **Symptom:** PlatformAdminGuard is registered as a global APP_GUARD in admin-api (RS256 verifyAsync with issuer/audience, access-token-type enforcement, SUPER_ADMIN role required by default, decorators can only narrow, never widen); none of the settings/email-template/ip-access/audit controllers carry @Public. ThrottlerGuard is also global and sensitive settings mutations add @ThrottleSensitive. Every FE call in this section requires a SUPER_ADMIN bearer token; nginx rewrites /api/* to the versioned /api/v1/* prefix so all audited FE paths resolve to real routes (method+path verified).
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:277-290 (APP_GUARD wiring)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:78-179`
  - `infrastructure/nginx/droplet.conf:377-399 (rewrite ^/api/(.*) /api/v1/$1)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:603-611 (globalPrefix 'api/v1')`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
