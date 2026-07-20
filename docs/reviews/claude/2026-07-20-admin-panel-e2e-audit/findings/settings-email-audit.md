# Settings / Email Templates / IP Rules / Audit Log — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## SystemSettingsPage.tsx — `/admin/settings` — verdict: **PARTIAL**

**Chain:** Reads/writes go through federated GraphQL (shell nginx /graphql -> gateway -> config-service subgraph, resolver ConfigurationResolver, table config.configurations) — this chain is real and persists. Two legacy REST endpoints remain: GET /api/settings/system/info and POST /api/settings/config/email/test (nginx rewrites /api/* -> /api/v1/* on admin-api-service; both routes exist and are guarded). HOWEVER: everything the page saves except the Billing tab is functionally inert — SystemSettingService reads only env vars, EmailSenderService sends with env-var SMTP config, and no runtime service (auth, gateway, notification) consumes the email.*, security.*, rate_limit.* or maintenance.* keys from config-service. Only billing.stripe_enabled/billing.stripe_secret_key are consumed at runtime (billing-service ConfigClientModule + DynamicStripeClientProvider).

**Endpoints exercised:** `POST /graphql effectiveConfigurationsByService(service:"platform") -> config-service`; `POST /graphql setConfiguration(...) -> config-service`; `GET /api/v1/settings/system/info`; `POST /api/v1/settings/config/email/test`

**DB tables:** `config.configurations`, `config configuration_history (via setConfiguration reason)`

### APA-340 [HIGH] Email, Security, Rate-Limit and Maintenance settings persist but nothing enforces or consumes them (false configuration)

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** The page saves email.smtp_*, security.* (password policy, MFA, lockout), rate_limit.* and maintenance.mode_enabled to config.configurations, but no runtime service reads these keys. Repo-wide grep for the keys (security.max_login_attempts, security.password_min_length, maintenance.mode_enabled, rate_limit.global_rpm) matches only the config-service seed migration, tests, and the admin FE mapper. auth-service, gateway-api and notification-service do not import ConfigClientModule (only billing-service does, for billing.* keys). A SUPER_ADMIN who tightens the password policy, enables maintenance mode, or changes SMTP credentials sees 'saved' but the platform behavior does not change — false security. Only the Billing tab (stripe_enabled/stripe_secret_key) has a real runtime consumer.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/platform-configuration.ts:294-354 (write builders for email/security/rate-limit/maintenance keys)`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:160-183,200-280 (all runtime reads are process.env, updates throw 410 Gone)`
  - `apps/billing-service/src/billing/billing.module.ts:9,95-98 (only ConfigClientModule consumer, billing.* keys only)`
  - `libs/backend-common/src/billing/dynamic-stripe-client.provider.ts:55-57,192 (consumes billing.stripe_enabled / billing.stripe_secret_key)`
  - `grep of security.max_login_attempts|maintenance.mode_enabled|rate_limit.global_rpm across repo: matches only apps/config-service/src/database/migrations/1805400000000-SeedPlatformConfigurations.ts, tests, and the FE mapper — no runtime consumer`
- **Verification:** Verified end-to-end. FE writes are real: usePlatformConfiguration.ts -> gateway federated GraphQL -> config-service setConfiguration persists email.*/security.*/rate_limit.*/maintenance.* rows with history, and re-reads render the saved values (permanent false state). But the trusted read path is structurally billing-only: CONFIG_RUNTIME_SECRET_ALLOWLIST and CONFIG_RUNTIME_NONSECRET_ALLOWLIST (libs/event-contracts/src/config-runtime.ts:85-96) list only billing-service with only billing.stripe_* keys, and grep confirms ConfigClientModule is imported solely by apps/billing-service/src/billing/billing.module.ts:102. Per-domain refutation failed everywhere: notification-service builds its SMTP transporter from SMTP_* env (email.service.ts:135-145); auth-service lockout is constructor-frozen env config (authentication.service.ts:73,135,1295), password policy is a hard-coded PASSWORD_POLICY_REGEX constant + static @MinLength(8), MFA constants are in mfa.service.ts:53-56; gateway-api rate tiers come from RATE_LIMIT_* env (rate-limit.config.ts:34-54); zero matches for "maintenance" in apps/gateway-api/src. admin-api's SystemSettingService is a read-only env adapter whose writes throw 410 Gone and whose computed values nothing enforces. ConfigurationChanged events are consumed only by billing (filters billing.*). Downgraded to HIGH: not directly exploitable and the enforced posture stays at env/constant defaults (the real password regex is stricter than the phantom config), but a SUPER_ADMIN gets false assurance that maintenance mode, lockout policy, MFA policy, rate limits, and SMTP changes are live — a false-configuration defect across 4 of 5 settings tabs. This is an instance of the systemic "config-table-nobody-reads" class.
- **Root cause:** The broken link is store->runtime consumption, and it drifted because the ORPHAN-HIGH-373 remediation migrated only the WRITE plane: the admin Settings page was rewired from the retired admin-api system_settings store to config-service, and the platform seeded all five tabs' keys (1805400000000-SeedPlatformConfigurations.ts) so the page renders — while the full runtime-consumption spine that was built alongside it (ConfigRuntimeClient signed NATS request-reply, per-caller allowlists, ConfigurationChanged invalidation, DynamicStripeClientProvider) was instantiated for exactly one key family, billing.stripe_*. The owning runtime services (notification-service SMTP, auth-service lockout/password/MFA policy, gateway-api rate tiers and maintenance) kept their pre-existing env/constant configuration, and no build-time invariant requires that every operator-writable platform key have a registered runtime consumer, so the write plane and the enforcement plane diverged silently. The contract itself encodes the gap: CONFIG_RUNTIME_KEYS lists only the three Stripe keys.
- **Fix design:** Pattern-level fix for the config-table-nobody-reads class, applied locally to all four dead key families, reusing the proven billing spine. (1) CONTRACT AS SSoT (tier 1): extend libs/event-contracts/src/config-runtime.ts into a platform-key registry — grow CONFIG_RUNTIME_KEYS with the email.*, security.*, rate_limit.*, maintenance.* vocabulary and extend the two allowlists per owning consumer: notification-service gets non-secret email.smtp_host/port/secure/username/from_address/from_name plus SECRET email.smtp_password; auth-service gets the nine security.* keys; gateway-api gets the four rate_limit.* keys plus maintenance.mode_enabled. Add matching config.runtime.get (and for notification, get_secret) publish grants in infrastructure/nats/services.yaml with a per-consumer scoped reply-inbox prefix for the secret path (same SEC-CRITICAL-001 design as _INBOXBILLINGCFG — generalize the prefix per consumer service rather than widening the billing inbox), then regenerate nats.conf via scripts/nats/generate-nats-conf.py in the same commit. The existing nats-invariant cross-check (allowlist entry MUST have a matching services.yaml grant, secret/non-secret maps disjoint) makes an inconsistent extension fail CI automatically. (2) CONSUMPTION AUTOMATIC (tier 2): each owning service imports ConfigClientModule.forRoot({consumerService}) and adopts the DynamicStripeClientProvider pattern — TTL-cached snapshot, config-over-env precedence with env fallback on unreachable, ConfigurationChanged handler filtering its own key prefix for instant invalidation, warm-loss preservation for live SMTP. Concretely: notification-service replaces the boot-time env transporter in email.service.ts with a dynamic transport provider resolving email.* (secret via GET_SECRET); auth-service introduces a SecurityPolicyProvider read at call time by authentication.service (lockout threshold/duration move from constructor-frozen fields to per-call resolution in the failed-attempt accounting) and a PasswordPolicyService.assertCompliant() enforced in the service layer of change/reset/invite flows — the static DTO regex remains the structural floor, dynamic policy tightens above it; mfa_enabled gates the enforcement decision where evaluated; gateway-api overlays config rate_limit.* values on the env-built RateLimitEdgeConfig tiers via the same TTL provider inside the shared RateLimitGuard resolution, and adds a MaintenanceModeGuard at the gateway edge returning 503 for non-SUPER_ADMIN traffic when maintenance.mode_enabled=true (fail-open to not-in-maintenance on unreachable, mirroring the reachability discipline). (3) DRIFT DETECTABLE (tier 3): new invariant tests/invariants/platform-config-consumers.spec.ts asserts (a) every key produced by the admin FE write builders and every seeded platform key appears in the contract registry, and (b) every registry key is claimed by at least one consumer in the allowlists — so a future settings tab whose keys nobody reads fails CI at introduction. The FE mapper's key vocabulary is asserted equal to the contract registry by that same spec (the admin panel deliberately hand-writes FE types, so the equality invariant is the boundary gate). No defensive fallbacks hiding absence: a registry key with no consumer is a build failure, not a runtime default.
- **Files to change:**
  - `libs/event-contracts/src/config-runtime.ts`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `libs/backend-common/src/config-client/config-runtime.client.ts`
  - `libs/backend-common/src/config-client/config-client.module.ts`
  - `apps/notification-service/src/notification/services/email.service.ts`
  - `apps/notification-service/src/notification/notification.module.ts`
  - `apps/notification-service/src/notification/event-handlers/configuration-changed.handler.ts`
  - `apps/auth-service/src/modules/authentication/services/security-policy.provider.ts`
  - `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
  - `apps/auth-service/src/modules/authentication/services/mfa.service.ts`
  - `apps/auth-service/src/modules/authentication/authentication.module.ts`
  - `apps/gateway-api/src/config/rate-limit.config.ts`
  - `apps/gateway-api/src/guards/maintenance-mode.guard.ts`
  - `apps/gateway-api/src/app.module.ts`
  - `libs/backend-common/src/rate-limit/rate-limit.guard.ts`
  - `web/modules/admin-panel/src/services/api/platform-configuration.ts`
  - `tests/invariants/platform-config-consumers.spec.ts`
  - `e2e/tests/integration/nats-invariants.spec.ts`
  - `apps/config-service/src/configuration/handlers/__tests__/config-runtime-nats.handler.spec.ts`
- **Proof of fix:** New invariant spec tests/invariants/platform-config-consumers.spec.ts: (a) every key emitted by the admin-panel write builders (buildGeneralWrites/buildEmailWrites/buildSecurityWrites/buildRateLimitWrites) and every key seeded by 1805400000000-SeedPlatformConfigurations.ts exists in the config-runtime contract registry, and (b) every registry key appears in CONFIG_RUNTIME_NONSECRET_ALLOWLIST or CONFIG_RUNTIME_SECRET_ALLOWLIST under at least one consumer service — this spec fails on today's HEAD (proving it detects the defect) and passes after the fix. Behavior specs per consumer: apps/notification-service/.../email.service.dynamic-config.spec.ts (transporter built from config email.* values, smtp_password via GET_SECRET, env fallback when unreachable, rebuild on ConfigurationChanged email.*); apps/auth-service/.../security-policy.provider.spec.ts (changed security.max_login_attempts takes effect on the next failed-login accounting call, not next boot; PasswordPolicyService enforces dynamic min length above the static floor); apps/gateway-api/.../maintenance-mode.guard.spec.ts (503 for non-SUPER_ADMIN when maintenance.mode_enabled=true, pass-through when unreachable); rate-limit overlay spec asserting a changed rate_limit.global_rpm alters the enforced tier limit within the TTL window. Extend config-runtime-nats.handler.spec.ts for the new caller/key allowlist entries and the existing e2e/tests/integration/nats-invariants.spec.ts cross-check (new allowlist entries require matching services.yaml grants; secret/non-secret maps stay disjoint; per-consumer scoped inbox prefixes present).
- **Effort:** L

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

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** queryAuditLogs declares named @Query('action'|'severity'|...) params AND '@Query() pagination?: PaginationQueryDto'. The global ValidationPipe (whitelist:true, forbidNonWhitelisted:true — libs/backend-common bootstrap, no overrides in admin-api main.ts) validates the ENTIRE req.query object against PaginationQueryDto for the un-named param; any request carrying action/severity/entityType/tenantId/search/startDate/endDate therefore 400s ('property X should not exist'). The unfiltered default load (page,limit) succeeds, so the page looks healthy until a filter is touched, then flips to the error card. In production disableErrorMessages masks the reason entirely.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.controller.ts:42-54 (named filters + @Query() PaginationQueryDto on one handler)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489 (global whitelist+forbidNonWhitelisted pipe)`
  - `apps/admin-api-service/src/main.ts:10-36 (no validationPipeOverrides)`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25 (only page/limit/sortBy/sortOrder whitelisted)`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:290-307 (filters appended to same query string)`
- **Verification:** Confirmed end-to-end. FE (web/modules/admin-panel/src/pages/AuditLogPage.tsx:290-307 + services/api/audit.ts:25) sends action/severity/entityType/tenantId/search/startDate/endDate alongside page/limit in one query string to GET /audit-logs. The handler (apps/admin-api-service/src/audit/audit.controller.ts:42-54) mixes nine named @Query('x') string params (ValidationPipe skips primitive metatypes) with a bare @Query() pagination?: PaginationQueryDto, which receives the ENTIRE req.query and is validated against PaginationQueryDto (only page/limit/sortBy/sortOrder — src/shared/pagination-query.dto.ts). The platform-global pipe (libs/backend-common/src/bootstrap/create-service-app.ts:458-497) sets whitelist:true + forbidNonWhitelisted:true; admin-api main.ts passes no overrides and no APP_PIPE exists in service production code. Therefore every request carrying a filter key 400s ('property X should not exist'), while the filter-less default load succeeds — exactly the reported symptom; in production disableErrorMessages masks the response to a bare Bad Request (server logs do get the field list via the exceptionFactory). Refutation attempts failed: nginx rewrite only maps /api/*→/api/v1/* (path, not query); no alternate audit route; service tests build their own permissive ValidationPipes so the real pipe config is never exercised. The pattern is systemic in admin-api: billing.controller.ts:532-538 (listCustomPlans) and ticket.controller.ts:162-170/231-236/245-249 mix named @Query + bare @Query() DTO identically and 400 on any filter. HIGH stands: a core SUPER_ADMIN security-investigation surface (audit filtering) is fully broken, plus billing custom-plan and support-ticket filtered lists; not CRITICAL because it is availability of admin tooling, not a security or data-integrity breach.
- **Root cause:** The BE link of the chain broke: the endpoint's query-string contract has no single owner. Pagination was extracted into a shared PaginationQueryDto and grafted onto handlers as a bare @Query() param while the handlers' filter keys stayed as ad-hoc named @Query('x') primitives that the ValidationPipe never sees. Under the platform-global whitelist+forbidNonWhitelisted pipe, the bare @Query() DTO is the only class-typed view of req.query, so it implicitly claims the WHOLE query object and every legitimate filter key becomes a forbidden non-whitelisted property. The drift went undetected because (a) nothing at build/test time forbids mixing named @Query with a bare @Query() DTO, and (b) admin-api integration tests instantiate their own permissive ValidationPipes (transform-only or whitelist-only) instead of the production pipe, so forbidNonWhitelisted was never exercised against real filter traffic. Side defect of the same root cause: the named filters bypass validation entirely (severity accepts any string; startDate/endDate become Invalid Date silently).
- **Fix design:** SYSTEMIC CLASS: DTO-whitelist rejection via mixed named-@Query + bare-@Query()-DTO (instances: audit queryAuditLogs; billing listCustomPlans; support getAllTickets/getTicketsForTenant/getAssignedTickets). Fix at pattern level plus local applications.

(1) Tier-1 contract rule — one handler, one query DTO: each affected handler declares its FULL query contract as a single class extending PaginationQueryDto; no named @Query('x') may coexist with a bare @Query(). New apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts: `export class QueryAuditLogsDto extends PaginationQueryDto` with @IsOptional()+@IsString() action/entityType/performedBy/search, @IsOptional()+@IsUUID() entityId/tenantId, @IsOptional()+@IsEnum(AuditSeverity) severity, @IsOptional()+@IsISO8601() startDate/endDate. Controller becomes `queryAuditLogs(@Req() req, @Query() query: QueryAuditLogsDto)` building AuditLogFilter from it (new Date(query.startDate) etc.). This makes the wrong behavior impossible (whitelist now IS the contract) and upgrades the previously unvalidated filters to real validation (enum severity, ISO dates, UUID tenantId). Same application in billing (add ListCustomPlansQueryDto extends PaginationQueryDto — tenantId, @IsEnum status/tier, search — to src/billing/dto/billing.dto.ts) and support (ListTicketsQueryDto with enum status/priority/category + assignedTo/tenantId/search, and a status-only StatusPaginationQueryDto for the tenant/assigned routes; ticket DTOs are colocated in ticket.controller.ts today, so define them beside CreateTicketDto or in a new support dto file). FE needs no change — its param shape already matches the corrected contract; do NOT relax the global pipe or add per-route pipe overrides (that would be a shim).

(2) Tier-3 pattern gate: new architecture spec apps/admin-api-service/src/__tests__/api/query-dto-contract.spec.ts that statically scans apps/admin-api-service/src/**/*.controller.ts and fails any handler whose parameter list contains both @Query('...') and bare @Query() — same static-scan style as the existing tenant-schema-routing architecture spec. This kills the whole defect class in the service, including future handlers.

(3) Tier-2 verification integrity: extract the pipe defaults in configureValidationPipe (libs/backend-common/src/bootstrap/create-service-app.ts:446-498) into an exported createDefaultValidationPipe(isProduction, overrides?) (re-exported from libs/backend-common/src/bootstrap/index.ts) used by bootstrapService itself, so integration tests mount the production-identical pipe instead of hand-mirrored options — mirrored permissive pipes are exactly how this bug escaped tests, and hand-copied pipe config in specs is banned drift.
- **Files to change:**
  - `apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/billing/dto/billing.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `libs/backend-common/src/bootstrap/create-service-app.ts`
  - `libs/backend-common/src/bootstrap/index.ts`
  - `apps/admin-api-service/src/__tests__/api/query-dto-contract.spec.ts`
  - `apps/admin-api-service/src/audit/__tests__/audit.controller.integration.spec.ts`
- **Proof of fix:** Two gates. (a) Regression: new apps/admin-api-service/src/audit/__tests__/audit.controller.integration.spec.ts mounts AuditLogController with the REAL pipe via the newly exported createDefaultValidationPipe(false) and supertest, asserting GET /audit-logs?action=X&severity=CRITICAL&entityType=Tenant&tenantId=<uuid>&search=s&startDate=2026-01-01T00:00:00Z&endDate=2026-02-01T00:00:00Z&page=1&limit=20 returns 200 with the filter forwarded to a mocked AuditLogService.query, GET /audit-logs?severity=NOT_A_SEVERITY returns 400, and GET /audit-logs?bogus=1 returns 400; equivalent filtered-list cases added for billing listCustomPlans and support getAllTickets in their existing controller spec files. (b) Class-wide invariant: new apps/admin-api-service/src/__tests__/api/query-dto-contract.spec.ts statically scans all *.controller.ts under the service and fails any handler mixing @Query('name') with bare @Query() — proves the systemic pattern is eliminated and cannot recur. Both run under nx affected --target=test.
- **Effort:** M

### APA-357 [HIGH] Export always fails (limit=10000 > @Max(100)); even if accepted it would silently truncate to 100 rows

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** handleExport always sends limit=10000; PaginationQueryDto caps limit at @Max(100) so the request 400s and the user gets 'Export failed'. Were the DTO cap removed, AuditLogService.query clamps take to Math.min(limit,100), so a 'full CSV export' would silently contain at most 100 of potentially thousands of records — silent data loss in a compliance export.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:339-374 (limit:'10000')`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:11-16 (@Max(100))`
  - `apps/admin-api-service/src/audit/audit.service.ts:119-120 (take = Math.min(limit,100))`
- **Verification:** Adversarial verification failed to refute; every link is concretely reachable. handleExport (web/modules/admin-panel/src/pages/AuditLogPage.tsx:341) always sends limit='10000' to GET /audit-logs. admin-api-service boots via bootstrapService with no validationPipeOverrides and no APP_PIPE, so the platform-default global ValidationPipe applies (libs/backend-common/src/bootstrap/create-service-app.ts:458-489: whitelist:true, forbidNonWhitelisted:true, transform:true). @Query() pagination?: PaginationQueryDto is validated: @Type(() => Number) converts '10000' to 10000 and @Max(100) (apps/admin-api-service/src/shared/pagination-query.dto.ts:15) rejects it -> 400 BadRequestException (bare 'Bad Request' in prod due to disableErrorMessages). apiFetch throws on 4xx without retry (web/modules/admin-panel/src/services/http-client.ts:309-311) -> setExportError('Export failed: ...') (AuditLogPage.tsx:372). The normal list fetch uses limit=20 (AuditLogPage.tsx:274) so only export trips the cap. Second half also confirmed: apps/admin-api-service/src/audit/audit.service.ts:120 clamps take = Math.min(limit, 100), so lifting the DTO cap alone would produce a silently truncated 100-row 'full' compliance export. Verification additionally surfaced an aggravating co-defect in the same route: because the controller mixes @Query('action') etc. with @Query() PaginationQueryDto, forbidNonWhitelisted validates the FULL query object against PaginationQueryDto and 400s ANY filtered request ('property action should not exist') — a filtered export fails for two independent reasons, and filtered list queries on this endpoint are broken too (systemic 'DTO-whitelist rejection' class, also present in support/controllers/ticket.controller.ts and billing/billing.controller.ts). HIGH stands: a compliance export on the SUPER_ADMIN surface is completely non-functional, and the layered clamp turns the naive fix (raise @Max) into silent data loss.
- **Root cause:** The FE->BE contract link broke because no export contract exists at all: the FE fakes 'full export' by driving the bounded paginated LIST endpoint with an out-of-contract limit (10000), while the BE enforces the bounded-page contract twice independently (DTO @Max(100) and service-side Math.min(limit,100)). FE api params (services/api/audit.ts) and BE DTOs (shared/pagination-query.dto.ts) are hand-written with no shared source and no contract test exercising the FE's actual request shapes against the BE validation pipe, so the FE encoded an assumption (unbounded limit) the BE structurally forbids and nothing detected it at build/test time. It is an instance of two declared systemic classes: FE-type drift (hand-written params vs hand-written DTO) and DTO-whitelist rejection (the same controller's mixed @Query('x') + @Query() PaginationQueryDto pattern makes forbidNonWhitelisted 400 every filtered query on this route).
- **Fix design:** Tier-1 fix: make an over-limit export structurally inexpressible by giving export its own contract instead of a giant page fetch. (1) BE: add GET /audit-logs/export on AuditLogController taking a new AuditLogFilterQueryDto (action, entityType, entityId, tenantId, performedBy, severity, startDate, endDate, search — all class-validator-decorated; NO page/limit fields, so no limit can be sent, satisfied trivially by whitelist). It returns a streamed text/csv StreamableFile with Content-Disposition; ResponseInterceptor gets an instanceof-StreamableFile early-return (today it only skips by URL prefix and would JSON-wrap the CSV). (2) AuditLogService gains streamAll(filter): AsyncIterable<AuditLog> using keyset pagination (createdAt,id cursor, internal batches of ~1000) so the FULL filtered set streams without unbounded memory; query()'s Math.min clamp stays — it is the correct bounded LIST contract. CSV serialization moves server-side (proper quoting + spreadsheet formula-injection guard for =,+,-,@ — this is a compliance artifact). The export emits the existing DATA_EXPORT audit action (determineSeverity already classifies it CRITICAL) plus writeMetaAudit('EXPORT', filter), closing the gap where a bulk audit read left no trail. (3) Same-file systemic-class fix: collapse the mixed @Query('x') + @Query() PaginationQueryDto binding in queryAuditLogs into a single AuditLogQueryDto extends PaginationQueryDto (filter fields + pagination in one validated DTO), which also un-breaks filtered list queries under forbidNonWhitelisted; this single-DTO-per-query-surface pattern is the template for the sibling occurrences in ticket.controller.ts and billing.controller.ts (their own findings). (4) FE: add an apiFetchBlob/apiDownload helper in http-client.ts for non-envelope binary responses (apiFetch assumes the JSON envelope); auditApi.export(filters) calls /audit-logs/export and its parameter type contains no limit field; handleExport downloads the streamed blob and the client-side CSV assembly plus limit:'10000' are deleted. Result: the wrong behavior (partial or over-limit export) cannot be expressed by either side's types, and correct behavior (full filtered export, audit-trailed) is the zero-effort default.
- **Files to change:**
  - `apps/admin-api-service/src/audit/dto/audit-log-query.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `apps/admin-api-service/src/shared/response.interceptor.ts`
  - `web/modules/admin-panel/src/services/http-client.ts`
  - `web/modules/admin-panel/src/services/api/audit.ts`
  - `web/modules/admin-panel/src/services/types/audit.ts`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx`
  - `apps/admin-api-service/src/audit/__tests__/audit-export.spec.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Proof of fix:** New integration spec apps/admin-api-service/src/audit/__tests__/audit-export.spec.ts (supertest against a Nest app built with the same createServiceApp ValidationPipe defaults) asserting: (a) with 250 seeded audit rows, GET /audit-logs/export streams a CSV containing all 250 data rows (kills the 100-row clamp truncation class — the exact silent-loss mode the finding predicts); (b) export response is raw text/csv with Content-Disposition, NOT the {success,data,meta} envelope (proves the ResponseInterceptor StreamableFile skip); (c) GET /audit-logs?limit=10000 still returns 400 (the bounded LIST contract is preserved, not loosened); (d) GET /audit-logs?action=X&page=1&limit=20 returns 200 (kills the forbidNonWhitelisted rejection on filtered queries via the unified AuditLogQueryDto); (e) a successful export writes a DATA_EXPORT audit entry. Extend apps/admin-api-service/src/__tests__/contract-validation.spec.ts so the FE's new /audit-logs/export call maps to a real backend route, keeping the FE-route-with-no-backend gate green.
- **Effort:** M

### APA-358 [MEDIUM] Severity vocabulary drift: FE uses low/medium/high/critical, backend enum is info/warning/critical

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** The FE AuditLog type and the severity filter dropdown use 'low'|'medium'|'high'|'critical'; the DB enum is 'info'|'warning'|'critical' (admin.audit_logs_severity_enum). Three of four filter options could never match a row (independent of the 400 issue), and rows with severity 'info'/'warning' render with the fallback gray badge instead of their intended styling. Only the 'Critical Events' stat card happens to align.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/audit.ts:13`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:69-75,120-128`
  - `apps/admin-api-service/src/audit/audit.entity.ts:54-58`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:7`
- **Verification:** Verified in source: FE audit type (services/types/audit.ts:13), dropdown (AuditLogPage.tsx:69-75) and badge map (:120-128) use 'low|medium|high|critical'; backend entity enum (audit.entity.ts:54-58) and DB enum (Baseline.ts:7, admin.audit_logs_severity_enum) are 'info|warning|critical', and determineSeverity() only ever writes those three. Concretely reachable with zero filters: the default list request (page+limit only, whitelisted in PaginationQueryDto) loads rows whose 'info'/'warning' severities fall through the badge map to the gray fallback — only 'critical' styles correctly, and only the Critical Events stat card aligns (service getStatistics returns 'critical'). The filter side is real independent of the companion forbidNonWhitelisted-400 finding: with a bare unvalidated @Query('severity') (controller:50), severity=low reaches Postgres as an invalid enum cast, which audit.service.query()'s catch (:199-211) swallows into {data:[], total:0} — silent false negatives on a compliance surface. No transform layer rescues it (http-client only unwraps the envelope). The FE even carries the CORRECT union twice already (services/types/security.ts:38, security/AuditTrailPage.tsx:34) — three competing vocabularies, no SSoT. Downgraded from HIGH to MEDIUM: internal SUPER_ADMIN surface, no security boundary crossed or data loss; today the filter fails loudly with a 400 banner, and mis-styled badges still display the severity text. Still MEDIUM (not LOW) because the post-i1-fix path yields silently empty results for 3 of 4 filter options during incident/compliance review.
- **Root cause:** FE→BE contract link broke: the admin-panel hand-writes its API types with no shared contract or drift gate against admin-api-service, and the author of services/types/audit.ts invented a generic 4-level severity scale instead of mirroring the backend AuditSeverity enum — even though the same FE module already holds the correct 'info|warning|critical' union in services/types/security.ts:38 and a third private copy in security/AuditTrailPage.tsx:34. Systemic class: hand-written-FE-type drift (three vocabulary definitions, no SSoT). The backend co-contributes: audit.controller.ts:50 types the query param as AuditSeverity but never validates it (compile-time lie; runtime accepts any string), and audit.service.query()'s blanket catch masks the resulting Postgres enum-cast error as an empty result set.
- **Fix design:** Pattern-level (systemic FE-type-drift class) plus local application. (1) Tier 1/2 FE: make services/types/audit.ts the value-level SSoT — export const AUDIT_SEVERITIES = ['info','warning','critical'] as const; export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number]; type AuditLog.severity with it. Consolidate the duplicates: services/types/security.ts imports/re-exports this type (barrel already exports both files — keep exactly one definition), and security/AuditTrailPage.tsx drops its private copy. (2) Tier 1 rendering: in AuditLogPage.tsx derive SEVERITY_LEVELS options from AUDIT_SEVERITIES and replace getSeverityBadgeVariant's string-keyed map + fallback with an exhaustive Record<AuditSeverity, BadgeVariant> = { info:'info', warning:'warning', critical:'error' } — a new enum member without a badge becomes a tsc error; no defensive fallback. (3) Tier 1 backend boundary (coordinated with the companion forbidNonWhitelisted-400 finding on the same endpoint — one DTO fixes both): new apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts extending PaginationQueryDto with the filter fields incl. @IsOptional() @IsEnum(AuditSeverity) severity?: AuditSeverity; audit.controller.queryAuditLogs takes the single DTO, eliminating the unvalidated bare @Query('severity') and closing the swallowed-enum-cast → fake-empty-result path. (4) Tier 3 cross-boundary gate: new invariant spec tests/invariants/admin-audit-severity-contract.spec.ts (repo already uses tests/invariants for cross-boundary checks) asserting set-equality of Object.values(backend AuditSeverity), FE AUDIT_SEVERITIES, and the ENUM literal parsed from the Baseline migration's CREATE TYPE "admin"."audit_logs_severity_enum" statement — any future drift on any of the three sides fails CI. No FE compat mapping layer, no allowlisting: the vocabulary is fixed at the source on both sides.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/audit.ts`
  - `web/modules/admin-panel/src/services/types/security.ts`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx`
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx`
  - `apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `tests/invariants/admin-audit-severity-contract.spec.ts`
- **Proof of fix:** New tests/invariants/admin-audit-severity-contract.spec.ts: asserts Object.values(AuditSeverity) from apps/admin-api-service/src/audit/audit.entity.ts, AUDIT_SEVERITIES from web/modules/admin-panel/src/services/types/audit.ts, and the ENUM values parsed from migrations/1800000000000-Baseline.ts's CREATE TYPE statement are set-equal — fails on any future drift. Extend the audit controller spec (apps/admin-api-service/src/audit/__tests__/) with the new DTO: GET /audit-logs?severity=low returns 400; severity=warning passes the value through to AuditLogService.query. Compile-time proof via npm run type-check: the exhaustive Record<AuditSeverity, BadgeVariant> in AuditLogPage.tsx errors if a severity lacks a badge mapping, and the dropdown derives from AUDIT_SEVERITIES so a stale option cannot exist.
- **Effort:** M

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
