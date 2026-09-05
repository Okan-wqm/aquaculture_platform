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

# Settings / Email Templates / IP Rules / Audit Log — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the
> verified severity where status is CONFIRMED, else the auditor's grade pending verification.

## SystemSettingsPage.tsx — `/admin/settings` — verdict: **PARTIAL**

**Chain:** Reads/writes go through federated GraphQL (shell nginx /graphql -> gateway ->
config-service subgraph, resolver ConfigurationResolver, table config.configurations) — this chain
is real and persists. Two legacy REST endpoints remain: GET /api/settings/system/info and POST
/api/settings/config/email/test (nginx rewrites /api/_ -> /api/v1/_ on admin-api-service; both
routes exist and are guarded). HOWEVER: everything the page saves except the Billing tab is
functionally inert — SystemSettingService reads only env vars, EmailSenderService sends with env-var
SMTP config, and no runtime service (auth, gateway, notification) consumes the email._, security._,
rate*limit.* or maintenance.\_ keys from config-service. Only
billing.stripe_enabled/billing.stripe_secret_key are consumed at runtime (billing-service
ConfigClientModule + DynamicStripeClientProvider).

**Endpoints exercised:**
`POST /graphql effectiveConfigurationsByService(service:"platform") -> config-service`;
`POST /graphql setConfiguration(...) -> config-service`; `GET /api/v1/settings/system/info`;
`POST /api/v1/settings/config/email/test`

**DB tables:** `config.configurations`, `config configuration_history (via setConfiguration reason)`

### APA-340 [HIGH] Email, Security, Rate-Limit and Maintenance settings persist but nothing enforces or consumes them (false configuration)

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** The page saves email.smtp\__, security._ (password policy, MFA, lockout),
  rate*limit.* and maintenance.mode*enabled to config.configurations, but no runtime service reads
  these keys. Repo-wide grep for the keys (security.max_login_attempts,
  security.password_min_length, maintenance.mode_enabled, rate_limit.global_rpm) matches only the
  config-service seed migration, tests, and the admin FE mapper. auth-service, gateway-api and
  notification-service do not import ConfigClientModule (only billing-service does, for billing.*
  keys). A SUPER_ADMIN who tightens the password policy, enables maintenance mode, or changes SMTP
  credentials sees 'saved' but the platform behavior does not change — false security. Only the
  Billing tab (stripe_enabled/stripe_secret_key) has a real runtime consumer.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/platform-configuration.ts:294-354 (write builders for email/security/rate-limit/maintenance keys)`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:160-183,200-280 (all runtime reads are process.env, updates throw 410 Gone)`
  - `apps/billing-service/src/billing/billing.module.ts:9,95-98 (only ConfigClientModule consumer, billing.* keys only)`
  - `libs/backend-common/src/billing/dynamic-stripe-client.provider.ts:55-57,192 (consumes billing.stripe_enabled / billing.stripe_secret_key)`
  - `grep of security.max_login_attempts|maintenance.mode_enabled|rate_limit.global_rpm across repo: matches only apps/config-service/src/database/migrations/1805400000000-SeedPlatformConfigurations.ts, tests, and the FE mapper — no runtime consumer`
- **Verification:** Verified end-to-end. FE writes are real: usePlatformConfiguration.ts -> gateway
  federated GraphQL -> config-service setConfiguration persists
  email._/security._/rate*limit.*/maintenance._ rows with history, and re-reads render the saved
  values (permanent false state). But the trusted read path is structurally billing-only:
  CONFIG_RUNTIME_SECRET_ALLOWLIST and CONFIG_RUNTIME_NONSECRET_ALLOWLIST
  (libs/event-contracts/src/config-runtime.ts:85-96) list only billing-service with only
  billing.stripe_\_ keys, and grep confirms ConfigClientModule is imported solely by
  apps/billing-service/src/billing/billing.module.ts:102. Per-domain refutation failed everywhere:
  notification-service builds its SMTP transporter from SMTP\__ env (email.service.ts:135-145);
  auth-service lockout is constructor-frozen env config (authentication.service.ts:73,135,1295),
  password policy is a hard-coded PASSWORD*POLICY_REGEX constant + static @MinLength(8), MFA
  constants are in mfa.service.ts:53-56; gateway-api rate tiers come from RATE_LIMIT*_ env
  (rate-limit.config.ts:34-54); zero matches for "maintenance" in apps/gateway-api/src. admin-api's
  SystemSettingService is a read-only env adapter whose writes throw 410 Gone and whose computed
  values nothing enforces. ConfigurationChanged events are consumed only by billing (filters
  billing.\_). Downgraded to HIGH: not directly exploitable and the enforced posture stays at
  env/constant defaults (the real password regex is stricter than the phantom config), but a
  SUPER_ADMIN gets false assurance that maintenance mode, lockout policy, MFA policy, rate limits,
  and SMTP changes are live — a false-configuration defect across 4 of 5 settings tabs. This is an
  instance of the systemic "config-table-nobody-reads" class.
- **Root cause:** The broken link is store->runtime consumption, and it drifted because the
  ORPHAN-HIGH-373 remediation migrated only the WRITE plane: the admin Settings page was rewired
  from the retired admin-api system*settings store to config-service, and the platform seeded all
  five tabs' keys (1805400000000-SeedPlatformConfigurations.ts) so the page renders — while the full
  runtime-consumption spine that was built alongside it (ConfigRuntimeClient signed NATS
  request-reply, per-caller allowlists, ConfigurationChanged invalidation,
  DynamicStripeClientProvider) was instantiated for exactly one key family, billing.stripe*\*. The
  owning runtime services (notification-service SMTP, auth-service lockout/password/MFA policy,
  gateway-api rate tiers and maintenance) kept their pre-existing env/constant configuration, and no
  build-time invariant requires that every operator-writable platform key have a registered runtime
  consumer, so the write plane and the enforcement plane diverged silently. The contract itself
  encodes the gap: CONFIG_RUNTIME_KEYS lists only the three Stripe keys.
- **Fix design:** Pattern-level fix for the config-table-nobody-reads class, applied locally to all
  four dead key families, reusing the proven billing spine. (1) CONTRACT AS SSoT (tier 1): extend
  libs/event-contracts/src/config-runtime.ts into a platform-key registry — grow CONFIG*RUNTIME_KEYS
  with the email.*, security._, rate_limit._, maintenance._ vocabulary and extend the two allowlists
  per owning consumer: notification-service gets non-secret
  email.smtp_host/port/secure/username/from_address/from_name plus SECRET email.smtp_password;
  auth-service gets the nine security._ keys; gateway-api gets the four rate*limit.* keys plus
  maintenance.mode*enabled. Add matching config.runtime.get (and for notification, get_secret)
  publish grants in infrastructure/nats/services.yaml with a per-consumer scoped reply-inbox prefix
  for the secret path (same SEC-CRITICAL-001 design as \_INBOXBILLINGCFG — generalize the prefix per
  consumer service rather than widening the billing inbox), then regenerate nats.conf via
  scripts/nats/generate-nats-conf.py in the same commit. The existing nats-invariant cross-check
  (allowlist entry MUST have a matching services.yaml grant, secret/non-secret maps disjoint) makes
  an inconsistent extension fail CI automatically. (2) CONSUMPTION AUTOMATIC (tier 2): each owning
  service imports ConfigClientModule.forRoot({consumerService}) and adopts the
  DynamicStripeClientProvider pattern — TTL-cached snapshot, config-over-env precedence with env
  fallback on unreachable, ConfigurationChanged handler filtering its own key prefix for instant
  invalidation, warm-loss preservation for live SMTP. Concretely: notification-service replaces the
  boot-time env transporter in email.service.ts with a dynamic transport provider resolving email.*
  (secret via GET*SECRET); auth-service introduces a SecurityPolicyProvider read at call time by
  authentication.service (lockout threshold/duration move from constructor-frozen fields to per-call
  resolution in the failed-attempt accounting) and a PasswordPolicyService.assertCompliant()
  enforced in the service layer of change/reset/invite flows — the static DTO regex remains the
  structural floor, dynamic policy tightens above it; mfa_enabled gates the enforcement decision
  where evaluated; gateway-api overlays config rate_limit.* values on the env-built
  RateLimitEdgeConfig tiers via the same TTL provider inside the shared RateLimitGuard resolution,
  and adds a MaintenanceModeGuard at the gateway edge returning 503 for non-SUPER_ADMIN traffic when
  maintenance.mode_enabled=true (fail-open to not-in-maintenance on unreachable, mirroring the
  reachability discipline). (3) DRIFT DETECTABLE (tier 3): new invariant
  tests/invariants/platform-config-consumers.spec.ts asserts (a) every key produced by the admin FE
  write builders and every seeded platform key appears in the contract registry, and (b) every
  registry key is claimed by at least one consumer in the allowlists — so a future settings tab
  whose keys nobody reads fails CI at introduction. The FE mapper's key vocabulary is asserted equal
  to the contract registry by that same spec (the admin panel deliberately hand-writes FE types, so
  the equality invariant is the boundary gate). No defensive fallbacks hiding absence: a registry
  key with no consumer is a build failure, not a runtime default.
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
- **Proof of fix:** New invariant spec tests/invariants/platform-config-consumers.spec.ts: (a) every
  key emitted by the admin-panel write builders
  (buildGeneralWrites/buildEmailWrites/buildSecurityWrites/buildRateLimitWrites) and every key
  seeded by 1805400000000-SeedPlatformConfigurations.ts exists in the config-runtime contract
  registry, and (b) every registry key appears in CONFIG*RUNTIME_NONSECRET_ALLOWLIST or
  CONFIG_RUNTIME_SECRET_ALLOWLIST under at least one consumer service — this spec fails on today's
  HEAD (proving it detects the defect) and passes after the fix. Behavior specs per consumer:
  apps/notification-service/.../email.service.dynamic-config.spec.ts (transporter built from config
  email.* values, smtp*password via GET_SECRET, env fallback when unreachable, rebuild on
  ConfigurationChanged email.*); apps/auth-service/.../security-policy.provider.spec.ts (changed
  security.max_login_attempts takes effect on the next failed-login accounting call, not next boot;
  PasswordPolicyService enforces dynamic min length above the static floor);
  apps/gateway-api/.../maintenance-mode.guard.spec.ts (503 for non-SUPER_ADMIN when
  maintenance.mode_enabled=true, pass-through when unreachable); rate-limit overlay spec asserting a
  changed rate_limit.global_rpm alters the enforced tier limit within the TTL window. Extend
  config-runtime-nats.handler.spec.ts for the new caller/key allowlist entries and the existing
  e2e/tests/integration/nats-invariants.spec.ts cross-check (new allowlist entries require matching
  services.yaml grants; secret/non-secret maps stay disjoint; per-consumer scoped inbox prefixes
  present).
- **Effort:** L

### APA-341 [HIGH] 'Send Test' tests the env-var SMTP config, not the settings the admin typed or saved

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The Send Test button posts {to} to /settings/config/email/test. The handler calls
  EmailSenderService.testConnection()/sendEmail(), which builds its transporter from
  SystemSettingService.getEmailConfigForSending() — pure process.env
  SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD reads. The SMTP values in the form (persisted to
  config-service) are never used by the test, so a green 'SMTP test email sent' does not validate
  what was saved, and a failing test can contradict correct saved settings. The edited form values
  are not even sent in the request body.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:560-575 (handleTestEmail sends only fromAddress as 'to')`
  - `apps/admin-api-service/src/settings/settings.controller.ts:206-233 (test uses EmailSenderService only)`
  - `apps/admin-api-service/src/settings/services/email-sender.service.ts:122-160 (transporter from getEmailConfigForSending)`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:172-183,343-358 (env-var only source)`
- **Verification:** Confirmed against real wiring. FE handleTestEmail (SystemSettingsPage.tsx:565)
  calls settingsApi.testEmailConfig(emailConfig.fromAddress), which POSTs body {to: fromAddress} to
  /settings/config/email/test (services/api/settings.ts:43-47) — none of the edited SMTP
  host/port/user/password fields are in the body. The BE handler (settings.controller.ts:206-233)
  ignores everything except dto.to and drives EmailSenderService.testConnection()+sendEmail(). Both
  build the nodemailer transporter via initializeTransporter() ->
  settingsService.getEmailConfigForSending() (email-sender.service.ts:124,239), which is a pure
  process.env reader (system-setting.service.ts:172-183,343-358:
  SMTP*HOST/PORT/SECURE/USER/PASSWORD). Meanwhile the form persists to config-service:
  handleSaveEmail -> buildEmailWrites (platform-configuration.ts:294-313) emits email.smtp*\* keys
  -> useSavePlatformSettings -> federated GraphQL setConfiguration (page header comment lines 6-12,
  ORPHAN-HIGH-373). So the two stores are disconnected: the test validates admin-api's env-var SMTP,
  never the operator-typed/saved config-service SMTP. Two concretely reachable failure modes: (a)
  operator saves correct SMTP to config-service but admin-api env is empty -> red 'SMTP not
  configured' contradicts a correct save; (b) admin-api env has working SMTP while operator saves
  garbage -> green 'SMTP test email sent' falsely certifies broken config. grep confirms
  EmailSenderService.sendEmail is invoked ONLY by this test endpoint in admin-api (health.service.ts
  only reads circuit status), so nothing in admin-api ever consumes the config-service email
  settings. HIGH is defensible (arguably MEDIUM in strict isolation as a misleading diagnostic with
  no data/security impact), but the symptom exposes a HIGH systemic root — the entire email-settings
  tab is disconnected from admin-api's actual send path — and false certification of an untested
  SMTP config on a support-critical channel warrants HIGH.
- **Root cause:** The config-service migration (ORPHAN-HIGH-373) re-pointed the email settings FORM
  at config-service (GraphQL setConfiguration / effectiveConfigurations) and retired the admin-api
  write path (410 Gone) plus the read stubs, but never re-pointed admin-api's email SENDER at
  config-service. SystemSettingService.getEmailConfig()/getEmailConfigForSending() remained a legacy
  env-var-only adapter (process.env.SMTP\_\*), and EmailSenderService (used by both the test
  endpoint and any real send) still sources SMTP from it. Result: operator-managed config-service
  SMTP values drive nothing in admin-api, and the Send Test — the one live REST diagnostic left on
  the page — validates process.env, a different store than the form reads/writes. The FE compounds
  it by sending only fromAddress as the recipient, omitting the edited SMTP fields entirely.
- **Fix design:** Instance of the systemic 'config-service settings that admin-api never reads'
  class; fix at the SSoT source, not by patching the button. Pattern-level fix: make admin-api's
  email pipeline source SMTP from config-service effective configuration — the same SSoT the form
  writes — with process.env only as a bootstrap fallback. Concretely,
  SystemSettingService.getEmailConfig()/getEmailConfigForSending() must resolve email.smtp\_\* from
  config-service effective config (via a server-side effective-config consumer in admin-api,
  mirroring the FE effectiveConfigurationsByService read), returning a resolved EmailSendConfig.
  EmailSenderService.initializeTransporter() then builds the transporter from operator-saved values,
  so testConnection()/sendEmail() AND the real send path validate/use exactly what was saved
  (hierarchy tier 2: correct behavior becomes automatic via a single SSoT). getEmailConfigForSending
  becomes async; thread the awaited config through initializeTransporter (cache by config-hash as
  today) — sendEmail is already async. The test endpoint resolves config server-side; FE
  handleTestEmail sends only the recipient (no secrets in the body). The detailed per-key/DTO wiring
  and the config-service client contract are carried by the other per-instance findings in section
  settings-email-audit; this entry names the umbrella re-pointing.
- **Files to change:**
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts`
  - `apps/admin-api-service/src/settings/services/email-sender.service.ts`
  - `apps/admin-api-service/src/settings/settings.controller.ts`
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx`
- **Proof of fix:** Add
  apps/admin-api-service/src/settings/**tests**/reliability/email-config-source.spec.ts (or extend
  email-circuit-breaker.spec.ts) that mocks the config-service effective-config client and asserts
  EmailSenderService.initializeTransporter() builds the nodemailer transport host/port/user from
  config-service email.smtp\_\* values, and that setting process.env.SMTP_HOST to a different host
  does NOT change the transporter — proving env is not the source. Add an integration test on POST
  /settings/config/email/test asserting the transporter host equals the config-service-persisted
  value. FE: extend
  web/modules/admin-panel/src/services/api/**tests**/platform-configuration.spec.ts / a
  SystemSettingsPage test asserting handleTestEmail posts only the recipient and that the tested
  config equals the saved form config.
- **Effort:** L

### APA-342 [MEDIUM] System Info tab contract drift — server/database sections never render, returned data not displayed

- **Status:** DESIGNED (brief)
- **Symptom:** FE SystemInfo type expects {platform, server, database}; backend GET
  /settings/system/info returns {platform:{name,version}, security, rateLimits, maintenance}. The
  tab therefore renders only a two-field Platform card; the 'Server Information' and 'Database
  Information' cards are permanently absent, and the security/rateLimits/maintenance payload the
  backend does return is silently discarded. platform name/version are also hardcoded strings, not
  live values.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:41-45,438-474 (SystemInfo type + conditional cards)`
  - `apps/admin-api-service/src/settings/settings.controller.ts:389-409 (actual response shape, hardcoded name/version)`
- **Root cause:** The hand-written FE `SystemInfo` type (SystemSettingsPage.tsx:41-45) declares
  `{platform?, server?, database?}`, but `GET /settings/system/info`
  (settings.controller.ts:389-409) returns
  `{platform:{name,version}, security, rateLimits, maintenance}`. SystemInfoTab only renders
  sections keyed `platform/server/database`, so it shows a 2-field Platform card, never renders
  Server/Database (backend never sends them), and silently drops the security/rateLimits/maintenance
  payload the backend does send. platform name/version are hardcoded literals ('Aquaculture
  Platform'/'1.0.0') in the controller, not live values. Instance of the systemic FE-type-drift
  class: hand-authored FE response types with no shared contract or response-shape gate against the
  backend DTO.
- **Fix design:** Bind both sides to ONE response contract. Define an exported `SystemInfoResponse`
  DTO in the backend (dto/system-info.dto.ts) and set the controller return type to it. Decide the
  real shape by the endpoint's purpose ('System Info' panel): populate `platform` (name from a
  shared version/app-name constant + build env, version from package version — not literals),
  `server` (process.version, uptime, memory via os/process), and `database` (name + pool/liveness
  via injected DataSource). Drop security/rateLimits/maintenance from THIS endpoint — they already
  have dedicated Security/RateLimit tabs and belong to config-service, so returning them here is
  redundant. Mirror the exact shape in the FE `SystemInfo` type and type `getSystemInfo()` to it
  instead of `Record<string,unknown>`. Tier-3 gate: extend contract-validation.spec (or add
  settings-system-info.contract.spec.ts) to assert the response keys equal the FE `SystemInfo` keys
  so future drift fails CI.
- **Files to change:**
  - `apps/admin-api-service/src/settings/settings.controller.ts`
  - `apps/admin-api-service/src/settings/dto/system-info.dto.ts`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts`
  - `web/modules/admin-panel/src/pages/SystemSettingsPage.tsx`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Effort:** M

### APA-343 [LOW] Retired settings endpoints still exposed and return 410 at runtime

- **Status:** DESIGNED (brief)
- **Symptom:** SettingsController still mounts PUT /settings/key/:key, PUT /settings/bulk, PUT
  /settings/config/email|security|rate-limits|maintenance|billing and POST /settings/import — all of
  which unconditionally throw GoneException from SystemSettingService. Dead guarded surface; any
  stale client gets 410s.
- **Evidence:**
  - `apps/admin-api-service/src/settings/settings.controller.ts:140-177,195-204,249-283,297-334,371-380`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:121-142,418-421`
- **Root cause:** SettingsController still mounts the full write surface — PUT key/:key, POST
  key/:key/reset, PUT bulk, PUT config/email|security|rate-limits|maintenance|billing, POST import
  (settings.controller.ts:140-380) — but each delegates to a SystemSettingService method that
  unconditionally calls `throwLegacyGone()` → GoneException 410
  (system-setting.service.ts:121-142,418-421). The config-service migration retired the write PATH
  at the service layer but left the routes, DTOs, throttle decorators, and `never`-returning stubs
  mounted. Dead guarded surface: any input returns 410, and the routes/DTOs must be maintained
  forever.
- **Fix design:** Retire the endpoints, not just their bodies (hierarchy tier 1 — a removed route
  404s, which is the correct semantics for something that no longer exists; a hand-maintained 410
  stub is exactly the compat-shim CLAUDE.md bans). Delete the 9 write handlers from
  SettingsController, delete the matching `never` stub methods +
  `throwLegacyGone`/`LEGACY_CONFIG_STORE_GONE` from SystemSettingService (keep the GET config
  getters — getSystemInfo consumes them internally), and delete the now-unused write DTOs
  (BulkUpdateSettingsDto, UpdateEmailConfigDto, SetMaintenanceModeDto, UpdateBillingConfigDto,
  ImportSettingsDto, and the inline UpdateSecurityConfigDto/UpdateRateLimitConfigDto). Keep only the
  live surface: reads, system/info, config/email/test. Update contract-validation.spec / any route
  inventory to drop these paths. Verification: a route-inventory test asserting the removed paths
  are absent (404, not 410).
- **Files to change:**
  - `apps/admin-api-service/src/settings/settings.controller.ts`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts`
  - `apps/admin-api-service/src/settings/dto/settings.dto.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Effort:** S

## EmailTemplatesPage.tsx — `/admin/settings/email` — verdict: **PARTIAL**

**Chain:** List/edit/toggle/delete chain is real: FE /settings/email-templates* -> nginx ->
/api/v1/settings/email-templates* -> EmailTemplateController -> EmailTemplateService -> TypeORM
repository on admin.email_templates (entity declares schema 'admin'; table + columns created in
Baseline migration 1800000000000, defaults seeded at module init). BUT the templates are an orphaned
store: no email send path in the platform reads them — notification-service EmailService uses
hardcoded inline HTML templates and env SMTP; EmailTemplateService is imported only inside
admin-api's settings module; the backend template test-send endpoint is an explicit stub.
Additionally the 'New Template' UI flow cannot create anything (state initialized null, all inputs
no-op).

**Endpoints exercised:** `GET /api/v1/settings/email-templates`;
`POST /api/v1/settings/email-templates`; `PUT /api/v1/settings/email-templates/:id`;
`DELETE /api/v1/settings/email-templates/:id`;
`GET /api/v1/settings/email-templates/:id/preview (FE fn exists, page previews client-side)`;
`POST /api/v1/settings/email-templates/:id/test (FE fn exists, no UI button; backend stub)`

**DB tables:** `admin.email_templates`

### APA-344 [HIGH] Email templates are never consumed by any real send path — edits have zero effect on emails actually sent

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** Every real email the platform sends (welcome/invitation, alerts, regulatory reports)
  is generated by notification-service EmailService from hardcoded inline template strings with
  env-var SMTP config; it never queries admin.email_templates. EmailTemplateService
  (render/getTemplateByCode) is referenced only inside admin-api's own settings module, whose sole
  'send' consumer is the stubbed test endpoint. An admin editing the 'Welcome Email' or 'Password
  Reset' template — including deactivating a template — changes nothing in production email, while
  the UI reports 'Template saved successfully'. This is exactly the silent-wrong-data scenario the
  audit was asked to check.
- **Evidence:**
  - `apps/notification-service/src/notification/services/email.service.ts:224-306,311-391,506-643 (hardcoded generate*Template methods; no repository/template read)`
  - `apps/notification-service/src/notification/services/email.service.ts:134-160 (env-var SMTP transporter)`
  - `grep EmailTemplateService across apps/: only apps/admin-api-service/src/settings/* match`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:162-181 (only send-adjacent consumer is the stub)`
- **Verification:** Confirmed and concretely reachable. admin.email_templates is written/read only
  within admin-api's own settings module (email-template.service.ts / email-template.controller.ts,
  entity in settings/entities/system-setting.entity.ts, seeded in
  migrations/1800000000000-Baseline.ts) and surfaced by the admin FE
  (services/api/email-templates.ts). The ONLY real email send path is notification-service
  EmailService, whose bodies come from hardcoded generate\*Template methods (welcome L224-306, alert
  L311-391, regulatory L506-782) over env-var SMTP (L134-160), invoked by auth-event.handler.ts:433
  (UserInvited welcome), regulatory-report.handler.ts:118/136/154, and
  notification-dispatcher.service.ts:862 (alert). notification-command.handler.ts:265 renderTemplate
  is a separate hardcoded switch (messaging/HR), also not backed by the table. No NATS
  TemplateUpdated event exists in libs/event-contracts, no signed-HTTP call from
  notification-service to admin's template API, and the controller :id/test endpoint (L162-181) is
  an explicit stub. Refutation attempts (alternate consumer, event bridge, HTTP proxy, later
  migration) all fail. Editing or deactivating a template therefore changes nothing about production
  email while the UI reports 'Template saved successfully'. Downgraded CRITICAL->HIGH: whole-feature
  silent-wrong-data / false-success integrity defect, but no security/safety/data-loss/cross-tenant
  impact and emails still send with hardcoded content. Instance of the systemic
  config-table-nobody-reads / silent-wrong-data class.
- **Root cause:** The BE->send link is missing entirely. Template AUTHORING (admin-api bounded
  context, admin.email_templates) and template RENDERING/SENDING (notification-service bounded
  context, EmailService) were built independently with no contract between them:
  notification-service has no dependency on the admin template store and instead inlines HTML in
  generate\*Template. The FE->admin-api->admin.email_templates chain is intact but terminates in a
  store the sole send runtime never consults. It drifted because two bounded contexts each modeled
  'the email template' locally and nothing structurally forces the send path to resolve templates
  from the authored SSoT — the hardcoded generators are the path of least resistance and became the
  live path. The admin CRUD/render/test endpoints, including the :id/test stub, are decorative over
  a store with zero live consumers.
- **Fix design:** Establish a single email-template SSoT that the send path is structurally forced
  to consult, and make an orphan (unbacked) template impossible and detectable. (Tier 1/2) Define a
  canonical contract lib exporting an EMAIL_TEMPLATE_CODES enum + per-code variable schema
  (welcome/invitation, password_reset, alert, regulatory welfare/disease/escape, plus messaging/HR
  codes) — the SSoT of which templates exist and their variables. Give the SENDING service
  (notification-service, the only send runtime) ownership of the persisted registry: a new
  email-template entity with schema:'notification' (platform-level cross-tenant per ADR-011) and a
  notification migration that SEEDS the current generate*Template HTML as the default active row for
  each code, so day-0 behavior is byte-identical but every subsequent edit takes effect. Refactor
  EmailService to a single renderByCode(code, variables) that loads the active template body from
  the registry and interpolates; delete the hardcoded generate*Template methods from the live path
  (they survive only as seed data in the migration). Rewire callers (auth-event.handler UserInvited,
  regulatory-report.handler, notification-dispatcher, and notification-command.handler's switch) to
  renderByCode; deactivating a code must suppress/refuse the send rather than no-op. Make admin
  authoring the front-end of the SAME store: admin-api's EmailTemplateService/controller proxy to
  notification-service's template API via the signed HTTP client (libs/backend-common
  service-identity util), and retire the duplicate admin.email_templates authoring table (dropped in
  an admin migration) so exactly one SSoT remains. Replace the :id/test stub with a real
  NotificationSendCommand dispatch so 'test' exercises the live path. Align the FE EmailTemplate
  type to the shared code contract. Because this is the config-table-nobody-reads class, land the
  pattern-level gate below, not just local wiring.
- **Files to change:**
  - `libs/event-contracts/src/email-template-contract.ts`
  - `apps/notification-service/src/notification/entities/email-template.entity.ts`
  - `apps/notification-service/src/database/migrations/`
  - `apps/notification-service/src/notification/services/email.service.ts`
  - `apps/notification-service/src/notification/event-handlers/auth-event.handler.ts`
  - `apps/notification-service/src/notification/event-handlers/regulatory-report.handler.ts`
  - `apps/notification-service/src/notification/services/notification-dispatcher.service.ts`
  - `apps/notification-service/src/notification/event-handlers/notification-command.handler.ts`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts`
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts`
  - `web/modules/admin-panel/src/services/types/index.ts`
- **Proof of fix:** Add
  apps/notification-service/src/notification/services/**tests**/email.service.registry.spec.ts:
  proves sendWelcomeEmail/sendAlertEmail/regulatory render from the registry — editing a seeded row
  changes the produced HTML, and deactivating a code causes the send to be suppressed/refused (not
  the current no-op). Add invariant e2e/tests/integration/email-template-ssot.spec.ts: (a) every
  EMAIL_TEMPLATE_CODES entry resolves to exactly one active seeded registry row; (b) the set of
  codes the admin authoring endpoint can edit === the set of codes the send path resolves (single
  SSoT, no divergence); (c) a static/AST guard asserting EmailService has no inline template-HTML
  branch on the live path (bans reintroduction of hardcoded generators) and that admin has no
  independent email_templates table. Add an end-to-end check that a template edit made via the admin
  API is reflected in the HTML notification-service renders, proving the FE->authoring->send chain
  is closed.
- **Effort:** L

### APA-345 [HIGH] 'New Template' creation is impossible — modal state never initializes, typing is a no-op, Save silently does nothing

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The New Template button sets selectedTemplate to null and opens the edit modal. Every
  input's onChange is setSelectedTemplate(prev => prev ? {...prev, field} : null) — with prev===null
  this returns null, so no keystroke is ever stored; '+ Add Variable' has the same guard.
  handleSaveTemplate begins with 'if (!selectedTemplate) return;' so Save exits silently with no
  request and no feedback. settingsApi.createEmailTemplate (POST) is therefore unreachable dead
  code; the page's create flow is broken end-to-end while the backend create endpoint works.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:147-150 (setSelectedTemplate(null) then open modal)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:353-359,416-424,493-505 (prev ? ... : null no-op handlers)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:72-87 (early return; create branch unreachable)`
- **Verification:** Confirmed by re-reading the cited file and the full FE->BE chain. The "New
  Template" button (EmailTemplatesPage.tsx:147-150) sets selectedTemplate=null and opens the edit
  modal, which renders on showEditModal alone (line 340), so the modal genuinely opens in the null
  state. Every input's onChange is setSelectedTemplate(prev => prev ? {...prev, field} : null)
  (lines 356,368,382,396,409,422 and variable handlers 442/453/463/473/486); with prev===null the
  ternary returns null, so no keystroke is ever stored. '+ Add Variable' (line 501) has the
  identical guard and is a no-op. handleSaveTemplate (line 73) opens with
  `if (!selectedTemplate) return;`, so the create case exits silently with no request and no user
  feedback. settingsApi.createEmailTemplate (email-templates.ts:15-16, POST
  /settings/email-templates) is thus unreachable dead code: selectedTemplate is only ever set to an
  existing template (with id, via handleEdit) or to null, so the else/create branch at line 77-79 is
  never taken even hypothetically. The backend side is healthy and would accept a corrected payload:
  EmailTemplateController.createTemplate exists (email-template.controller.ts:87-90),
  EmailTemplateService.createTemplate exists (email-template.service.ts:571), and @Body() binds the
  plain TS interface CreateEmailTemplateDto (from the service file, not a class), so ValidationPipe
  treats the metatype as Object and does not whitelist-reject the body. The failure is real and
  reachable in real wiring (route -> page -> modal). HIGH not CRITICAL: an entire primary admin
  action (create email template) is broken end-to-end with silent failure, but there is no security
  bypass or data corruption. This is an instance of a systemic FE class: a create-or-edit modal that
  reuses a single `T | null` selection state, where null doubles as both 'no selection' and the
  create seed, and defensive `prev ? ... : null` guards silently swallow all input on the create
  path — the same footgun can recur in any admin modal built this way. (Separately noted, out of
  this finding's scope: the create endpoint binds a TS interface rather than a class DTO, so it is
  entirely unvalidated — a distinct 'unvalidated interface-DTO' finding, not fixed here.)
- **Root cause:** The broken link is the very first one: FE modal form state. The page models the
  edit form as `selectedTemplate: EmailTemplate | null`, and reuses `null` for two incompatible
  meanings — 'nothing selected' AND the seed value the New Template button uses to open the create
  modal. Because every field handler defensively guards with `prev ? {...prev, field} : null` and
  handleSaveTemplate guards with `if (!selectedTemplate) return`, the create path — deliberately
  entered with null — can never accumulate input and can never save, making createEmailTemplate
  structurally unreachable. It drifted because the modal was originally wired for the edit path
  (where selectedTemplate is a real object) and the create entry point was bolted on by passing
  null, without adding a blank-draft initializer; the `? ... : null` guards were added to satisfy
  the `EmailTemplate | null` type rather than by modeling a create draft, so TypeScript was 'happy'
  while the runtime create flow was silently dead. Backend and DB are not implicated.
- **Fix design:** Tier-1 (make the wrong state unrepresentable) + Tier-3 (detectable gate). (1) Stop
  opening the modal with null. Split the two conflated meanings: keep a lightweight
  `editingId: string | null` for 'am I editing an existing row', and introduce a form-draft state
  that is ALWAYS a full object while the edit modal is open — `formTemplate: EmailTemplateDraft`
  seeded from a `blankEmailTemplate()` factory (empty code/name, category 'notification', empty
  subject/bodyHtml, empty variables[], isActive true). New Template -> setEditingId(null) +
  setFormTemplate(blankEmailTemplate()); Edit/Preview->Edit -> setEditingId(template.id) +
  setFormTemplate({...template}). (2) Rewrite every field handler as an unconditional update:
  setFormTemplate(prev => ({ ...prev, code: e.target.value })) etc., and the '+ Add
  Variable'/remove/variable-field handlers likewise operate on the always-present draft — deleting
  the `prev ? ... : null` guard entirely so typing can never be a no-op. (3) Rewrite
  handleSaveTemplate to branch on editingId, not on truthiness:
  `editingId ? await settingsApi.updateEmailTemplate(editingId, formTemplate) : await settingsApi.createEmailTemplate(buildCreatePayload(formTemplate))`,
  where buildCreatePayload strips id/createdAt/updatedAt to match the
  Omit<EmailTemplate,'id'|'createdAt'|'updatedAt'> signature; remove the early
  `if (!selectedTemplate) return;`. Keep the existing successMessage/error surfaces (they already
  exist; they were simply never reached on create). Preview-in-modal continues to read formTemplate.
  Because the draft is never null while the modal is open, the 'typing is a no-op' and 'save
  silently returns' behaviors become impossible, and createEmailTemplate becomes the automatic
  default for the create path. Because this null-conflation is a repeatable pattern, add a
  page-level regression gate (below) so the class is detectable at CI time. (Do NOT 'fix' by
  sprinkling `?.` or leaving the null model in place — that reproduces the footgun.)
- **Files to change:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx`
  - `web/modules/admin-panel/src/pages/__tests__/EmailTemplatesPage.spec.tsx`
- **Proof of fix:** Add web/modules/admin-panel/src/pages/**tests**/EmailTemplatesPage.spec.tsx
  (mirroring the existing CreateTenantPage.spec.tsx / TenantManagementPage.spec.tsx pattern in that
  folder) that mocks settingsApi: render the page, click 'New Template', type into Template
  Code/Template Name/Email Subject/HTML Content, click '+ Add Variable' and fill a variable name,
  click Save; assert settingsApi.createEmailTemplate was called exactly once with a payload
  containing the typed code/name/subject/bodyHtml and the added variable, and that the success
  message renders and updateEmailTemplate was NOT called. Add a companion assertion for the edit
  path: click Edit on an existing template, change a field, Save, assert updateEmailTemplate(id,
  ...) was called and createEmailTemplate was NOT. This spec fails on the current code
  (createEmailTemplate is never invoked because state stays null) and passes after the draft-state
  refactor, locking the regression. Run via `nx affected --target=test` for the admin-panel project.
- **Effort:** S

### APA-346 [MEDIUM] Backend template test-send endpoint is a stub — returns 'Test email would be sent (email service integration required)'

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** POST /settings/email-templates/:id/test only renders the template and returns a
  canned message; no email is dispatched even though admin-api has a working EmailSenderService in
  the same module. The page currently exposes no test-send button, so the capability advertised by
  the FE api layer (sendTestEmail) and the page docstring ('test etme') does not exist for users,
  and would be fake if wired.
- **Evidence:**
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:158-181 (stub comment + canned response)`
  - `web/modules/admin-panel/src/services/api/email-templates.ts:25-26 (FE function exists)`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:1-6 (docstring promises testing; no button in JSX)`
- **Verification:** All four links verified in real wiring. (1)
  apps/admin-api-service/src/settings/controllers/email-template.controller.ts:162-181 —
  sendTestEmail only renders and returns {message:'Test email would be sent (email service
  integration required)', recipientEmail, rendered}; nothing is dispatched. (2) A fully working
  EmailSenderService (nodemailer + retry + timeout + circuit breaker, method
  sendEmail(to,subject,html,text,options)) lives in the same module at
  services/email-sender.service.ts, and is BOTH provided and exported in settings.module.ts (lines
  38,45); EmailTemplateController is declared in that same module (line 30) so DI is trivially
  available — the controller constructor simply injects only EmailTemplateService and never the
  sender. (3) FE emailTemplatesApi.sendTestEmail exists (email-templates.ts:25-26) and is
  re-exported as settingsApi.sendTestEmail (api/settings.ts:67), reachable by the page. (4) Read the
  whole EmailTemplatesPage.tsx: the docstring (line 5) promises 'test etme' but there is no
  test-send button in the JSX and the page never calls sendTestEmail. The endpoint is behind the
  SUPER_ADMIN APP_GUARD and returns a 200 with a message asserting the email 'would be sent', which
  is a false-success. This is a genuine, reachable functional stub. Over-grade note: it is
  admin-only, non-security, no data-loss/crash, and has no current UI entry point, so HIGH is a
  notch high; MEDIUM is right — the operational risk (SMTP config cannot be validated via test-send
  before real emails silently fail through the circuit breaker) keeps it above LOW.
- **Root cause:** The FE->BE chain broke at the BE endpoint layer: sendTestEmail was scaffolded as a
  placeholder ('For now, just return the rendered template') and never wired to EmailSenderService,
  even though that service was later built and registered/exported in the same SettingsModule. The
  controller drifted because it depends only on EmailTemplateService and nobody re-visited the
  placeholder when the sender landed. Meanwhile the FE (emailTemplatesApi.sendTestEmail + page
  docstring) advertises a test-send capability the backend fakes and the UI never surfaces. This is
  an instance of two systemic classes: (a) 'stub endpoint returning fabricated success' — the
  response literally says the email 'would be sent' while returning HTTP 200; and (b) 'FE
  capability/type with no working backend and no UI entry point' — a dangling api fn plus a
  docstring promise. The FE return type ({message, recipientEmail, rendered}) is itself modeled on
  the stub, so the drift is baked into the hand-written FE type.
- **Fix design:** Root-cause, at the source, on both sides of the contract. (1) BACKEND — make the
  fake success impossible: inject EmailSenderService into EmailTemplateController (already exported
  from SettingsModule, zero new wiring). In sendTestEmail, render via
  templateService.renderTemplate({templateCode, variables}) to get {subject, bodyHtml, bodyText},
  then call emailSender.sendEmail(dto.recipientEmail, subject, bodyHtml, bodyText, {required:
  true}). Return the real EmailResult ({success, messageId, attempts}). Because required:true throws
  on 'SMTP not configured' / circuit-open, map that to a ServiceUnavailableException (502/503) so
  the endpoint truthfully reflects dispatch instead of a canned 200. Delete the 'Test email would be
  sent…' string entirely. This is Tier-1 (structurally impossible to return fake success) + Tier-2
  (the correct behavior — real send — is now the default path). (2) CONTRACT/TYPES — the response
  shape changes, so fix the type at the source: define TestEmailResultDto ({success:boolean;
  messageId?:string; recipientEmail:string; attempts?:number}) in settings/dto/email-template.dto.ts
  as the SSoT, and update the FE hand-written return type in
  web/modules/admin-panel/src/services/api/email-templates.ts to mirror it (drop {message,
  rendered}). (3) FE UI — fulfill the docstring instead of leaving a dead fn: add a 'Send Test'
  action in EmailTemplatesPage.tsx (a recipient-email Input + Button, e.g. inside the Preview modal
  or the card action row) that calls settingsApi.sendTestEmail(template.id, recipientEmail,
  sampleVariables) and surfaces the real success (messageId) or error via the existing
  successMessage/error state. (If the product decision is to NOT expose test-send, the honest
  alternative is to delete the sendTestEmail FE fn + docstring claim + endpoint — but since a
  working sender exists, wiring it is the correct root-cause fix.) Systemic gate: add a build/test
  invariant that fails on hardcoded stub-response strings ('would be sent', 'integration required',
  'For now') in admin-api controllers, so this class is detectable (Tier-3) rather than recurring.
- **Files to change:**
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts`
  - `apps/admin-api-service/src/settings/dto/email-template.dto.ts`
  - `web/modules/admin-panel/src/services/api/email-templates.ts`
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx`
  - `apps/admin-api-service/src/settings/__tests__/email-template-test-send.spec.ts`
  - `tests/invariants/no-stub-response-strings.spec.ts`
- **Proof of fix:** Add
  apps/admin-api-service/src/settings/**tests**/email-template-test-send.spec.ts (London-school):
  mock EmailTemplateService.renderTemplate + EmailSenderService.sendEmail; assert (a) the controller
  calls sendEmail with the recipientEmail and the rendered subject/bodyHtml/bodyText, (b) it returns
  the real EmailResult (success/messageId), (c) the response body NEVER contains the strings 'would
  be sent' / 'integration required', and (d) when sendEmail rejects (required:true, SMTP
  down/circuit open) the controller surfaces a non-2xx (ServiceUnavailableException), not a
  fake 200. Add tests/invariants/no-stub-response-strings.spec.ts that greps
  apps/admin-api-service/src/\*_/_.controller.ts for placeholder stub-response literals and fails
  the build (systemic Tier-3 gate). FE: the type change in email-templates.ts is enforced by npm run
  type-check (the page's usage of the new EmailResult shape must compile), and a component test on
  EmailTemplatesPage.tsx asserting the Send Test button calls settingsApi.sendTestEmail and renders
  the returned messageId/error.
- **Effort:** M

### APA-347 [MEDIUM] DB unique constraint on code makes the tenant-override feature impossible

- **Status:** DESIGNED (brief)
- **Symptom:** admin.email_templates has UNIQUE("code") (entity @Column({unique:true}) + Baseline
  migration), but EmailTemplateService models per-tenant overrides as a second row with the same
  code and a tenantId (createTenantOverride, getTemplateByCode fallback). Any POST
  /settings/email-templates/code/:code/override will violate the unique constraint and 500.
  Service-level duplicate check is code+tenantId; DB enforces global code uniqueness — the two
  contracts contradict.
- **Evidence:**
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts:52-60 (@Index unique + @Column unique on code)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:109-111 (UQ + unique index on code)`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:624-665 (creates second row with same code)`
- **Root cause:** The domain models email templates as 'one global row (tenantId NULL) plus optional
  per-tenant override rows sharing the same code' — createTenantOverride inserts a second row with
  the same `code` + a tenantId (email-template.service.ts:648-660), getTemplateByCode falls back
  tenant→global (532-553), and createTemplate's duplicate check is scoped (code, tenantId)
  (573-575). But persistence enforces a single-column GLOBAL unique on code:
  @Column({unique:true}) + @Index(['code'],{unique:true}) (system-setting.entity.ts:59,53) and the
  Baseline migration's UQ_e65f... + unique index (1800000000000-Baseline.ts:109,111). So the first
  override POST hits a unique_violation → 500. The seed only ever inserts global rows, which is why
  it never surfaced; the whole override feature is structurally dead.
- **Fix design:** Make the constraint match the domain (tier 1). Replace the single-column unique on
  code with two partial unique indexes (Postgres treats NULLs as distinct, so a plain
  UNIQUE(code,tenantId) would wrongly allow two global rows): unique on (code) WHERE tenantId IS
  NULL, and unique on (code, tenantId) WHERE tenantId IS NOT NULL. Express both via @Index(...,
  {unique:true, where:...}) on the entity and remove the @Column unique flag. Generate a NEW
  migration (never edit Baseline) that drops UQ_e65f... + IDX_e65f... and creates the two partial
  indexes — safe blue-green since existing rows are all global. The service scope checks already
  align to (code, tenantId), so the override path becomes functional. Also align the migration's
  `tenantId` column (character varying) with the DTO's @IsUUID('4'). Verification: integration spec
  that seeds a global template, creates a tenant override (asserts success, no 500), and asserts a
  second global row with the same code is rejected.
- **Files to change:**
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts`
  - `apps/admin-api-service/src/migrations/`
  - `apps/admin-api-service/src/settings/__tests__/email-template-tenant-override.integration.spec.ts`
- **Effort:** M

### APA-348 [MEDIUM] Template CRUD bodies bypass the global ValidationPipe — DTOs are TS interfaces, no server-side validation

- **Status:** DESIGNED (brief)
- **Symptom:** CreateEmailTemplateDto/UpdateEmailTemplateDto are plain interfaces exported from the
  service, so the global ValidationPipe (whitelist+forbidNonWhitelisted) skips them (metatype erases
  to Object). Arbitrary/oversized bodies, wrong-typed variables arrays, or junk categories are
  persisted unvalidated. Same applies to the variables jsonb payload rendered later in an iframe
  preview.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:20-43 (interface DTOs)`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts:87-101 (@Body typed with interfaces)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489 (global pipe config that these bodies bypass)`
- **Root cause:** CreateEmailTemplateDto/UpdateEmailTemplateDto are TypeScript `interface`s exported
  from the service (email-template.service.ts:20-43) and used as @Body types in the controller
  (email-template.controller.ts:88,98). Interfaces erase at runtime to metatype `Object`, which
  ValidationPipe.toValidate treats as a non-validatable native type, so the global pipe
  (whitelist+forbidNonWhitelisted, create-service-app.ts:458-489) skips them entirely —
  arbitrary/oversized bodies, junk categories, and malformed `variables` (later rendered into an
  iframe srcDoc) persist unvalidated. Instance of the systemic 'unvalidated interface-DTO' class
  (identical to the IP-access DTOs, finding p2|i4).
- **Fix design:** Convert both to class-validator classes in dto/email-template.dto.ts (where
  CreateTenantOverrideDto/ValidateTemplateDto already live): @IsString+@MaxLength on
  code/name/subject, @IsIn(getTemplateCategories()) on category, @MaxLength on bodyHtml/bodyText,
  @IsBoolean isActive, @IsUUID tenantId, and a nested EmailTemplateVariableDto
  (@IsString/@IsBoolean/@IsOptional) referenced via @IsArray+@ArrayMaxSize+@ValidateNested+@Type so
  array element shapes are actually validated (the existing override/validate DTOs also only
  shallow-validate variables — fix them to use the nested class too). Controller and service import
  these classes. Tier-3 systemic gate: add an invariant test that scans admin-api controllers and
  fails if any @Body() parameter resolves to an interface rather than a decorated class, preventing
  recurrence platform-wide. Verification: e2e posting an extra/oversized field returns 400.
- **Files to change:**
  - `apps/admin-api-service/src/settings/dto/email-template.dto.ts`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts`
  - `apps/admin-api-service/src/__tests__/controller-body-dto-classes.spec.ts`
- **Effort:** M

### APA-349 [MEDIUM] Enable/Disable toggle failures are swallowed — console.error only, optimistic UI already reconciled

- **Status:** DESIGNED (brief)
- **Symptom:** handleToggleActive catches errors with console.error and sets no error state; on
  failure the user gets no feedback at all (state is only updated after success, so the row silently
  stays unchanged with no message). Also console.\* usage violates the repo logging rule.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx:89-98`
- **Root cause:** handleToggleActive (EmailTemplatesPage.tsx:89-98) awaits updateEmailTemplate and
  only mutates local state after success; its catch logs to console.error with no setError, so a
  failed toggle produces zero user feedback — the row silently stays unchanged (not optimistic;
  state simply never updates). The page already owns a setError/error banner (used by
  loadTemplates/handleSaveTemplate) that this handler ignores. console.\* also violates the repo
  no-console rule. Systemic: every mutation handler on this page hand-rolls its own
  try/catch/console instead of a shared feedback path.
- **Fix design:** Route the failure through the existing error banner: on catch call setError(err
  instanceof Error ? err.message : 'Failed to update template') and drop the console call (matching
  handleAddRule). Tier-2 systemic improvement: extract a shared runWithFeedback(fn, successMsg)
  helper (mirroring SystemSettingsPage's saveWithFeedback) into web/modules/admin-panel/src/hooks so
  every mutation surfaces errors to the banner uniformly and no handler touches console — making
  correct feedback the zero-effort default. Verification: React Testing Library test asserting the
  error banner renders when updateEmailTemplate rejects; confirm ESLint no-console is enabled for
  admin-panel so console usage fails lint.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/EmailTemplatesPage.tsx`
  - `web/modules/admin-panel/src/hooks/`
- **Effort:** S

### APA-350 [LOW] Preview API response shape drift (latent)

- **Status:** DESIGNED (brief)
- **Symptom:** FE previewEmailTemplate types the response as {html,text,subject}; backend
  previewTemplate returns {subject,bodyHtml,bodyText}. The page does client-side preview so nothing
  breaks today, but any consumer of the FE function would read undefined fields.
  contract-validation.spec.ts still lists the pre-fix POST/GET drift entries as accepted exceptions.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/email-templates.ts:22-23`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:735-755`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts:779-789`
- **Root cause:** FE previewEmailTemplate types the response as {html, text, subject}
  (email-templates.ts:22-23), but backend previewTemplate/GET :id/preview returns {subject,
  bodyHtml, bodyText} (email-template.service.ts:735-755). Field names drift (html vs bodyHtml, text
  vs bodyText). Latent only because the page previews client-side (handlePreview builds HTML from
  template.bodyHtml directly) and never calls the API fn — any consumer would read undefined.
  Compounding: contract-validation.spec KNOWN_EXCEPTIONS still lists the preview and test endpoints
  as POST-vs-GET drift exceptions (779-789), but the FE was already migrated to GET/matching-POST,
  so those allowlist entries are now stale and mask the real (response-shape) drift — an instance of
  the banned 'allowlisting drift in contract tests' pattern, and the broader class of contract tests
  that check URL/method parity but not response body shape.
- **Fix design:** Align the FE preview return type to the backend field names {subject, bodyHtml,
  bodyText}. Remove the two now-stale KNOWN_EXCEPTIONS entries (the FE preview is GET and test is
  POST, both matching the backend — the exception reasons no longer hold), and instead extend the
  contract test to assert response-body key parity for these settings endpoints, not just URL/method
  — so shape drift is detectable at CI (tier 3) rather than allowlisted. Verification:
  contract-validation.spec passes with the exceptions removed and a response-shape assertion added
  for /settings/email-templates/:id/preview.
- **Files to change:**
  - `web/modules/admin-panel/src/services/api/email-templates.ts`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Effort:** S

## IpAccessRulesPage.tsx — `/admin/settings/integrations` — verdict: **PARTIAL**

**Chain:** The page's CRUD chain is fully real: /settings/ip-access* -> nginx ->
/api/v1/settings/ip-access* -> IpAccessController -> IpAccessService -> TypeORM repository on
admin.ip_access_rules (schema declared; table in Baseline migration; response fields match the FE
type field-for-field). The manual 'Check' tool runs a real DB evaluation with CIDR matching and
records hits. BUT the rules are enforced nowhere: no request path consults IpAccessService — the
only IP guard in the platform (gateway-api IpWhitelistGuard) is never registered on any route, is
disabled by default, and reads env vars, not this table. The admin-managed whitelist/blacklist is
pure theater.

**Endpoints exercised:** `GET /api/v1/settings/ip-access?limit=100`;
`POST /api/v1/settings/ip-access`; `PUT /api/v1/settings/ip-access/:id`;
`DELETE /api/v1/settings/ip-access/:id`; `POST /api/v1/settings/ip-access/check`

**DB tables:** `admin.ip_access_rules`

### APA-351 [HIGH] IP access rules are persisted but enforced by nothing — blacklisting an IP blocks nothing (false security)

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** IpAccessService.checkIpAccess is called only by the admin panel's manual Check button
  (POST /settings/ip-access/check). Repo-wide grep shows no middleware, guard, or gateway component
  consuming ip_access_rules or IpAccessService. gateway-api's IpWhitelistGuard: (a) appears in no
  APP_GUARD/@UseGuards registration anywhere (only its own file and spec), (b) defaults to disabled
  (IP_WHITELIST_ENABLED=false), and (c) sources its lists from IP_WHITELIST/IP_WHITELIST_CIDR env
  vars with an in-memory tenantWhitelists map that nothing populates from the DB. A SUPER_ADMIN
  blacklisting an attacker IP, or whitelisting an office range expecting default-deny, changes
  nothing at any ingress point. The page's 'Total Hits' stat reinforces the illusion — hitCount only
  increments via the manual Check tool.
- **Evidence:**
  - `grep checkIpAccess|IpAccessService|ip_access across repo: only admin-api settings module + FE + docs match`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts:87-99 (env-var source, enabled=false default), 94 (tenantWhitelists = new Map() never populated from DB)`
  - `grep IpWhitelistGuard in apps/gateway-api/src: only guard file + spec — no registration`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:146-151 (manual check is the sole consumer)`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:266-269 (hitCount only via checkIpAccess)`
- **Verification:** Confirmed by full-file reads plus repo-wide grep. (1) IpWhitelistGuard is
  registered nowhere: grep returns only the guard file, its spec, and the review doc; the full
  app.module.ts of gateway-api (the single external ingress) has exactly three APP_GUARDs —
  AuthGuard, TenantIsolationGuard, RateLimitGuard — none is IpWhitelistGuard, and no
  @UseGuards(IpWhitelistGuard) exists anywhere. (2) Even if it ran, it defaults to enabled=false
  (IP_WHITELIST_ENABLED), sources from IP_WHITELIST/IP_WHITELIST_CIDR env vars, and its
  tenantWhitelists Map is only filled by addTenantWhitelistIp which is called from nowhere but the
  spec — it has no DataSource and no IpAccessRule import, so it never reads admin.ip_access_rules.
  (3) Grep for IpAccessService|checkIpAccess|ip_access|IpAccessRule across the repo hits only
  admin-api's settings module, the FE page+api, schema-manager's schema mapping, and docs — no
  middleware/guard/gateway consumer. The ip-rate-limiter IP_WHITELIST hit is an unrelated throttler
  env-skip; nginx allow/deny matches are static config that cannot read a DB table. (4) The Total
  Hits stat is client-summed rule.hitCount; hitCount is incremented only by recordHit inside
  checkIpAccess, whose sole caller is POST /settings/ip-access/check — the manual Check button. So
  persisted whitelist/blacklist rules block nothing at any ingress; a SUPER_ADMIN blacklisting an
  attacker IP or whitelisting an office range expecting default-deny changes nothing. Severity
  lowered to HIGH: this is inert defense-in-depth with a false-assurance UI (serious) but grants no
  new access — the platform's real controls (JWT/PlatformAdminGuard/TenantIsolation/rate-limit) are
  intact — so it is not an actively exploitable CRITICAL bypass.
- **Root cause:** Two disconnected, parallel implementations that were each assumed to be the other
  half of the loop, so the enforcement link of the FE->BE->DB chain was never built. The STORAGE
  chain is complete: IpAccessRulesPage -> settingsApi -> ip-access.controller -> IpAccessService ->
  IpAccessRule entity -> admin.ip_access_rules. The ENFORCEMENT chain (DB rules -> an ingress guard
  that denies requests) does not exist. admin-api's IpAccessService has the correct evaluation logic
  (blacklist-precedence, whitelist-default-deny, CIDR, expiry) but exposes it only through a manual
  /check endpoint. gateway-api's IpWhitelistGuard has a separate, env-sourced, in-memory ruleset
  (tenantWhitelists Map never populated from the DB), defaults to disabled, and is registered by no
  APP_GUARD/@UseGuards. Neither component reads the other's data, and the guard's per-request
  evaluator and the admin check evaluator are copy-paste divergent logic — the drift. This is a
  systemic instance of persisted-config-that-no-runtime-reads /
  FE-control-surface-with-no-backend-enforcement.
- **Fix design:** Close the loop with the DB rules as the single source of truth AND enforce them at
  the single external ingress, so saving a rule automatically blocks traffic (tier 1
  make-it-impossible + tier 2 make-it-automatic). (a) Extract one pure evaluator
  evaluateIpAccess(rules, ip, tenantId) into a shared lib
  (libs/backend-common/src/security/ip-access/) implementing blacklist-precedence,
  whitelist-default-deny, CIDR, expiry, tenant scoping; have BOTH IpAccessService.checkIpAccess
  (admin manual check) and the new gateway guard consume it — a single evaluator makes 'check tool
  says blocked but ingress allows' structurally impossible. (b) Replace the dead env-only
  IpWhitelistGuard with an IpAccessGuard registered as an APP_GUARD in gateway-api/app.module.ts,
  ordered BEFORE AuthGuard so an untrusted/blacklisted IP is rejected pre-auth; add a
  BypassIpWhitelist-style decorator for /health and internal paths so enforcement cannot brick
  liveness. Delete ip-whitelist.guard.ts (or reduce it to a thin re-export of the shared evaluator)
  to remove the drift source. (c) Keep the gateway fast and DB-free per request: on every
  IpAccessService mutation (create/update/delete/bulk/clear/cleanup) write the effective ruleset to
  Redis (e.g. ip-access:rules:global and :tenant:<id>) and emit an ip-access.rules.changed event
  (NATS or Redis pub/sub); the gateway guard loads a snapshot at boot and refreshes on the event,
  evaluating in-memory. Default-deny/fail semantics must be explicit: fail-open when no rules exist
  (matches current 'no restrictions'), fail-closed in production if the snapshot cannot load. (d)
  Detectability (tier 3): a registration invariant that fails CI if the enforcement guard is not an
  APP_GUARD in gateway-api (models the existing access-log-middleware-mounted.spec.ts), plus a
  closed-loop integration test proving a persisted blacklist rule yields a 403 at the gateway before
  any subgraph. Pattern-level: the guard-registration invariant is the reusable gate for the
  'persisted control with no runtime consumer' class.
- **Files to change:**
  - `apps/gateway-api/src/guards/ip-access.guard.ts`
  - `apps/gateway-api/src/app.module.ts`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts`
  - `libs/backend-common/src/security/ip-access/ip-access-evaluator.ts`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts`
  - `apps/admin-api-service/src/settings/settings.module.ts`
  - `libs/event-contracts/src/security-events.ts`
- **Proof of fix:** Add
  libs/backend-common/src/security/ip-access/**tests**/ip-access-evaluator.spec.ts (unit: blacklist
  precedence, whitelist default-deny, CIDR, expiry, tenant scoping — the single evaluator shared by
  admin check + gateway guard). Add apps/gateway-api/src/guards/**tests**/ip-access.guard.spec.ts
  (snapshot evaluation, /health bypass, fail-closed-in-prod on snapshot-load error). Add
  tests/invariants/ip-access-guard-registered.spec.ts asserting the IP-access enforcement guard is
  present in gateway-api APP_GUARD providers (models
  tests/invariants/access-log-middleware-mounted.spec.ts) — this fails CI if enforcement is
  un-wired, the exact gap here. Add e2e/tests/integration/ip-access-enforcement.spec.ts (closed
  loop): persist a blacklist rule via admin-api, assert a request from that IP is rejected 403 at
  the gateway BEFORE reaching any subgraph, a whitelist default-deny denies a non-listed IP, and a
  non-matching IP passes; also assert hitCount increments from real ingress traffic, not only the
  manual check.
- **Effort:** L

### APA-352 [MEDIUM] Backend route shadowing: GET /settings/ip-access/stats is captured by @Get(':id')

- **Status:** DESIGNED (brief)
- **Symptom:** @Get('stats') is declared after @Get(':id') in IpAccessController, so
  /settings/ip-access/stats resolves to getRuleById('stats'); the id column is uuid so the lookup
  errors (invalid uuid input) instead of returning statistics. The FE dodges this by computing stats
  client-side, but the server statistics endpoint (incl. mostHitRules) is unreachable.
- **Evidence:**
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:98-101 (@Get(':id')) vs 216-219 (@Get('stats') declared later)`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:112 (id uuid)`
- **Root cause:** In IpAccessController, @Get(':id') getRuleById is declared at line 98, before
  @Get('stats') getStatistics at line 216. Express matches in declaration order, so GET
  /settings/ip-access/stats binds to getRuleById('stats') → service findOne({where:{id:'stats'}})
  against a uuid `id` column (Baseline:112) → Postgres invalid-uuid-syntax error → 500. The server
  statistics endpoint (including mostHitRules) is unreachable; the FE only dodges it by computing
  stats client-side. Classic literal-route-shadowed-by-param-route bug (the sibling
  EmailTemplateController avoids it by declaring all literals before :id).
- **Fix design:** Move @Get('stats') above @Get(':id') so the literal wins (tier 2), AND constrain
  the param route so it structurally cannot swallow literals (tier 1): declare it as @Get(':id')
  with a uuid regex path constraint (e.g. ':id([0-9a-fA-F-]{36})') so any non-uuid segment like
  'stats' falls through to the literal handler regardless of ordering. Verification: e2e test
  hitting GET /settings/ip-access/stats asserts a 200 statistics object (with mostHitRules), plus a
  route-collision invariant covering the controller.
- **Files to change:**
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
- **Effort:** S

### APA-353 [MEDIUM] Rule list and stats capped at first 100 rules with no pagination UI

- **Status:** DESIGNED (brief)
- **Symptom:** loadData requests limit=100 and the page renders no pager; the stats cards (Total
  Rules, counts, Total Hits) are computed from that first-page subset, so once more than 100 rules
  exist both the table and every stat silently under-report. Backend getAllRules also loads ALL
  rules into memory before slicing (in-process pagination).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:60-73 (limit:100 + client-side stats)`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:62-82 (in-memory slice pagination)`
- **Root cause:** IpAccessRulesPage.loadData requests {limit:100} and renders no pager; the six stat
  cards (Total Rules, whitelist/blacklist counts, active/expired, Total Hits) are computed from that
  first-page subset (IpAccessRulesPage.tsx:60-73), so beyond 100 rules both the table and every stat
  silently under-report — the FE ignores result.total and uses rulesData.length. Backend getAllRules
  also loads ALL rules into memory then array-slices (ip-access.controller.ts:62-82), so pagination
  is in-process, not in the query.
- **Fix design:** Two-part. (1) Stats must be server-authoritative: consume the getStatistics
  endpoint (which already aggregates over all rules incl. mostHitRules) instead of deriving from a
  page — this requires finding p2|i1's shadowing fix first, then add settingsApi.getIpAccessStats
  and render from it (tier 2, correct regardless of page size). (2) Add real pagination: render a
  pager driven by page/limit using the server's total/totalPages, and push pagination into the query
  — backend getAllRules should use findAndCount with skip/take rather than loading all rows and
  slicing. Verification: e2e asserting stats aggregate over the full set with >100 rules; FE test
  that the pager advances pages and totals come from result.total.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx`
  - `web/modules/admin-panel/src/services/api/settings.ts`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts`
- **Effort:** M

### APA-354 [MEDIUM] Bulk Add loops single-create and aborts on first failure, leaving partial inserts; backend bulk endpoints unused

- **Status:** DESIGNED (brief)
- **Symptom:** handleBulkAdd issues one POST per line; a duplicate (409) or invalid IP mid-list
  throws, aborting the remaining IPs while earlier ones are already committed — the error banner
  gives no per-IP breakdown. The purpose-built POST /settings/ip-access/{whitelist,blacklist}/bulk
  endpoints (ArrayMaxSize 500, per-IP validation, added/skipped/errors report) are never called by
  the FE. Note the bulk endpoints' @IsIP would also reject CIDR entries the single-create path
  accepts, so the two paths have divergent contracts.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:107-130 (sequential loop, single try/catch)`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:37-46,161-195 (unused bulk endpoints; @IsIP each)`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:425-433 (single-create accepts CIDR)`
- **Root cause:** handleBulkAdd (IpAccessRulesPage.tsx:107-130) issues one POST per line inside a
  single try/catch, so the first failure (a 409 duplicate or an invalid IP mid-list) throws and
  aborts the remaining IPs while earlier ones are already committed — a partial insert with a single
  opaque error banner. The purpose-built POST /settings/ip-access/{whitelist,blacklist}/bulk
  endpoints (ip-access.controller.ts:161-195), which return an {added, skipped, errors} report and
  skip duplicates instead of aborting, are never called. Worse, those bulk endpoints validate with
  @IsIP(each) (controller:40) which REJECTS CIDR, while the single-create service path accepts CIDR
  (ip-access.service.ts:425-433) — two divergent IP-validation contracts, so the bulk endpoint can't
  even be adopted as-is (the FE bulk modal advertises CIDR examples).
- **Fix design:** Fix the split validation contract at the source: introduce one shared CIDR-aware
  validator (a custom @IsIpOrCidr class-validator constraint backed by the same predicate the
  service uses) and apply it to BOTH the bulk DTO (replacing @IsIP each) and the single-create DTO —
  so the two paths agree structurally (tier 1). Then wire the FE bulk-add to the bulk endpoint and
  render its {added, skipped, errors} report per-IP; this removes the client loop and inherits the
  server's skip-don't-abort behavior and partial-result feedback. Verification: e2e posting a bulk
  list mixing a valid IP, a CIDR, a duplicate, and junk → asserts the {added, skipped, errors}
  breakdown and that CIDR is accepted; unit test for the shared validator.
- **Files to change:**
  - `apps/admin-api-service/src/settings/dto/is-ip-or-cidr.validator.ts`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx`
  - `web/modules/admin-panel/src/services/api/settings.ts`
- **Effort:** M

### APA-355 [LOW] CRUD DTOs are TS interfaces — global ValidationPipe skipped; FE 'isActive' on create silently ignored

- **Status:** DESIGNED (brief)
- **Symptom:** CreateIpAccessRuleDto/UpdateIpAccessRuleDto are interfaces, so bodies bypass
  whitelist validation (service does its own IP/CIDR regex — IPv6 regex only matches full
  uncompressed form, rejecting '::1'-style addresses). The FE sends isActive on create but the
  service unconditionally sets isActive:true.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:17-31 (interface DTOs), 144-148 (isActive:true override), 425-432 (simplified IPv6 regex)`
  - `web/modules/admin-panel/src/pages/IpAccessRulesPage.tsx:90-96 (isActive in payload)`
- **Root cause:** Three defects rooted in the same interface-DTO + ad-hoc-service-validation
  pattern. (1) CreateIpAccessRuleDto/UpdateIpAccessRuleDto are TS interfaces
  (ip-access.service.ts:17-31) used as @Body types (controller:109,125), so they erase to metatype
  Object and the global ValidationPipe skips whitelist/type validation entirely — same class as
  finding p1|i4. (2) createRule hardcodes isActive:true (ip-access.service.ts:146), silently
  discarding the isActive the FE sends on create (IpAccessRulesPage.tsx:94) — the FE type advertises
  a field the backend ignores. (3) The service IPv6 regex only matches the full 8-group uncompressed
  form (line 430), rejecting valid compressed addresses like ::1 / fe80::1.
- **Fix design:** Convert Create/Update IP DTOs to class-validator classes in dto/ip-access.dto.ts,
  using the shared @IsIpOrCidr validator from finding p2|i3 — and implement that validator with a
  robust check (Node net.isIP for the address portion + range validation, or ipaddr.js) so it
  accepts compressed IPv6 and CIDR, replacing the broken regex at the single source of truth (kills
  defects 1 and 3 together). Add isActive to CreateIpAccessRuleDto and change createRule to honor
  `dto.isActive ?? true` (mirroring createTemplate) so create can produce an inactive rule (defect
  2). Reuse the systemic 'no @Body interface' invariant test from finding p1|i4 to prevent
  recurrence. Verification: validator unit test accepting ::1 and CIDR + rejecting junk; createRule
  test that isActive:false persists inactive; e2e posting an unknown field returns 400.
- **Files to change:**
  - `apps/admin-api-service/src/settings/dto/ip-access.dto.ts`
  - `apps/admin-api-service/src/settings/dto/is-ip-or-cidr.validator.ts`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts`
- **Effort:** M

## AuditLogPage.tsx — `/admin/audit` — verdict: **PARTIAL**

**Chain:** The ledger itself is real and well-protected: GET /api/v1/audit-logs ->
AuditLogController -> AuditLogService -> admin.audit_logs (schema declared, Baseline migration with
append-only UPDATE/DELETE-blocking trigger, legalHold column, inet ipAddress; reads are
meta-audited). The default page load (page+limit only) and the statistics cards work against real
aggregation queries. BUT every filter control and the Export button are broken by the global
ValidationPipe: the controller mixes named @Query params with an un-named @Query()
PaginationQueryDto, so any query string containing filter keys
(action/severity/entityType/tenantId/search/startDate/endDate) fails forbidNonWhitelisted with 400,
and Export's limit=10000 violates @Max(100). On top of that the FE severity vocabulary and the
metadata field name don't match the backend.

**Endpoints exercised:** `GET /api/v1/audit-logs?page&limit(&filters)`;
`GET /api/v1/audit-logs/statistics`;
`GET /api/v1/tenants?limit=100 (filter dropdown via tenantsApi.list)`

**DB tables:** `admin.audit_logs`, `auth.tenants (indirectly, tenant dropdown)`

### APA-356 [HIGH] Every filter on the audit page returns 400 — @Query() DTO + forbidNonWhitelisted rejects the filter keys

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** queryAuditLogs declares named @Query('action'|'severity'|...) params AND '@Query()
  pagination?: PaginationQueryDto'. The global ValidationPipe (whitelist:true,
  forbidNonWhitelisted:true — libs/backend-common bootstrap, no overrides in admin-api main.ts)
  validates the ENTIRE req.query object against PaginationQueryDto for the un-named param; any
  request carrying action/severity/entityType/tenantId/search/startDate/endDate therefore 400s
  ('property X should not exist'). The unfiltered default load (page,limit) succeeds, so the page
  looks healthy until a filter is touched, then flips to the error card. In production
  disableErrorMessages masks the reason entirely.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.controller.ts:42-54 (named filters + @Query() PaginationQueryDto on one handler)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489 (global whitelist+forbidNonWhitelisted pipe)`
  - `apps/admin-api-service/src/main.ts:10-36 (no validationPipeOverrides)`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25 (only page/limit/sortBy/sortOrder whitelisted)`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:290-307 (filters appended to same query string)`
- **Verification:** Confirmed end-to-end. FE
  (web/modules/admin-panel/src/pages/AuditLogPage.tsx:290-307 + services/api/audit.ts:25) sends
  action/severity/entityType/tenantId/search/startDate/endDate alongside page/limit in one query
  string to GET /audit-logs. The handler
  (apps/admin-api-service/src/audit/audit.controller.ts:42-54) mixes nine named @Query('x') string
  params (ValidationPipe skips primitive metatypes) with a bare @Query() pagination?:
  PaginationQueryDto, which receives the ENTIRE req.query and is validated against
  PaginationQueryDto (only page/limit/sortBy/sortOrder — src/shared/pagination-query.dto.ts). The
  platform-global pipe (libs/backend-common/src/bootstrap/create-service-app.ts:458-497) sets
  whitelist:true + forbidNonWhitelisted:true; admin-api main.ts passes no overrides and no APP*PIPE
  exists in service production code. Therefore every request carrying a filter key 400s ('property X
  should not exist'), while the filter-less default load succeeds — exactly the reported symptom; in
  production disableErrorMessages masks the response to a bare Bad Request (server logs do get the
  field list via the exceptionFactory). Refutation attempts failed: nginx rewrite only maps
  /api/*→/api/v1/\_ (path, not query); no alternate audit route; service tests build their own
  permissive ValidationPipes so the real pipe config is never exercised. The pattern is systemic in
  admin-api: billing.controller.ts:532-538 (listCustomPlans) and
  ticket.controller.ts:162-170/231-236/245-249 mix named @Query + bare @Query() DTO identically and
  400 on any filter. HIGH stands: a core SUPER_ADMIN security-investigation surface (audit
  filtering) is fully broken, plus billing custom-plan and support-ticket filtered lists; not
  CRITICAL because it is availability of admin tooling, not a security or data-integrity breach.
- **Root cause:** The BE link of the chain broke: the endpoint's query-string contract has no single
  owner. Pagination was extracted into a shared PaginationQueryDto and grafted onto handlers as a
  bare @Query() param while the handlers' filter keys stayed as ad-hoc named @Query('x') primitives
  that the ValidationPipe never sees. Under the platform-global whitelist+forbidNonWhitelisted pipe,
  the bare @Query() DTO is the only class-typed view of req.query, so it implicitly claims the WHOLE
  query object and every legitimate filter key becomes a forbidden non-whitelisted property. The
  drift went undetected because (a) nothing at build/test time forbids mixing named @Query with a
  bare @Query() DTO, and (b) admin-api integration tests instantiate their own permissive
  ValidationPipes (transform-only or whitelist-only) instead of the production pipe, so
  forbidNonWhitelisted was never exercised against real filter traffic. Side defect of the same root
  cause: the named filters bypass validation entirely (severity accepts any string;
  startDate/endDate become Invalid Date silently).
- **Fix design:** SYSTEMIC CLASS: DTO-whitelist rejection via mixed named-@Query + bare-@Query()-DTO
  (instances: audit queryAuditLogs; billing listCustomPlans; support
  getAllTickets/getTicketsForTenant/getAssignedTickets). Fix at pattern level plus local
  applications.

(1) Tier-1 contract rule — one handler, one query DTO: each affected handler declares its FULL query
contract as a single class extending PaginationQueryDto; no named @Query('x') may coexist with a
bare @Query(). New apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts:
`export class QueryAuditLogsDto extends PaginationQueryDto` with @IsOptional()+@IsString()
action/entityType/performedBy/search, @IsOptional()+@IsUUID() entityId/tenantId,
@IsOptional()+@IsEnum(AuditSeverity) severity, @IsOptional()+@IsISO8601() startDate/endDate.
Controller becomes `queryAuditLogs(@Req() req, @Query() query: QueryAuditLogsDto)` building
AuditLogFilter from it (new Date(query.startDate) etc.). This makes the wrong behavior impossible
(whitelist now IS the contract) and upgrades the previously unvalidated filters to real validation
(enum severity, ISO dates, UUID tenantId). Same application in billing (add ListCustomPlansQueryDto
extends PaginationQueryDto — tenantId, @IsEnum status/tier, search — to
src/billing/dto/billing.dto.ts) and support (ListTicketsQueryDto with enum
status/priority/category + assignedTo/tenantId/search, and a status-only StatusPaginationQueryDto
for the tenant/assigned routes; ticket DTOs are colocated in ticket.controller.ts today, so define
them beside CreateTicketDto or in a new support dto file). FE needs no change — its param shape
already matches the corrected contract; do NOT relax the global pipe or add per-route pipe overrides
(that would be a shim).

(2) Tier-3 pattern gate: new architecture spec
apps/admin-api-service/src/**tests**/api/query-dto-contract.spec.ts that statically scans
apps/admin-api-service/src/\*_/_.controller.ts and fails any handler whose parameter list contains
both @Query('...') and bare @Query() — same static-scan style as the existing tenant-schema-routing
architecture spec. This kills the whole defect class in the service, including future handlers.

(3) Tier-2 verification integrity: extract the pipe defaults in configureValidationPipe
(libs/backend-common/src/bootstrap/create-service-app.ts:446-498) into an exported
createDefaultValidationPipe(isProduction, overrides?) (re-exported from
libs/backend-common/src/bootstrap/index.ts) used by bootstrapService itself, so integration tests
mount the production-identical pipe instead of hand-mirrored options — mirrored permissive pipes are
exactly how this bug escaped tests, and hand-copied pipe config in specs is banned drift.

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
- **Proof of fix:** Two gates. (a) Regression: new
  apps/admin-api-service/src/audit/**tests**/audit.controller.integration.spec.ts mounts
  AuditLogController with the REAL pipe via the newly exported createDefaultValidationPipe(false)
  and supertest, asserting GET
  /audit-logs?action=X&severity=CRITICAL&entityType=Tenant&tenantId=<uuid>&search=s&startDate=2026-01-01T00:00:00Z&endDate=2026-02-01T00:00:00Z&page=1&limit=20
  returns 200 with the filter forwarded to a mocked AuditLogService.query, GET
  /audit-logs?severity=NOT_A_SEVERITY returns 400, and GET /audit-logs?bogus=1 returns 400;
  equivalent filtered-list cases added for billing listCustomPlans and support getAllTickets in
  their existing controller spec files. (b) Class-wide invariant: new
  apps/admin-api-service/src/**tests**/api/query-dto-contract.spec.ts statically scans all
  \*.controller.ts under the service and fails any handler mixing @Query('name') with bare @Query()
  — proves the systemic pattern is eliminated and cannot recur. Both run under nx affected
  --target=test.
- **Effort:** M

### APA-357 [HIGH] Export always fails (limit=10000 > @Max(100)); even if accepted it would silently truncate to 100 rows

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** handleExport always sends limit=10000; PaginationQueryDto caps limit at @Max(100) so
  the request 400s and the user gets 'Export failed'. Were the DTO cap removed,
  AuditLogService.query clamps take to Math.min(limit,100), so a 'full CSV export' would silently
  contain at most 100 of potentially thousands of records — silent data loss in a compliance export.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:339-374 (limit:'10000')`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:11-16 (@Max(100))`
  - `apps/admin-api-service/src/audit/audit.service.ts:119-120 (take = Math.min(limit,100))`
- **Verification:** Adversarial verification failed to refute; every link is concretely reachable.
  handleExport (web/modules/admin-panel/src/pages/AuditLogPage.tsx:341) always sends limit='10000'
  to GET /audit-logs. admin-api-service boots via bootstrapService with no validationPipeOverrides
  and no APP_PIPE, so the platform-default global ValidationPipe applies
  (libs/backend-common/src/bootstrap/create-service-app.ts:458-489: whitelist:true,
  forbidNonWhitelisted:true, transform:true). @Query() pagination?: PaginationQueryDto is validated:
  @Type(() => Number) converts '10000' to 10000 and @Max(100)
  (apps/admin-api-service/src/shared/pagination-query.dto.ts:15) rejects it -> 400
  BadRequestException (bare 'Bad Request' in prod due to disableErrorMessages). apiFetch throws on
  4xx without retry (web/modules/admin-panel/src/services/http-client.ts:309-311) ->
  setExportError('Export failed: ...') (AuditLogPage.tsx:372). The normal list fetch uses limit=20
  (AuditLogPage.tsx:274) so only export trips the cap. Second half also confirmed:
  apps/admin-api-service/src/audit/audit.service.ts:120 clamps take = Math.min(limit, 100), so
  lifting the DTO cap alone would produce a silently truncated 100-row 'full' compliance export.
  Verification additionally surfaced an aggravating co-defect in the same route: because the
  controller mixes @Query('action') etc. with @Query() PaginationQueryDto, forbidNonWhitelisted
  validates the FULL query object against PaginationQueryDto and 400s ANY filtered request
  ('property action should not exist') — a filtered export fails for two independent reasons, and
  filtered list queries on this endpoint are broken too (systemic 'DTO-whitelist rejection' class,
  also present in support/controllers/ticket.controller.ts and billing/billing.controller.ts). HIGH
  stands: a compliance export on the SUPER_ADMIN surface is completely non-functional, and the
  layered clamp turns the naive fix (raise @Max) into silent data loss.
- **Root cause:** The FE->BE contract link broke because no export contract exists at all: the FE
  fakes 'full export' by driving the bounded paginated LIST endpoint with an out-of-contract limit
  (10000), while the BE enforces the bounded-page contract twice independently (DTO @Max(100) and
  service-side Math.min(limit,100)). FE api params (services/api/audit.ts) and BE DTOs
  (shared/pagination-query.dto.ts) are hand-written with no shared source and no contract test
  exercising the FE's actual request shapes against the BE validation pipe, so the FE encoded an
  assumption (unbounded limit) the BE structurally forbids and nothing detected it at build/test
  time. It is an instance of two declared systemic classes: FE-type drift (hand-written params vs
  hand-written DTO) and DTO-whitelist rejection (the same controller's mixed @Query('x') + @Query()
  PaginationQueryDto pattern makes forbidNonWhitelisted 400 every filtered query on this route).
- **Fix design:** Tier-1 fix: make an over-limit export structurally inexpressible by giving export
  its own contract instead of a giant page fetch. (1) BE: add GET /audit-logs/export on
  AuditLogController taking a new AuditLogFilterQueryDto (action, entityType, entityId, tenantId,
  performedBy, severity, startDate, endDate, search — all class-validator-decorated; NO page/limit
  fields, so no limit can be sent, satisfied trivially by whitelist). It returns a streamed text/csv
  StreamableFile with Content-Disposition; ResponseInterceptor gets an instanceof-StreamableFile
  early-return (today it only skips by URL prefix and would JSON-wrap the CSV). (2) AuditLogService
  gains streamAll(filter): AsyncIterable<AuditLog> using keyset pagination (createdAt,id cursor,
  internal batches of ~1000) so the FULL filtered set streams without unbounded memory; query()'s
  Math.min clamp stays — it is the correct bounded LIST contract. CSV serialization moves
  server-side (proper quoting + spreadsheet formula-injection guard for =,+,-,@ — this is a
  compliance artifact). The export emits the existing DATA_EXPORT audit action (determineSeverity
  already classifies it CRITICAL) plus writeMetaAudit('EXPORT', filter), closing the gap where a
  bulk audit read left no trail. (3) Same-file systemic-class fix: collapse the mixed @Query('x') +
  @Query() PaginationQueryDto binding in queryAuditLogs into a single AuditLogQueryDto extends
  PaginationQueryDto (filter fields + pagination in one validated DTO), which also un-breaks
  filtered list queries under forbidNonWhitelisted; this single-DTO-per-query-surface pattern is the
  template for the sibling occurrences in ticket.controller.ts and billing.controller.ts (their own
  findings). (4) FE: add an apiFetchBlob/apiDownload helper in http-client.ts for non-envelope
  binary responses (apiFetch assumes the JSON envelope); auditApi.export(filters) calls
  /audit-logs/export and its parameter type contains no limit field; handleExport downloads the
  streamed blob and the client-side CSV assembly plus limit:'10000' are deleted. Result: the wrong
  behavior (partial or over-limit export) cannot be expressed by either side's types, and correct
  behavior (full filtered export, audit-trailed) is the zero-effort default.
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
- **Proof of fix:** New integration spec
  apps/admin-api-service/src/audit/**tests**/audit-export.spec.ts (supertest against a Nest app
  built with the same createServiceApp ValidationPipe defaults) asserting: (a) with 250 seeded audit
  rows, GET /audit-logs/export streams a CSV containing all 250 data rows (kills the 100-row clamp
  truncation class — the exact silent-loss mode the finding predicts); (b) export response is raw
  text/csv with Content-Disposition, NOT the {success,data,meta} envelope (proves the
  ResponseInterceptor StreamableFile skip); (c) GET /audit-logs?limit=10000 still returns 400 (the
  bounded LIST contract is preserved, not loosened); (d) GET /audit-logs?action=X&page=1&limit=20
  returns 200 (kills the forbidNonWhitelisted rejection on filtered queries via the unified
  AuditLogQueryDto); (e) a successful export writes a DATA_EXPORT audit entry. Extend
  apps/admin-api-service/src/**tests**/contract-validation.spec.ts so the FE's new
  /audit-logs/export call maps to a real backend route, keeping the FE-route-with-no-backend gate
  green.
- **Effort:** M

### APA-358 [MEDIUM] Severity vocabulary drift: FE uses low/medium/high/critical, backend enum is info/warning/critical

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** The FE AuditLog type and the severity filter dropdown use
  'low'|'medium'|'high'|'critical'; the DB enum is 'info'|'warning'|'critical'
  (admin.audit_logs_severity_enum). Three of four filter options could never match a row
  (independent of the 400 issue), and rows with severity 'info'/'warning' render with the fallback
  gray badge instead of their intended styling. Only the 'Critical Events' stat card happens to
  align.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/audit.ts:13`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:69-75,120-128`
  - `apps/admin-api-service/src/audit/audit.entity.ts:54-58`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:7`
- **Verification:** Verified in source: FE audit type (services/types/audit.ts:13), dropdown
  (AuditLogPage.tsx:69-75) and badge map (:120-128) use 'low|medium|high|critical'; backend entity
  enum (audit.entity.ts:54-58) and DB enum (Baseline.ts:7, admin.audit_logs_severity_enum) are
  'info|warning|critical', and determineSeverity() only ever writes those three. Concretely
  reachable with zero filters: the default list request (page+limit only, whitelisted in
  PaginationQueryDto) loads rows whose 'info'/'warning' severities fall through the badge map to the
  gray fallback — only 'critical' styles correctly, and only the Critical Events stat card aligns
  (service getStatistics returns 'critical'). The filter side is real independent of the companion
  forbidNonWhitelisted-400 finding: with a bare unvalidated @Query('severity') (controller:50),
  severity=low reaches Postgres as an invalid enum cast, which audit.service.query()'s catch
  (:199-211) swallows into {data:[], total:0} — silent false negatives on a compliance surface. No
  transform layer rescues it (http-client only unwraps the envelope). The FE even carries the
  CORRECT union twice already (services/types/security.ts:38, security/AuditTrailPage.tsx:34) —
  three competing vocabularies, no SSoT. Downgraded from HIGH to MEDIUM: internal SUPER_ADMIN
  surface, no security boundary crossed or data loss; today the filter fails loudly with a 400
  banner, and mis-styled badges still display the severity text. Still MEDIUM (not LOW) because the
  post-i1-fix path yields silently empty results for 3 of 4 filter options during
  incident/compliance review.
- **Root cause:** FE→BE contract link broke: the admin-panel hand-writes its API types with no
  shared contract or drift gate against admin-api-service, and the author of services/types/audit.ts
  invented a generic 4-level severity scale instead of mirroring the backend AuditSeverity enum —
  even though the same FE module already holds the correct 'info|warning|critical' union in
  services/types/security.ts:38 and a third private copy in security/AuditTrailPage.tsx:34. Systemic
  class: hand-written-FE-type drift (three vocabulary definitions, no SSoT). The backend
  co-contributes: audit.controller.ts:50 types the query param as AuditSeverity but never validates
  it (compile-time lie; runtime accepts any string), and audit.service.query()'s blanket catch masks
  the resulting Postgres enum-cast error as an empty result set.
- **Fix design:** Pattern-level (systemic FE-type-drift class) plus local application. (1) Tier 1/2
  FE: make services/types/audit.ts the value-level SSoT — export const AUDIT_SEVERITIES =
  ['info','warning','critical'] as const; export type AuditSeverity = (typeof
  AUDIT_SEVERITIES)[number]; type AuditLog.severity with it. Consolidate the duplicates:
  services/types/security.ts imports/re-exports this type (barrel already exports both files — keep
  exactly one definition), and security/AuditTrailPage.tsx drops its private copy. (2) Tier 1
  rendering: in AuditLogPage.tsx derive SEVERITY_LEVELS options from AUDIT_SEVERITIES and replace
  getSeverityBadgeVariant's string-keyed map + fallback with an exhaustive Record<AuditSeverity,
  BadgeVariant> = { info:'info', warning:'warning', critical:'error' } — a new enum member without a
  badge becomes a tsc error; no defensive fallback. (3) Tier 1 backend boundary (coordinated with
  the companion forbidNonWhitelisted-400 finding on the same endpoint — one DTO fixes both): new
  apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts extending PaginationQueryDto with the
  filter fields incl. @IsOptional() @IsEnum(AuditSeverity) severity?: AuditSeverity;
  audit.controller.queryAuditLogs takes the single DTO, eliminating the unvalidated bare
  @Query('severity') and closing the swallowed-enum-cast → fake-empty-result path. (4) Tier 3
  cross-boundary gate: new invariant spec tests/invariants/admin-audit-severity-contract.spec.ts
  (repo already uses tests/invariants for cross-boundary checks) asserting set-equality of
  Object.values(backend AuditSeverity), FE AUDIT_SEVERITIES, and the ENUM literal parsed from the
  Baseline migration's CREATE TYPE "admin"."audit_logs_severity_enum" statement — any future drift
  on any of the three sides fails CI. No FE compat mapping layer, no allowlisting: the vocabulary is
  fixed at the source on both sides.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/audit.ts`
  - `web/modules/admin-panel/src/services/types/security.ts`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx`
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx`
  - `apps/admin-api-service/src/audit/dto/query-audit-logs.dto.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `tests/invariants/admin-audit-severity-contract.spec.ts`
- **Proof of fix:** New tests/invariants/admin-audit-severity-contract.spec.ts: asserts
  Object.values(AuditSeverity) from apps/admin-api-service/src/audit/audit.entity.ts,
  AUDIT_SEVERITIES from web/modules/admin-panel/src/services/types/audit.ts, and the ENUM values
  parsed from migrations/1800000000000-Baseline.ts's CREATE TYPE statement are set-equal — fails on
  any future drift. Extend the audit controller spec (apps/admin-api-service/src/audit/**tests**/)
  with the new DTO: GET /audit-logs?severity=low returns 400; severity=warning passes the value
  through to AuditLogService.query. Compile-time proof via npm run type-check: the exhaustive
  Record<AuditSeverity, BadgeVariant> in AuditLogPage.tsx errors if a severity lacks a badge
  mapping, and the dropdown derives from AUDIT_SEVERITIES so a stale option cannot exist.
- **Effort:** M

### APA-359 [HIGH] Detail modal 'Metadata' section can never display — FE reads log.metadata, backend field is 'details'

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The backend entity/response carries the structured payload in 'details' (plus
  previousValue/newValue); the FE type declares 'metadata' and the modal gates on log.metadata &&
  Object.keys(log.metadata).length — always undefined, so the audit entry's actual payload (the
  substance of the audit record) is silently hidden from reviewers. previousValue/newValue are not
  rendered at all.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/audit.ts:14`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:211-218`
  - `apps/admin-api-service/src/audit/audit.entity.ts:122-129`
- **Verification:** Verified the full FE->BE->DB chain independently. FE services/api/audit.ts calls
  /audit-logs, which nginx rewrites to the admin-api-service AuditLogController.queryAuditLogs ->
  AuditLogService.query(). query() returns AuditLog entities directly via getManyAndCount() with NO
  DTO/serializer mapping. The entity (audit.entity.ts:122-129) stores the structured payload in
  `details` (jsonb) plus `previousValue`/`newValue`; there is no `metadata` field anywhere in the
  audit module (grep confirms `metadata` only exists in unrelated analytics/security/impersonation
  entities). ResponseInterceptor only wraps {success,data,meta} and does not rename fields; no
  ClassSerializerInterceptor/@Expose remap exists. So the payload delivered to the FE carries
  details/previousValue/newValue, never `metadata`. The FE type (services/types/audit.ts:14)
  declares `metadata` and, critically, adds `[key: string]: unknown` (line 18) which suppresses the
  TS error that would otherwise flag log.metadata as a non-existent property — that is exactly why
  the drift went unnoticed. The modal gate at AuditLogPage.tsx:211
  (`log.metadata && Object.keys(log.metadata).length > 0`) is therefore permanently false, so the
  Metadata section can never render, and previousValue/newValue have no render path at all. The
  claim is concretely reachable in real wiring. HIGH is appropriate (not CRITICAL): no
  security/data-integrity breach, but the structured 'what actually changed' payload — the entire
  substance of an audit record — is silently unviewable in the SUPER_ADMIN audit review tool,
  defeating the detail modal's core purpose. This is an instance of the systemic FE-type-drift
  class: hand-written FE types diverging from the backend response contract, masked by a permissive
  index signature.
- **Root cause:** The FE hand-written `AuditLog` interface drifted from the backend audit entity
  contract. The backend entity/service is the SSoT and returns the structured payload under
  `details` (plus `previousValue`/`newValue`), with no DTO remap. The FE type instead named that
  payload `metadata` and never modeled `previousValue`/`newValue`. Because admin-panel uses
  hand-written types with no codegen/contract test binding them to the backend, nothing caught the
  rename. The `[key: string]: unknown` index signature on the FE interface is the second half of the
  root cause: it makes `log.metadata` type-check as `unknown` instead of a compile error, so the
  mismatch stayed invisible to tsc and to reviewers. The modal condition `log.metadata && ...`
  consequently evaluates to false for every real record.
- **Fix design:** Root-cause, at the source, addressing both the local defect and the systemic drift
  class. (1) LOCAL — realign the FE contract with the backend entity: in services/types/audit.ts
  replace `metadata: Record<string, unknown>` with `details?: Record<string, unknown>` and add
  `previousValue?: Record<string, unknown>` and `newValue?: Record<string, unknown>` (mirroring
  audit.entity.ts:122-129, all nullable columns => optional). While here, align the `severity` union
  with the backend AuditSeverity enum (`'info' | 'warning' | 'critical'`) since it is the same drift
  class, and REMOVE the `[key: string]: unknown` index signature so any future field-name mismatch
  surfaces as a tsc error at the access site (tier-1 make-it-impossible / tier-3
  make-it-detectable). If TableColumn<AuditLog> requires non-field keys like 'actions', model that
  in the column type (e.g. key: keyof AuditLog | 'actions') rather than reintroducing the catch-all
  signature. (2) LOCAL — in AuditLogPage.tsx LogDetailModal (lines 211-218), render the real
  payload: gate the existing block on `log.details` and JSON.stringify(log.details), and add two
  additional conditional sections for `log.previousValue` and `log.newValue` (a diff-style
  Before/After is ideal for an audit reviewer). (3) PATTERN/DETECTABLE — because this is a recurring
  FE-type-drift class across admin-panel hand-written types, add a build-time contract gate rather
  than relying on manual vigilance: introduce an explicit AuditLogResponseDto in admin-api-service
  used as the controller return type (making the wire contract a named artifact), and a parity test
  asserting the admin-panel `AuditLog` interface keys equal the DTO/entity column set (fails on any
  future rename/addition). Removing the index signature (step 1) is the cheap enforcement; the
  parity test is the durable gate.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/audit.ts`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `web/modules/admin-panel/src/pages/__tests__/AuditLogPage.detail-modal.spec.tsx`
- **Proof of fix:** Add
  web/modules/admin-panel/src/pages/**tests**/AuditLogPage.detail-modal.spec.tsx that renders
  LogDetailModal with a log containing non-empty details, previousValue, and newValue and asserts
  all three sections appear with their JSON content — this fails on current code (modal reads
  log.metadata, sections absent) and passes after the fix. Add a contract-parity spec (e.g.
  web/modules/admin-panel/src/services/types/**tests**/audit-contract.spec.ts, or extend the
  admin-api audit tests with
  apps/admin-api-service/src/audit/**tests**/audit-response-contract.spec.ts) that pins the FE
  AuditLog key set to the backend audit entity/AuditLogResponseDto columns
  (details/previousValue/newValue present, metadata absent), so any future rename breaks the build.
  Removing the `[key: string]: unknown` index signature additionally makes `log.metadata` a tsc
  compile error, caught by npm run type-check.
- **Effort:** M

### APA-360 [MEDIUM] Search is doubly broken: uuid ILIKE would raise a DB error that the service converts into a silent empty result

- **Status:** DESIGNED (brief)
- **Symptom:** Beyond the 400 from forbidNonWhitelisted, the search SQL includes 'audit.entityId
  ILIKE :search' on a uuid column — Postgres has no uuid~~\*text operator, so the query would error;
  query()'s catch block then returns {data:[],total:0} with HTTP 200, and the page shows 'No audit
  logs found'. The same catch swallows ANY DB failure into an empty page (silent failure on a
  compliance surface). The search also never matches performedByEmail despite the placeholder
  'Search by user...'.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.service.ts:178-188 (entityId ILIKE), 199-211 (catch returns empty page)`
  - `apps/admin-api-service/src/audit/audit.entity.ts:100-101 (entityId uuid)`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:508-509 (placeholder promises user search)`
- **Root cause:** Two co-located defects in AuditLogService.query()
  (apps/admin-api-service/src/audit/audit.service.ts). (1) The search predicate applies
  `audit.entityId ILIKE :search` to a `uuid`-typed column (audit.entity.ts:100). Postgres has no
  `uuid ~~* text` operator, so the statement fails at plan time on EVERY search request, regardless
  of rows. (2) The query() try/catch (lines 199-211) converts ANY DB failure into
  `{data:[],total:0}` returned with HTTP 200 — a defensive swallow that CLAUDE.md explicitly forbids
  and that silently masks failures on a compliance surface (page shows 'No audit logs found'). (3)
  The predicate omits performedByEmail/performedBy, so the FE placeholder 'Search by user...'
  (AuditLogPage.tsx:509) is a false promise. Note: a sibling p3 finding covers the
  forbidNonWhitelisted 400 on `@Query() pagination` — that 400 currently short-circuits before the
  SQL runs, but this uuid/swallow defect is latent and surfaces the moment the query DTO is fixed,
  so it must be fixed at the same source. This is an instance of the systemic 'silent-catch that
  swallows errors into an empty result' anti-pattern.
- **Fix design:** Root-cause both at source. (a) Make the search type-correct AND honor the FE
  contract: change the predicate to
  `(audit.action ILIKE :search OR audit.entityType ILIKE :search OR CAST(audit.entityId AS text) ILIKE :search OR audit.performedByEmail ILIKE :search)`.
  The explicit CAST(...AS text) resolves the operator against text (tier-1: eliminates the type
  mismatch), and adding performedByEmail makes 'search by user' actually work. (b) Delete the
  try/catch in query() that returns an empty page — let the exception propagate to the global
  exception filter so a real DB error becomes a 5xx the operator can see, not a fabricated empty
  result (tier-3: failures become detectable). Do NOT keep the swallow as a fallback.
- **Files to change:**
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `apps/admin-api-service/src/audit/__tests__/audit.service.spec.ts`
- **Effort:** S

### APA-361 [LOW] Table column sort flags are cosmetic and CSV export omits tenant/metadata columns

- **Status:** DESIGNED (brief)
- **Symptom:** Columns are marked sortable but no sort parameter is ever sent (backend orders
  createdAt DESC only; PaginationQueryDto sortBy is ignored by AuditLogService). The CSV includes 7
  columns and drops tenantId, userAgent and details even for the rows it does fetch. CSV cell
  escaping/formula-injection protection is present and correct.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx:377-436 (sortable flags, no sort wiring), 352-361 (CSV columns)`
  - `apps/admin-api-service/src/audit/audit.service.ts:122-124 (fixed ORDER BY)`
- **Root cause:** Sort is cosmetic end-to-end. AuditLogPage.tsx columns (lines 377-421) set
  `sortable:true` on createdAt/action/entityType/performedByEmail/severity, but the page never wires
  an onSort handler nor sends a sort param; the controller (audit.controller.ts:71-75) passes only
  page/limit into query(); and AuditLogService.query() hardcodes
  `.orderBy('audit.createdAt','DESC')` (line 124), ignoring PaginationQueryDto.sortBy/sortOrder —
  which DO exist on the DTO (pagination-query.dto.ts:18-24) but are read by no one. So the UI
  advertises a capability the backend never applies (a lie to the user). Separately, the CSV export
  (lines 352-361) projects a fixed 7 columns and drops tenantId, userAgent, and details even though
  those fields are on the fetched AuditLog rows — an incomplete compliance export. (CSV cell
  escaping/formula-injection guard via escapeCsvCell is present and correct.)
- **Fix design:** Make sort real and safe, or remove the flags — prefer real. Backend: give
  AuditLogService.query() a column allowlist (map sortBy -> a whitelisted physical column, default
  createdAt) and apply `.orderBy(allowlistedColumn, sortOrder)` with createdAt DESC as the
  tiebreaker; constrain PaginationQueryDto.sortBy from free `@IsString()` to
  `@IsIn([...sortable columns])` so an unknown/injection column is rejected at validation (tier-1:
  raw column interpolation becomes impossible). Controller: forward pagination.sortBy/sortOrder into
  query(). FE: pass the active sort column+direction as query params on header click. CSV: add
  tenantId, userAgent, and details (JSON.stringify, escaped) to the header row and each row so the
  export matches the data actually fetched. If product decides sort is out of scope, the alternative
  is dropping `sortable:true` — but leaving decorative flags is not acceptable.
- **Files to change:**
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts`
  - `web/modules/admin-panel/src/pages/AuditLogPage.tsx`
  - `apps/admin-api-service/src/audit/__tests__/audit.service.spec.ts`
- **Effort:** M

## Cross-cutting findings

### APA-362 [HIGH] Service-wide footgun: mixing named @Query params with an un-named @Query() PaginationQueryDto 400s every filtered list under the global forbidNonWhitelisted pipe

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The pattern found on the audit endpoint is repeated across admin-api:
  support/controllers/ticket.controller.ts (6 handlers) and billing/billing.controller.ts (3
  handlers) combine filter @Query('x') params with '@Query() pagination?: PaginationQueryDto'. Under
  the shared bootstrap's ValidationPipe (whitelist + forbidNonWhitelisted, no admin-api overrides)
  the whole query object is validated against the 4-property DTO, so any filter/search/status query
  param on those endpoints is rejected with 400. Architectural fix: give each endpoint a real query
  DTO containing its filters (or extend PaginationQueryDto per-resource) so the type system matches
  the wire contract — do not relax the pipe.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.controller.ts:42-54`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts:170,201,236,249,357,397`
  - `apps/admin-api-service/src/billing/billing.controller.ts:433,468,538`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-489`
  - `apps/admin-api-service/src/shared/pagination-query.dto.ts:4-25`
- **Verification:** Confirmed and reachable. main.ts bootstraps admin-api via the shared
  bootstrapService with NO validationPipeOverrides/customValidationPipe, so configureValidationPipe
  (create-service-app.ts:458-489) installs the defaults whitelist:true + forbidNonWhitelisted:true;
  app.module.ts has no APP_PIPE override (grep empty). PaginationQueryDto declares only
  page/limit/sortBy/sortOrder. In NestJS an un-named @Query() binds the ENTIRE req.query and
  validates it against its metatype (PaginationQueryDto); the co-located keyed
  @Query('action'|'status'|'search'|...) values are present in that object but are non-whitelisted,
  so forbidNonWhitelisted throws 400. The FE demonstrably serializes these filters onto the wire
  (auditApi.query sends action/entityType/.../search; supportApi.getTickets sends
  status/priority/category/assignedTo/tenantId/search; billing custom-plans sends
  tenantId/status/tier/search via buildQueryString), so any filtered list 400s. No test catches it:
  the billing controller spec (billing.controller.spec.ts:227) boots the identical production pipe
  but only tests POST/PUT custom-plans, never GET /billing/custom-plans?status=..., and there is no
  audit/ticket filtered-GET test at all. This is a systemic contract-drift CLASS (wire sends filters
  the bound DTO does not declare), not a one-off. Two evidence nuances that do NOT change the
  verdict: (a) NestJS version is v11 — behavior is unchanged; (b) three of the cited lines are
  pure-pagination endpoints that bind only @Query() pagination with no keyed filter (ticket
  getUnassignedTickets:201, billing getTenantRedemptions:433, getModulePricingHistory:468) and
  therefore do NOT break — the genuinely-broken set is 7 handlers (audit queryAuditLogs; ticket
  getAllTickets/getTicketsForTenant/getAssignedTickets/getComments/getReplies; billing
  listCustomPlans). HIGH stands: the primary filtered-list usage of the audit trail (a SUPER_ADMIN
  compliance/security surface), the support-ticket workflow, and custom-plan browsing all 400 on the
  most common interaction, with zero regression coverage. Not CRITICAL — it is a clean 400 with no
  data corruption or auth bypass, and the unfiltered base list still works.
- **Root cause:** Contract drift at the FE->BE link: the frontend sends per-resource filter query
  params, but the controllers bind those params two contradictory ways at once — individual filters
  via keyed @Query('x') AND the whole query object via an un-named @Query() pagination?:
  PaginationQueryDto. Because NestJS validates the un-named @Query() against its full metatype and
  the platform pipe runs forbidNonWhitelisted:true, PaginationQueryDto (which knows only
  page/limit/sortBy/sortOrder) becomes the de-facto allow-list for the ENTIRE query string, so every
  declared filter is rejected as an unknown property. The type/validation contract (a
  pagination-only DTO) never matched the wire contract (pagination + filters), and nothing forced
  them to agree.
- **Fix design:** Tier-1 (make the wrong shape impossible) at each callsite + Tier-3 (make the class
  detectable) for the pattern. Local fix: for every filtered list endpoint, replace the split "keyed
  @Query('x') scalars + un-named @Query() PaginationQueryDto" with a SINGLE per-resource query DTO
  that `extends PaginationQueryDto` and declares every filter as a validated @IsOptional() property,
  bound once as `@Query() query: XxxQueryDto`. Then the DTO's declared properties ARE the wire
  contract exactly: whitelist strips nothing legitimate and forbidNonWhitelisted only rejects
  genuinely-unknown keys, and it is structurally impossible for a filter to be absent from the
  validated DTO because there is exactly one binding and it is the DTO. Concretely: (1)
  AuditLogQueryDto extends PaginationQueryDto { action, entityType, entityId, tenantId, performedBy,
  search: @IsOptional()@IsString(); severity: @IsOptional()@IsEnum(AuditSeverity);
  startDate,endDate: @IsOptional()@IsISO8601() } used by queryAuditLogs, building AuditLogFilter +
  page/limit from it. (2) In support: TicketListQueryDto
  (status,priority,category,assignedTo,tenantId,search + date range), TicketScopeQueryDto (status)
  for getTicketsForTenant/getAssignedTickets, TicketCommentsQueryDto
  (includeInternal:@IsOptional()@IsString() to preserve the current `!== 'false'` semantics) for
  getComments/getReplies — each extending PaginationQueryDto. (3) In billing: CustomPlanQueryDto
  extends PaginationQueryDto { tenantId, status:@IsEnum(CustomPlanStatus), tier:@IsEnum(PlanTier),
  search } for listCustomPlans. Co-locate each DTO in the owning domain per the layer rules
  (audit/dto/, support/dto/, billing/dto/). Do NOT relax the pipe or add per-controller overrides.
  Pattern-level (Tier-3, because this is a recurring class): add an architecture/invariant spec that
  reflects over the route-arg metadata of all admin-api controllers and FAILS if any single handler
  has BOTH a keyed @Query('...') parameter AND an un-named @Query() parameter — forbidding the
  mixed-binding anti-pattern outright so the class cannot be reintroduced. Establish the convention
  explicitly: filtered list endpoints bind exactly one @Query() DTO that extends PaginationQueryDto.
- **Files to change:**
  - `apps/admin-api-service/src/audit/audit.controller.ts`
  - `apps/admin-api-service/src/audit/dto/audit-log-query.dto.ts`
  - `apps/admin-api-service/src/support/controllers/ticket.controller.ts`
  - `apps/admin-api-service/src/support/dto/ticket-query.dto.ts`
  - `apps/admin-api-service/src/billing/billing.controller.ts`
  - `apps/admin-api-service/src/billing/dto/custom-plan-query.dto.ts`
  - `apps/admin-api-service/src/__tests__/query-dto-contract.architecture.spec.ts`
  - `apps/admin-api-service/src/billing/__tests__/billing.controller.spec.ts`
  - `apps/admin-api-service/src/audit/__tests__/audit.controller.spec.ts`
- **Proof of fix:** Two gates. (1) Behavioral, per resource: extend
  apps/admin-api-service/src/billing/**tests**/billing.controller.spec.ts and add
  apps/admin-api-service/src/audit/**tests**/audit.controller.spec.ts + a support ticket controller
  spec, each booting the app with the SAME production ValidationPipe ({ whitelist:true,
  forbidNonWhitelisted:true, transform:true }) and asserting the filtered GETs now return 200
  (currently 400): GET /audit-logs?action=LOGIN&entityType=User&severity=HIGH&search=x; GET
  /support/tickets?status=OPEN&priority=HIGH&search=x; GET
  /billing/custom-plans?status=active&tier=pro&search=x. Also assert a genuinely-unknown key (e.g.
  ?bogus=1) still 400s, proving the pipe was not weakened. (2) Class prevention: add
  apps/admin-api-service/src/**tests**/query-dto-contract.architecture.spec.ts that enumerates every
  admin-api controller handler via Nest route-arg reflection metadata and asserts NO handler
  simultaneously declares a keyed @Query('x') param and an un-named @Query() param — this fails
  today on the 7 mixed handlers and stays green only once each is converted to a single @Query()
  DTO.
- **Effort:** M

### APA-363 [HIGH] Admin 'configuration' is split across three disconnected stores; the admin panel writes the one nothing reads

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** Runtime behavior comes from env vars (SystemSettingService, EmailSenderService,
  notification-service EmailService, gateway IpWhitelistGuard); the admin panel writes
  config-service rows (config.configurations) that only billing-service consumes; and the legacy
  admin.system_settings store is dropped with its endpoints returning 410. For email/SMTP
  specifically there are two independent senders (admin-api EmailSenderService and
  notification-service EmailService), both env-configured, neither reading either the saved
  config-service SMTP settings or the admin.email_templates content. Until the remaining services
  adopt the ConfigClientModule pattern billing-service already uses (and notification-service reads
  admin/email templates or owns them), the settings and email-template pages are administrative
  theater.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts:160-183,343-358`
  - `apps/notification-service/src/notification/services/email.service.ts:120-160`
  - `apps/billing-service/src/billing/billing.module.ts:9,95-98 (the working precedent)`
  - `apps/admin-api-service/src/settings/entities/system-setting.entity.ts:39-47 (410/dropped-store note)`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts:87-99`
- **Verification:** Verified against real wiring. (1) admin-api SystemSettingService reads env only;
  every write path returns 410 Gone; legacy admin.system*settings dropped (entity note + migration
  1801400000000). (2) The SUPER_ADMIN settings page writes config.configurations via FE
  platform-configuration.ts write builders (email.*, security._, rate_limit._, maintenance._,
  billing._) through federated GraphQL (settings.ts comment confirms ORPHAN-HIGH-373 rewrite). (3)
  The ONLY runtime read surface for config-service is ConfigRuntimeNatsHandler gated by
  CONFIG*RUNTIME_SECRET_ALLOWLIST/NONSECRET_ALLOWLIST
  (libs/event-contracts/src/config-runtime.ts:85-96) — the SSoT admits exactly one caller,
  billing-service, reading exactly 3 keys (billing.stripe_enabled/public_key/secret_key). No
  email.*/security._/rate_limit._ key has any runtime reader; grep for those keys under a
  config-runtime consumer returns nothing. (4) Runtime email sending is env-driven twice over:
  admin-api EmailSenderService→SystemSettingService.getEmailConfigForSending()→env;
  notification-service EmailService→ConfigService→env, with hardcoded inline HTML.
  admin.email_templates (EmailTemplateService) is consumed only by its own CRUD/preview controller —
  no sender renders it. (5) gateway IpWhitelistGuard reads env (IP_WHITELIST\*, TRUSTED_PROXIES),
  not admin.ip_access_rules. So an operator saving SMTP/security/rate-limit/IP settings sees success
  while runtime behavior is unchanged — administrative theater with security implications (a
  believed-enforced password policy / MFA / SMTP relay is a silent no-op). Umbrella finding: the
  ConfigClientModule read pattern exists but was wired for billing only. Not CRITICAL (no direct
  breach/priv-esc), but a real integrity/trust gap → HIGH.
- **Root cause:** The FE→config-service WRITE path was migrated (ORPHAN-HIGH-373: legacy
  admin.system*settings retired, writes 410, reads static env stubs) but the READ side was only ever
  wired for billing-service. billing adopted the ConfigClientModule/ConfigRuntimeClient primitive
  and registered its keys in CONFIG_RUNTIME*\*\_ALLOWLIST; the other consumers
  (admin-api/notification-service email senders, gateway IP guard, and whatever enforces
  security/rate-limit policy) were never migrated off env vars. The chain broke at the 'remaining
  services adopt the config-client pattern' step — done for exactly one consumer and left
  incomplete. There is no detection that a written config key has zero runtime readers, so the
  settings page can ship tabs whose rows land in config.configurations and are read by nobody.
- **Fix design:** Pattern-level fix (Tier 2 automatic + Tier 3 detectable); per-consumer detail
  lives in this section's per-instance findings.

1. Extend the billing ConfigClientModule/ConfigRuntimeClient precedent to the remaining REAL
   consumers, adding each read key to the CONFIG*RUNTIME*\*\_ALLOWLIST SSoT
   (libs/event-contracts/src/config-runtime.ts) with matching services.yaml publish grants +
   regenerated nats.conf:

- email: consolidate admin-api EmailSenderService + notification-service EmailService onto one path
  reading platform/email.\* (incl. the email.smtp_password secret), env as fallback;
  notification-service renders admin.email_templates (or owns them) so the template page stops being
  theater.
- gateway IpWhitelistGuard reads platform/ip_whitelist.\* (or consumes admin.ip_access_rules) via
  the same client.
- security/rate-limit enforcers (auth lockout, gateway limiter) read platform/security._ /
  rate_limit._.

2. Tier-3 gate that makes 'config nobody reads' impossible to ship: a new invariant enumerates every
   key the FE write builders emit
   (buildEmailWrites/buildSecurityWrites/buildRateLimitWrites/buildGeneralWrites in
   platform-configuration.ts) and asserts each has a declared runtime consumer in
   CONFIG*RUNTIME*\*\_ALLOWLIST (or an explicit consumer registry). A settings tab then cannot exist
   without a reader.

This closes the FE→config-service→consumer loop at the SSoT and prevents regression, rather than
patching any single sender.

- **Files to change:**
  - `libs/event-contracts/src/config-runtime.ts`
  - `apps/admin-api-service/src/settings/services/email-sender.service.ts`
  - `apps/admin-api-service/src/settings/services/system-setting.service.ts`
  - `apps/notification-service/src/notification/services/email.service.ts`
  - `apps/notification-service/src/notification/notification.module.ts`
  - `apps/gateway-api/src/guards/ip-whitelist.guard.ts`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `web/modules/admin-panel/src/services/api/platform-configuration.ts`
  - `e2e/tests/integration/config-consumer-coverage.spec.ts`
- **Proof of fix:** Add e2e/tests/integration/config-consumer-coverage.spec.ts: import the FE
  write-builder key set
  (buildEmailWrites/buildSecurityWrites/buildRateLimitWrites/buildGeneralWrites) and assert every
  emitted key appears as a consumed key in
  CONFIG*RUNTIME_NONSECRET_ALLOWLIST/CONFIG_RUNTIME_SECRET_ALLOWLIST (or a declared consumer
  registry) — fails today (email.*/security._/rate_limit._ unread), passes once consumers are wired.
  Extend nats-invariants.spec.ts so each new allowlisted caller holds a config.runtime.\_ publish
  grant. Per-consumer integration tests (mock ConfigRuntimeClient) prove EmailSenderService,
  notification EmailService, and IpWhitelistGuard read config-service values and fall back to env
  when config is unreachable; a notification-service test proves admin.email_templates render into a
  sent email. Detailed per-consumer tests are carried by this section's per-instance findings.
- **Effort:** L

### APA-364 [MEDIUM] Settings-module CRUD DTOs are TypeScript interfaces, so the global ValidationPipe validates nothing on those bodies

- **Status:** DESIGNED (brief)
- **Symptom:** CreateEmailTemplateDto/UpdateEmailTemplateDto/RenderTemplateDto and
  CreateIpAccessRuleDto/UpdateIpAccessRuleDto are interfaces exported from services; their runtime
  metatype is Object so whitelist/forbidNonWhitelisted/type validation are all skipped. Only
  CheckIpAccessDto/BulkIpDto/TestEmailConfigDto and the settings-controller config DTOs are real
  class-validator classes. SUPER_ADMIN-only exposure lowers the risk, but it contradicts the
  platform's own validation standard and lets malformed jsonb (variables), unbounded HTML bodies,
  and junk enum values reach the DB.
- **Evidence:**
  - `apps/admin-api-service/src/settings/services/email-template.service.ts:20-49`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts:17-31`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts:26-46 (contrast: validated classes)`
  - `apps/admin-api-service/src/settings/settings.controller.ts:42-88 (contrast: validated classes)`
- **Root cause:** Systemic 'unvalidated interface-DTO' class.
  CreateEmailTemplateDto/UpdateEmailTemplateDto/RenderTemplateDto (email-template.service.ts:20-49)
  and CreateIpAccessRuleDto/UpdateIpAccessRuleDto (ip-access.service.ts:17-31) are TypeScript
  INTERFACES. They erase at runtime, so the `@Body()` params in email-template.controller.ts (lines
  88, 98, 132) and ip-access.controller.ts (lines 109, 125) have design-time metatype `Object`.
  NestJS ValidationPipe's `toValidate()` returns false for Object/native types, so whitelist:true,
  forbidNonWhitelisted:true and transform are ALL skipped for those bodies — the platform's own
  validation standard is silently a no-op. Result: malformed jsonb `variables`, unbounded
  `bodyHtml`, junk `category`/`ruleType` enum values, and non-UUID `tenantId` reach the DB.
  (ip-access has partial service-level `isValidIpOrCidr` on ipAddress, but
  ruleType/tenantId/expiresAt/description are unchecked; email-template has no validation at all.)
  Contrast: CheckIpAccessDto/BulkIpDto and the dto/email-template.dto.ts classes
  (CreateTenantOverrideDto/ValidateTemplateDto/SendTestEmailDto) ARE validated classes — proving the
  fix pattern already exists in the same module.
- **Fix design:** Local: promote the five interfaces to class-validator classes in the existing dto/
  dir (extend dto/email-template.dto.ts with Create/Update/RenderTemplateDto; add
  dto/ip-access-rule.dto.ts with Create/UpdateIpAccessRuleDto). Use @IsString/@MaxLength for
  code/subject/bodyHtml, @IsEnum(SettingCategory)/@IsIn(['whitelist','blacklist']) for
  category/ruleType, @IsUUID('4') for tenantId, @IsBoolean for isActive, @IsDate for expiresAt, and
  — stronger than the current override DTO — a real EmailTemplateVariable class with
  @ValidateNested()+@Type() for the variables array so the jsonb shape is enforced. Services import
  these classes (keep the \*Response interfaces as-is); controllers reference the classes so
  ValidationPipe engages. Pattern-level (tier-3, prevents the whole class regressing): add an
  architecture invariant test that reflects over every admin-api controller's route params and
  asserts each `@Body()` metatype is a class carrying class-validator metadata (never
  Object/interface). That gate catches the next interface-typed body at CI time rather than
  per-instance.
- **Files to change:**
  - `apps/admin-api-service/src/settings/dto/email-template.dto.ts`
  - `apps/admin-api-service/src/settings/dto/ip-access-rule.dto.ts`
  - `apps/admin-api-service/src/settings/services/email-template.service.ts`
  - `apps/admin-api-service/src/settings/services/ip-access.service.ts`
  - `apps/admin-api-service/src/settings/controllers/email-template.controller.ts`
  - `apps/admin-api-service/src/settings/controllers/ip-access.controller.ts`
  - `apps/admin-api-service/src/__tests__/e2e/controller-body-dto-validation.architecture.spec.ts`
- **Effort:** M

### APA-365 [NOT_A_BUG] Auth/guard coverage verified — no unguarded endpoints in this section

- **Status:** REFUTED
- **Symptom:** PlatformAdminGuard is registered as a global APP*GUARD in admin-api (RS256
  verifyAsync with issuer/audience, access-token-type enforcement, SUPER_ADMIN role required by
  default, decorators can only narrow, never widen); none of the
  settings/email-template/ip-access/audit controllers carry @Public. ThrottlerGuard is also global
  and sensitive settings mutations add @ThrottleSensitive. Every FE call in this section requires a
  SUPER_ADMIN bearer token; nginx rewrites /api/* to the versioned /api/v1/\_ prefix so all audited
  FE paths resolve to real routes (method+path verified).
- **Evidence:**
  - `apps/admin-api-service/src/app.module.ts:277-290 (APP_GUARD wiring)`
  - `apps/admin-api-service/src/guards/platform-admin.guard.ts:78-179`
  - `infrastructure/nginx/droplet.conf:377-399 (rewrite ^/api/(.*) /api/v1/$1)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:603-611 (globalPrefix 'api/v1')`
- **Refutation (brief check):** This entry is a verification result, not a defect. Re-reading the
  cited files confirms the claim: PlatformAdminGuard is wired as a global APP_GUARD in
  app.module.ts, verifies RS256 with issuer/audience + access-token-type and requires SUPER_ADMIN by
  default (guards/platform-admin.guard.ts), and none of the settings/email-template/ip-access/audit
  controllers carry @Public (they annotate no auth-widening decorators; audit/ip-access mutations
  add throttling). nginx rewrites /api/(.\*) -> /api/v1/$1 (droplet.conf) onto globalPrefix
  'api/v1', so every audited FE path resolves to a real guarded route. There is nothing to fix.
