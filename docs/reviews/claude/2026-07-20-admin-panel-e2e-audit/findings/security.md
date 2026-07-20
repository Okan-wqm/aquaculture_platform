# Security Pages — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## ActivityLogPage — `/admin/security/activity` — verdict: **PARTIAL**

**Chain:** Page -> securityApi.getActivityLogs/getActivityStatsOverview -> GET /api/security/activities + /security/activities/stats/overview (nginx droplet.conf:377-382 rewrites /api/* to /api/v1/*, matching admin-api globalPrefix 'api/v1' from libs/backend-common/src/bootstrap/create-service-app.ts:610 + VERSION_NEUTRAL in apps/admin-api-service/src/main.ts:16-19) -> ActivityLogController -> ActivityLoggingService.queryActivities/getActivityStats -> real TypeORM queries against admin.activity_logs (entity security.entity.ts:145, table created in migrations/1800000000000-Baseline.ts:116-124). Guarded by global PlatformAdminGuard (SUPER_ADMIN, app.module.ts:277-290). The query chain is mechanically sound, but NOTHING in the platform ever writes admin.activity_logs, so the page is a permanently empty monitoring surface.

**Endpoints exercised:** `GET /security/activities (v1, envelope-wrapped)`; `GET /security/activities/stats/overview`; `GET /security/activities/:id (defined in FE, unused by page)`; `GET /security/activities/user/:userId (FE function targets a route that does not exist on the backend)`

**DB tables:** `admin.activity_logs`

### APA-217 [HIGH] Activity ledger has zero writers — page is permanent false assurance

- **Status:** CONFIRMED+DESIGNED (audited CRITICAL → verified HIGH)
- **Symptom:** admin.activity_logs is only ever written via POST /security/activities (activity-log.controller.ts:283-288), which sits behind the global SUPER_ADMIN PlatformAdminGuard, so no platform service can feed it. All internal writers (logActivity, logUserAction, logSystemEvent, logConfigurationChange, logDataAccess, recordLoginAttempt, logApiUsage) are defined in ActivityLoggingService but have no callers anywhere in the repo (grep across apps/ and libs/ finds only the definitions); ComplianceService.logComplianceActivity is an explicit stub that only writes to the NestJS Logger ('Would integrate with ActivityLoggingService'). A SUPER_ADMIN opening 'Monitor all system activities, user actions, and security events' sees an empty ledger and zero stats regardless of what actually happened on the platform.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:130-178,222-499 (writers defined, never invoked)`
  - `apps/admin-api-service/src/security/services/compliance.service.ts:1000-1006 (logComplianceActivity stub)`
  - `apps/admin-api-service/src/security/controllers/activity-log.controller.ts:283-288 (only external write path)`
  - `apps/admin-api-service/src/app.module.ts:277-290 (global SUPER_ADMIN guard blocks service-to-service writes)`
  - `apps/admin-api-service/src/security/security.module.ts:40-82 (no event-bus consumer; grep for EventPattern/subscribe in security/ returns nothing)`
- **Verification:** CONFIRMED on every count. (1) The only runtime write path to admin.activity_logs is POST /security/activities (apps/admin-api-service/src/security/controllers/activity-log.controller.ts:283-288), which sits behind the global APP_GUARD PlatformAdminGuard (apps/admin-api-service/src/app.module.ts:283-290); the guard's sole bypass is the @Public() decorator (platform-admin.guard.ts:55,80-87), not present on this controller, and there is no service-identity/HMAC path — so only a human SUPER_ADMIN JWT holder can write, and repo-wide grep for 'security/activities' shows zero service-side callers (only FE reads + docs). (2) All internal writers (logActivity, logUserAction, logSystemEvent, logConfigurationChange, logDataAccess, recordLoginAttempt, logApiUsage, createSession, updateSessionActivity) have zero callers anywhere in apps/ or libs/ — ActivityLoggingService is injected only into ActivityLogController; other grep hits (tenant-activity.service.ts, alert-audit.service.ts) are different classes. (3) ComplianceService.logComplianceActivity (compliance.service.ts:1000-1006) is a Logger-only stub ('Would integrate with ActivityLoggingService'). (4) The security module registers no event subscription; admin-api's only consumers are tenant-erasure and tenant-onboarding-ack handlers. (5) The table exists in the active baseline (src/migrations/1800000000000-Baseline.ts:116-124) and its ONLY insert anywhere is the demo seed infrastructure/sql/seed-security-tables.sql:87 (referenced by no runtime code) — which masked the emptiness in dev. login_attempts and user_sessions read endpoints on the same page are equally writer-less. SEVERITY LOWERED CRITICAL→HIGH: this is a false-assurance/security-monitoring failure (OWASP A09 class), not an exploitable path or data loss — the platform's durable security signals DO exist elsewhere (auth.audit_logs is the documented SoT for login telemetry per apps/auth-service/src/outbox/best-effort-event-publisher.ts:52; observability-service consumes events.security.events.> into structured logs + Prometheus; admin.audit_logs feeds the separate AuditTrail page). The harm is that the operator-facing activity/brute-force surface silently shows nothing during a real incident.
- **Root cause:** The write side of the FE→BE→DB chain was never built: the ledger was designed read-side-first around a push-HTTP ingestion contract ('external services POST /security/activities') that is structurally unreachable — admin-api's global SUPER_ADMIN guard means no platform service can ever call it, and none does. The platform's real security-signal pipeline was built separately on the event bus (SecurityEventService publishing the typed SecurityEvent union on events.security.events.> from auth/config/billing/gateway, plus auth-service's UserLoggedIn event at authentication.service.ts:498) but was wired only to observability-service (Prometheus counters + structured logs, no queryable persistence), never to admin's ledger. Dev seed data (infrastructure/sql/seed-security-tables.sql) populated the tables manually, so the dead pipeline was invisible in development. This is an instance of the systemic 'read-model-table-nobody-writes' class (sibling of config-table-nobody-reads): a queryable surface shipped with its ingestion contract asserted but never proven by any test.
- **Fix design:** Pattern-level fix: security-activity ingestion becomes event-driven from the platform event bus (the existing SSoT for cross-service security signals) instead of push-HTTP into a guard-protected API; the dead push contract is deleted so the wrong pattern becomes impossible (Tier 1), and correct ingestion becomes automatic on every published security event (Tier 2). Local application: (a) New SecurityActivityIngestionHandler in SecurityModule: a durable NatsEventBus.subscribeTo('events.security.events.>', {durable:true, groupId:'admin-activity-ingest'}) mirroring observability's SecurityEventsConsumerService wiring, plus @EventPattern('events.*.UserLoggedIn') / 'events.*.UserAccountLocked' / 'events.*.PasswordResetCompleted' / 'events.*.UserDeleted' handlers following the existing tenant-onboarding-ack.handler pattern (admin-api's NATS microservice transport is already connected). (b) A mapSecurityEventToActivity(event: SecurityEvent): LogActivityParams mapping implemented as an exhaustive switch on the eventType discriminator with an assertNever default — adding a new member to the SecurityEvent union fails compilation in admin-api until mapped (Tier 1 contract binding, no allowlist drift). AuthLoginFailed/AuthLoginSuccess additionally route through recordLoginAttempt so admin.login_attempts (the brute-force view on the same page) gains a real writer. (c) Delete POST /security/activities + LogActivityDto from activity-log.controller.ts — its stated purpose ('for external services') is structurally impossible under the global guard; keeping it preserves the fiction (FE never calls it, verified). (d) Replace the ComplianceService.logComplianceActivity stub with real injection of ActivityLoggingService (same module, already exported) so compliance actions write the ledger. (e) Strip the fake activity_logs/login_attempts/user_sessions demo rows from infrastructure/sql/seed-security-tables.sql (keep retention policies) so an empty ingestion pipeline is visible in dev instead of masked (Tier 3). (f) Systemic-class gate: a new architecture spec enumerating admin read-model tables surfaced by GET controllers and asserting each has a registered production writer (event-consumer registration or in-module service caller), so the next read-only ledger fails CI instead of shipping as false assurance.
- **Files to change:**
  - `apps/admin-api-service/src/security/handlers/security-activity-ingestion.handler.ts`
  - `apps/admin-api-service/src/security/security.module.ts`
  - `apps/admin-api-service/src/security/controllers/activity-log.controller.ts`
  - `apps/admin-api-service/src/security/services/compliance.service.ts`
  - `apps/admin-api-service/src/security/__tests__/security-activity-ingestion.handler.spec.ts`
  - `apps/admin-api-service/src/__tests__/read-model-writers.architecture.spec.ts`
  - `e2e/tests/integration/activity-ledger-ingestion.spec.ts`
  - `infrastructure/sql/seed-security-tables.sql`
- **Proof of fix:** New unit spec apps/admin-api-service/src/security/__tests__/security-activity-ingestion.handler.spec.ts: a fixture for every member of the SecurityEvent union plus UserLoggedIn/UserAccountLocked/PasswordResetCompleted/UserDeleted asserts the handler calls ActivityLoggingService.logActivity (and recordLoginAttempt for login success/failure) with correctly mapped category/severity/ip/userId fields; compile-time exhaustiveness via assertNever guarantees future union members cannot ship unmapped. New integration spec e2e/tests/integration/activity-ledger-ingestion.spec.ts: publish an AuthLoginFailed event on NATS, assert a row lands in admin.activity_logs AND admin.login_attempts and is returned by GET /security/activities and /stats/overview through the envelope. New architecture invariant apps/admin-api-service/src/__tests__/read-model-writers.architecture.spec.ts: asserts every admin-owned ledger table exposed by a GET controller has a registered writer (ingestion handler subscription or in-module caller) and that POST /security/activities no longer exists — the CI gate for the systemic 'table-nobody-writes' class.
- **Effort:** M

### APA-218 [MEDIUM] 'Unique Users' / 'Unique IPs' stat cards are silently capped at 10

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** The page derives uniqueUsers/uniqueIps from stats.topUsers.length and stats.topIPs.length, but the backend caps both arrays with SQL LIMIT 10. Any deployment with more than 10 users/IPs shows a flat, wrong '10'.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/ActivityLogPage.tsx:152-153`
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:781-807 (.limit(10) on topUsers and topIPs)`
- **Verification:** CONFIRMED with one scope correction. FE ActivityLogPage.tsx:152-153 derives uniqueUsers/uniqueIps from stats.topUsers.length / stats.topIPs.length. The call path is fully wired and reachable: securityApi.getActivityStatsOverview() -> apiFetch('/security/activities/stats/overview') -> nginx /api->/api/v1 -> @Controller('security/activities') @Get('stats/overview') (route-shadowing check passed: the earlier @Get(':id') matches only one path segment, so stats/overview reaches the stats handler). Backend getActivityStats() caps both topUsers and topIPs with .limit(10) (activity-logging.service.ts:793,806), and the backend ActivityStats interface (lines 79-88) contains no cardinality field at all — the true unique counts are never computed or returned. The 'Unique Users' card renders stats.uniqueUsers at line 610, so any deployment with >10 distinct active users (guaranteed for a cross-tenant SUPER_ADMIN panel) shows a flat wrong '10'. Refutation partially succeeded on scope: there is NO 'Unique IPs' stat card — the four rendered cards are Total Activities, Unique Users, Avg Response, Error Rate; uniqueIps is computed into state but never rendered (latent wrong data only). Severity corrected HIGH->MEDIUM: this is misleading security telemetry on a monitoring page (degrades operator situational awareness) but involves no data exposure, no authz bypass, no exploit path. Same-class adjacent defect on the neighboring line: averageResponseTime is hard-coded to 0 (line 154), so the 'Avg Response' card is equally fabricated — same contract-gap class on the same endpoint.
- **Root cause:** FE->BE contract gap papered over in the FE mapping layer. The backend ActivityStats contract was designed as a leaderboard response (top-10 actions/users/IPs) and never included cardinality aggregates; when the FE card design needed 'Unique Users'/'Unique IPs', the page's mapping function improvised by reinterpreting a SQL LIMIT 10 leaderboard as a cardinality measure. The type system could not catch this because both are plain numbers legitimately derived from typed arrays — the semantics drifted, not the types. This is an instance of the systemic hand-written FE mirror-type drift class: ActivityStatsOverview in web/modules/admin-panel/src/services/types/security.ts is hand-maintained against the backend's ActivityStats interface with no shared contract or codegen, so nothing prevents the FE from inventing semantics (unique counts, avg response time) the backend never promised.
- **Fix design:** Fix the contract at the source (tier 1: make the wrong derivation unnecessary and remove it; tier 3: pin the semantic distinction in tests). (1) Backend: extend the ActivityStats interface (activity-logging.service.ts:79-88) with `uniqueUsers: number; uniqueIps: number;` and compute them in getActivityStats() via a COUNT(DISTINCT activity.userId) (WHERE userId IS NOT NULL) and COUNT(DISTINCT activity.ipAddress) select honoring the same tenantId/startDate/endDate filters as the existing aggregates — one additional query builder call returning both counts. While in the same contract, add `averageDurationMs: number` (AVG(activity.duration)) to close the identical gap feeding the always-0 'Avg Response' card (same class, same endpoint, same commit). No controller, entity, migration, or query-DTO change needed — the controller returns the service interface and the aggregates read existing columns. (2) FE types: extend ActivityStatsOverview (services/types/security.ts:117-126) with the same required fields, mirroring the backend interface exactly. (3) FE page: in fetchActivityStats (ActivityLogPage.tsx:145-159), map uniqueUsers/uniqueIps/averageResponseTime directly from the response and DELETE the .length derivations and the hard-coded 0 — the mapping becomes near-identity, which is the tier-2 property (correct behavior is the zero-effort default; there is nothing left to hand-derive). (4) Pattern level: the full systemic fix for hand-written FE mirror types is a shared contract package or OpenAPI codegen for admin-panel — a platform-level program beyond this finding; the local detectability gate is a backend contract spec that seeds >10 distinct users/IPs and asserts uniqueUsers/uniqueIps equal the true distinct counts WHILE topUsers/topIPs stay capped at 10, permanently pinning that the leaderboard is not a cardinality measure so the .length shortcut cannot be reintroduced as 'equivalent'.
- **Files to change:**
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts`
  - `web/modules/admin-panel/src/services/types/security.ts`
  - `web/modules/admin-panel/src/pages/security/ActivityLogPage.tsx`
  - `apps/admin-api-service/src/security/__tests__/activity-stats.contract.spec.ts`
  - `web/modules/admin-panel/src/pages/security/__tests__/ActivityLogPage.stats.spec.tsx`
- **Proof of fix:** New spec apps/admin-api-service/src/security/__tests__/activity-stats.contract.spec.ts (London School, @platform/testing repository mocks per repo convention): stub the query builder so 12 distinct users and 12 distinct IPs exist; assert getActivityStats() returns uniqueUsers === 12 and uniqueIps === 12 while topUsers.length === 10 and topIPs.length === 10, and assert the distinct-count query applies the same tenantId/startDate/endDate predicates as the other aggregates. New FE spec web/modules/admin-panel/src/pages/security/__tests__/ActivityLogPage.stats.spec.tsx: stub securityApi.getActivityStatsOverview with uniqueUsers: 42 and a 10-element topUsers array; assert the 'Unique Users' card renders 42 (fails against current code, which renders 10). Both run under nx affected --target=test.
- **Effort:** S

### APA-219 [MEDIUM] 'Avg Response' metric hardcoded to 0ms and rendered as a real stat

- **Status:** PENDING
- **Symptom:** fetchActivityStats sets averageResponseTime: 0 unconditionally; the card shows '0ms' as if measured. Response-time data lives in admin.api_usage_logs, which is also never written.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/ActivityLogPage.tsx:154,614-623`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-220 [MEDIUM] ORDER BY built from unvalidated sortBy query param

- **Status:** PENDING
- **Symptom:** queryActivities interpolates `activity.${sortBy}` directly into orderBy from the request DTO (@IsString only). A bad column name 500s the endpoint and it is a raw-SQL interpolation surface (SUPER_ADMIN-only, but still an injection-shaped hole).
- **Evidence:**
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:661`
  - `apps/admin-api-service/src/security/controllers/activity-log.controller.ts:96-102,249-250`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-221 [MEDIUM] Export button only dumps the current 50-row page client-side

- **Status:** PENDING
- **Symptom:** handleExport builds a CSV from the in-memory page slice; the real backend export (POST /security/audit/export with format/date-range, 100k rows) is never called, so 'Export' silently produces an incomplete artifact.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/ActivityLogPage.tsx:510-533`
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:430-451`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-222 [MEDIUM] securityApi.getUserActivities targets a nonexistent route (404)

- **Status:** PENDING
- **Symptom:** FE defines GET /security/activities/user/:userId but ActivityLogController has no such route (only '', ':id', 'entity/:entityType/:entityId', 'stats/overview', 'login-attempts/:ipAddress', 'sessions/user/:userId'). Latent: not called by this page, but any consumer 404s.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/security.ts:45-46`
  - `apps/admin-api-service/src/security/controllers/activity-log.controller.ts:224-341 (route inventory)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-223 [LOW] FE type invents fields the entity never returns (userAgent, location, timestamp)

- **Status:** PENDING
- **Symptom:** BackendActivityLog declares userAgent/location/timestamp; the ActivityLog entity has none of these top-level (userAgent lives inside deviceInfo jsonb), so the detail modal's User-Agent section and location fallback can never populate from list data.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/security.ts:65-96`
  - `web/modules/admin-panel/src/pages/security/ActivityLogPage.tsx:127,137,409-417`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## AuditTrailPage — `/admin/security/audit` — verdict: **PARTIAL**

**Chain:** Entries tab -> GET /security/audit -> AuditTrailController.queryAuditTrail -> AuditLogService.query -> admin.audit_logs — a REAL immutable ledger with real platform writers (impersonation.service.ts, suspend-tenant.handler.ts, tenant-erasure.handler.ts, tenant-provisioning-workflow.service.ts, database-management explorer/backup, analytics reports all call auditLogService.log), plus a meta-audit written on every read (audit-trail.controller.ts:323-342). Summary -> GET /security/audit/summary -> AuditLogService.getStatistics (real GROUP BY). Retention policies -> admin.retention_policies real CRUD. Alert-rules tab -> in-memory array, no persistence, no enforcement. Core audit view WORKS against real data; filters, alerting, and the management buttons are broken.

**Endpoints exercised:** `GET /security/audit`; `GET /security/audit/summary`; `GET /security/audit/retention-policies`; `GET /security/audit/alert-rules`

**DB tables:** `admin.audit_logs`, `admin.retention_policies`, `admin.activity_logs (retention target)`

### APA-224 [HIGH] Action filter can never match: lowercase FE values vs UPPERCASE backend enum

- **Status:** PENDING
- **Symptom:** The dropdown sends action=create|read|update|delete|login|logout; AuditLogService.query filters with exact equality (audit.action = :action) against AuditAction values like TENANT_CREATED, USER_UPDATED, LOGIN_SUCCESS. Every filtered query silently returns 0 rows — an auditor filtering for deletions concludes none happened. (login/logout doubly so: auth events are written to auth's own ledger, not admin.audit_logs.)
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:695-702`
  - `apps/admin-api-service/src/audit/audit.service.ts:126-128`
  - `apps/admin-api-service/src/audit/audit.entity.ts:9-52`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-225 [HIGH] Alert Rules tab is decorative: in-memory rules, evaluation never runs, channels are stubs

- **Status:** PENDING
- **Symptom:** Rules live in a service-instance array (lost on restart, per-replica divergent); createAlertRule ids are Date.now() strings. The only evaluation path, checkAlerts(), has zero callers in the repo, and triggerAlert only logs 'Would send email alert'/'Would send Slack alert'. The page presents Active rules with recipients (security@company.com) implying real alerting that does not exist — false assurance on a security control.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:94,109-176,871-917,922-938,979-1003`
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:532-564`
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:887-956`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-226 [MEDIUM] DB errors render as clean empty audit data

- **Status:** PENDING
- **Symptom:** AuditLogService.query catches all exceptions and returns {data:[],total:0} with a 200; the page then shows 'No audit entries found' — a DB outage is indistinguishable from a clean ledger on a compliance surface. AuditTrailService.getAuditSummary has the same catch-and-zero pattern ('Return empty summary on error to prevent 500').
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.service.ts:199-211`
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:416-432`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-227 [MEDIUM] Add/Edit/Delete buttons for retention policies and alert rules have no handlers

- **Status:** PENDING
- **Symptom:** 'Add Policy', 'Add Rule', and all Edit2/Trash2 buttons render with no onClick — the management UI is dead even though real backend CRUD endpoints exist (POST/PUT/DELETE /security/audit/retention-policies, /alert-rules).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:823-828,854-861,889-894,922-929`
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:476-523,540-564`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-228 [MEDIUM] Retention Policies tab governs a table the page never shows (and one with no writers)

- **Status:** PENDING
- **Symptom:** Retention policies archive/delete admin.activity_logs (AuditTrailService.applyRetentionPolicy), not the displayed immutable admin.audit_logs — which is explicitly never purged (purgeOldLogs refuses). The tab implies retention control over the audit entries listed next to it; it actually controls the never-written activity ledger. FE mapping also mislabels: archiveBeforeDelete = archiveAfterDays !== undefined is true even when the column is null.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:814-862`
  - `apps/admin-api-service/src/audit/audit.service.ts:463-475`
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:161-174`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-229 [LOW] 'Total Entries' is actually a 30-day count

- **Status:** PENDING
- **Symptom:** GET /security/audit/summary defaults startDate to end-30d, so totalLogs is a 30-day window presented as 'Total Entries'.
- **Evidence:**
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:417-420`
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:143-144,606-611`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-230 [LOW] Alert-rule card renders Invalid Date and fake trigger count

- **Status:** PENDING
- **Symptom:** fetchAlertRules maps createdAt:'' (formatDate('') = Invalid Date) and triggeredCount:0 always ('Triggered: 0 times' regardless of history).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/AuditTrailPage.tsx:176-189,941-950`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## CompliancePage — `/admin/security/compliance` — verdict: **PARTIAL**

**Chain:** Data-requests tab: GET/PUT/POST /security/compliance/data-requests* -> ComplianceService -> admin.data_requests (real table, Baseline migration:140-143), with JWT-derived actor identity (C6 fix) and real verify/reject/complete mutations wired from the modal — this flow genuinely works. Reports tab: POST/GET /security/compliance/reports -> admin.compliance_reports, generation computes from real data-request/incident counts plus compliance checks (2 automated GDPR checks, 6 honest 'partial' manual-attestation rows — COMPLIANCE-MEDIUM-002 cure; NOT hardcoded-compliant). Checks tab: GET /security/compliance/checks/gdpr. However: search 400s the list, both the Reports 'Key Findings' block and the entire Checks tab crash React on a requirement-object contract drift, and all five stat cards are hardcoded zeros.

**Endpoints exercised:** `GET /security/compliance/data-requests`; `POST /security/compliance/data-requests/:id/verify`; `POST /security/compliance/data-requests/:id/complete`; `PUT /security/compliance/data-requests/:id`; `GET /security/compliance/reports`; `GET /security/compliance/checks/:framework`; `GET /security/compliance/data-requests/stats (exists but shadowed and unused)`

**DB tables:** `admin.data_requests`, `admin.compliance_reports`, `admin.security_incidents (report metrics)`, `admin.activity_logs (injected, unused for checks)`

### APA-231 [HIGH] Typing in the search box 400s the whole data-request list

- **Status:** PENDING
- **Symptom:** fetchDataRequests sends searchQuery, but QueryDataRequestsDto has no searchQuery field and the platform-wide ValidationPipe runs whitelist:true + forbidNonWhitelisted:true — any search yields a 400 'property searchQuery should not exist', the Promise.allSettled branch fails, and the GDPR request list disappears behind an error.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:136`
  - `web/modules/admin-panel/src/services/api/security.ts:80-81`
  - `apps/admin-api-service/src/security/controllers/compliance.controller.ts:123-161 (no searchQuery)`
  - `libs/backend-common/src/bootstrap/create-service-app.ts:458-461 (whitelist + forbidNonWhitelisted defaults)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-232 [HIGH] Compliance Checks tab crashes: backend returns requirement as an OBJECT, page renders it as a React child

- **Status:** PENDING
- **Symptom:** GET /security/compliance/checks/gdpr returns ComplianceCheckResult[] = {requirement: ComplianceRequirement(object), status, details, evidence?, remediation?}. The hand-written FE type (security.ts:185-186) invents {id, category, requirement:string, description, lastChecked, nextReview}; mapComplianceCheck spreads the raw object, so check.requirement is an object and <p>{check.requirement}</p> throws 'Objects are not valid as a React child', blanking the tab. id/category/lastChecked/nextReview are all undefined (React keys undefined, 'Invalid Date').
- **Evidence:**
  - `apps/admin-api-service/src/security/services/compliance.service.ts:41-57,700-767`
  - `web/modules/admin-panel/src/services/api/security.ts:185-186`
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:251-275,1109-1135`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-233 [HIGH] Reports 'Key Findings' has the same object-render crash — and monthly cron guarantees reports exist

- **Status:** PENDING
- **Symptom:** mapComplianceReport maps finding.category ?? finding.requirement — for persisted detailedFindings.complianceResults, category is undefined and requirement is the full requirement object, so category/description become objects rendered at CompliancePage.tsx:1061-1062 -> React crash. Since generateMonthlyReports auto-creates a GDPR report on the 1st of every month, the Reports tab is expected to crash in any running deployment.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:221-232,1044-1072`
  - `apps/admin-api-service/src/security/services/compliance.service.ts:541-584,933-951`
  - `web/modules/admin-panel/src/services/types/security.ts:167-176 (type declares category/description that backend results lack)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-234 [HIGH] All five compliance stat cards are hardcoded zeros while a real stats endpoint sits unused

- **Status:** PENDING
- **Symptom:** fetchDataRequests fabricates stats {pendingRequests:0, inProgressRequests:0, completedRequests:0, overdueRequests:0, averageResolutionTime:0}; only totalRequests is real. The backend GET /security/compliance/data-requests/stats computes all of these for real. 'Overdue: 0' on a GDPR SLA dashboard is false assurance.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:143-154,761-818`
  - `apps/admin-api-service/src/security/controllers/compliance.controller.ts:354-365`
  - `apps/admin-api-service/src/security/services/compliance.service.ts:439-502`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-235 [MEDIUM] GET data-requests/stats is route-shadowed by data-requests/:id

- **Status:** PENDING
- **Symptom:** @Get('data-requests/:id') is declared before @Get('data-requests/stats'), so /stats resolves as id='stats' and throws NotFoundException('Data request not found: stats'). Latent today (FE never calls it) but blocks the correct fix for the zeros above.
- **Evidence:**
  - `apps/admin-api-service/src/security/controllers/compliance.controller.ts:239-244 (declared first),354-365 (shadowed)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-236 [MEDIUM] Status filter offers states the backend does not have

- **Status:** PENDING
- **Symptom:** Dropdown includes 'identity_verification' and 'processing'; backend DataRequestStatus is pending|in_progress|completed|rejected|expired (DB CHECK constraint). Selecting them silently returns an empty list (status is @IsString, no 400).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:877-884`
  - `apps/admin-api-service/src/security/entities/security.entity.ts:65,578`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-237 [MEDIUM] Expired GDPR download URLs are never actually cleared

- **Status:** PENDING
- **Symptom:** expireDownloadUrls cron does .set({ downloadUrl: undefined }) — TypeORM does not translate undefined into NULL in UPDATE set clauses, so the hourly job either no-ops or errors and PII export links outlive downloadExpiresAt.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/compliance.service.ts:956-969`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-238 [MEDIUM] Generate Report / Download / Run Assessment buttons are dead

- **Status:** PENDING
- **Symptom:** None of these three buttons has an onClick, though real endpoints exist (POST /security/compliance/reports, GET /checks/:framework). Report generation is only reachable via the monthly cron.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/CompliancePage.tsx:979-984,1019-1022,1096-1099`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-239 [LOW] Non-GDPR frameworks silently reuse the GDPR requirement set; dead broken Not() helper

- **Status:** PENDING
- **Symptom:** getRequirements returns GDPR_REQUIREMENTS for every framework (documented). File also carries an unused local Not() returning {$not:value}, which is not a valid TypeORM operator if ever used.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/compliance.service.ts:648-661,1009-1012`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## SecurityDashboardPage — `/admin/security/threats` — verdict: **PARTIAL**

**Chain:** Page -> getMonitoringDashboard + getHealthScore + getSecurityEvents + getSecurityIncidents + getThreatIndicators -> GET /security/monitoring/{dashboard,health-score,events,incidents,threat-intelligence} -> SecurityMonitoringService -> real TypeORM queries on admin.security_events / security_incidents / threat_intelligence (entities security.entity.ts:262,382,501; Baseline migration:125-139). Health score is computed in the controller from dashboard counts — NOT from observability-service; no external threat/metric source exists. The chain is mechanically real, but every input table is structurally unpopulated, so the dashboard is a permanent green light.

**Endpoints exercised:** `GET /security/monitoring/dashboard`; `GET /security/monitoring/health-score`; `GET /security/monitoring/events`; `GET /security/monitoring/incidents`; `GET /security/monitoring/threat-intelligence`

**DB tables:** `admin.security_events`, `admin.security_incidents`, `admin.threat_intelligence`, `admin.login_attempts`, `admin.api_usage_logs`, `admin.user_sessions`

### APA-240 [CRITICAL] Threat-detection supply chain is dead — dashboard always reports 100/'healthy' (false assurance)

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** security_events only get created by (a) POST /security/monitoring/events and POST /analyze/login — both behind the global SUPER_ADMIN guard, and auth-service contains no call to any admin-api security endpoint (grep of apps/auth-service/src for analyze/login|ADMIN_API_URL: zero hits); (b) anomaly detectors reading admin.login_attempts — a table with no writers (recordLoginAttempt has no callers); (c) checkApiAbuse/checkSessionHijacking/checkThreatIntelligence — the first two have zero callers, the third only fires from a manual GET check endpoint; (d) threat feeds — updateThreatFeeds is a stub logging 'Would update threat feed'. Result: events, incidents (auto-escalation only triggers from events), and threat indicators are永-empty; getHealthScore computes over zeros and returns score 100 'healthy' with a full green gauge no matter what attacks actually occur. A real brute-force against auth-service is invisible here.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:318-339 (analyzeLoginAttempt),543-629 (checkApiAbuse/checkSessionHijacking: no callers per repo grep),1107-1117 ('Would update threat feed' stub)`
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:353-399 (recordLoginAttempt: sole login_attempts writer, never called)`
  - `apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts:690-708 (analyze endpoint SUPER_ADMIN-guarded),762-865 (health score arithmetic over dashboard zeros -> 100)`
  - `apps/admin-api-service/src/app.module.ts:277-290 (global PlatformAdminGuard)`
  - `apps/auth-service/src: grep 'analyze/login|admin-api.*security|ADMIN_API_URL' -> no matches`
- **Verification:** Every link of the claimed dead chain verified by direct reads and repo-wide greps. (1) admin.login_attempts has exactly one writer, ActivityLoggingService.recordLoginAttempt (activity-logging.service.ts:353), with zero callers; likewise logApiUsage (:453) and createSession (:508) for api_usage_logs/user_sessions — so every anomaly detector (checkBruteForce, checkCredentialStuffing, checkGeoAnomaly, checkTimeAnomaly in security-monitoring.service.ts:344-538) counts over permanently empty tables. (2) analyzeLoginAttempt's only caller is POST /security/monitoring/analyze/login (controller:690), behind the global APP_GUARD PlatformAdminGuard (app.module.ts:277-290); grep for 'analyze/login' across the repo hits only the controller — auth-service never calls it and has no admin-api HTTP client. (3) auth-service emits only best-effort UserLoggedIn success telemetry (authentication.service.ts:498) with no consumer (admin-api's only NATS handlers are tenant-erasure/tenant-onboarding-ack/policy); LOGIN_FAILED is written to auth.audit_logs, never read by the admin security module; no failed-login event contract exists in libs/event-contracts. (4) checkApiAbuse/checkSessionHijacking: zero callers (grep); checkThreatIntelligence fires only from manual GET threat-intelligence/check/:ip. (5) updateThreatFeeds (service:1108-1117) is a stub logging 'Would update threat feed'. Consequently security_events/incidents/threat-intel stay empty; getHealthScore (controller:762-865) over zeros yields 94 (incidents 100x30 + critical 100x25 + 'stable' trend 75x25 + mitigation 100x20 = 93.75), and FE mapHealthStatus (SecurityDashboardPage.tsx:189-193) maps >=85 to 'healthy' — permanent green gauge. Minor corrections to the finding: score is 94 not 100, and platform-level compensating controls exist (auth-service account lockout, Prometheus auth_login_attempts_total SLO alerts), so a brute force is not invisible platform-wide — but the SUPER_ADMIN security pane, the surface operators would actually consult, fabricates 'healthy' regardless of real attacks, and its entire feature area is non-functional. False assurance on the primary security-monitoring surface warrants keeping CRITICAL.
- **Root cause:** The chain broke at the auth-service → admin-api service boundary: the security module was built dashboard-first against admin-schema telemetry tables (login_attempts, api_usage_logs, user_sessions) on the assumption that a producer existed ('writer EVENT/SYSTEM' per docs/reviews/db-audit/db-audit-platform-admin/2026-07-11), but no producer contract was ever defined. There is no LoginAttempted/LoginFailed event in libs/event-contracts, no NATS subscription in admin-api's security module, and the only ingestion endpoints (POST /security/monitoring/events, POST analyze/login) sit behind the global SUPER_ADMIN guard, making service-to-service ingestion structurally impossible. Auth-service treats auth.audit_logs as its SoT and fans out only a consumer-less UserLoggedIn success event. Nothing detects the gap because no test asserts the supply chain end-to-end — contract tests validate event shapes, not that consumed tables have live producers. This is an instance of the systemic 'table-with-readers-but-no-writer' class (sibling of the config-table-nobody-reads findings).
- **Fix design:** Tier 1/2 fix: make ingestion automatic via the platform's existing event backbone, and make 'no telemetry' impossible to render as 'healthy'. (A) Contract at the source: add a flat LoginAttempted event (ADR-006, createBaseEvent, PascalCase) to libs/event-contracts/src/auth-events.ts with fields {emailMasked, ipAddress, success, failureReason?, userId?, tenantId?, geo?} plus a JSON Schema validator in schemas/auth-events.schema.ts (trust-boundary crossing) and index export. (B) Producer: auth-service publishes LoginAttempted on BOTH success and failure paths in authentication.service.ts via the existing BestEffortEventPublisher (auth.audit_logs remains SoT; add 'LoginAttempted' to its allowlist). (C) NATS SSoT: add publish (auth) + subscribe (admin-api) permissions for events.*.LoginAttempted in infrastructure/nats/services.yaml and regenerate nats.conf via scripts/nats/generate-nats-conf.py in the same commit (ADR-015 — note the prod permission-violation precedent on UserLoggedIn). (D) Consumer: new apps/admin-api-service/src/security/handlers/login-attempt.handler.ts subscribing via @platform/event-bus, validating against the JSON schema, then recordLoginAttempt(...) + analyzeLoginAttempt(...) — this single consumer revives brute-force, credential-stuffing, geo and time detection, event creation, and incident auto-escalation because they all read admin.login_attempts. (E) Remove the now-redundant SUPER_ADMIN-only POST analyze/login endpoint and delete the fabricated threat-feed machinery (initializeFeeds list + updateThreatFeeds cron stub that stamps lastUpdated without doing anything); threat indicators are driven by internal detection (addThreatIndicator) — external feed integration becomes a tracked finding with owner+deadline, not a stub pretending to run. (F) Honest health score (pattern-level fix for the false-assurance class): extend the health-score contract with required telemetry liveness — service computes lastSeenAt per source (max(createdAt) of login_attempts / api_usage_logs / user_sessions) and returns dataStatus 'live'|'stale'|'no_data'; controller returns it as a required field; FE BackendSecurityHealthScore type updated so mapDashboardData cannot compile without handling it; HealthGauge renders an explicit 'No telemetry' state instead of a green gauge when dataStatus !== 'live'. A monitoring dashboard must distinguish 'quiet because safe' from 'quiet because deaf'. (G) checkApiAbuse/checkSessionHijacking still have no producers (gateway rate-limit and session telemetry): wire gateway-api's throttler rejection path to publish an ApiRateLimitExceeded event consumed by the same admin-api handler layer, or — if that cannot land in this PR — delete the two dead methods and open a tracked CRITICAL/HIGH finding with owner+deadline per repo discipline; never leave uncalled detectors implying coverage. (H) Systemic gate: integration spec publishing a synthetic LoginAttempted through the event-bus test harness asserting a login_attempts row, threshold-crossing security_event, and incident escalation; plus extend nats-invariants to assert every event type the admin security module subscribes to has a granted publisher in services.yaml (prevents future dead-supply-chain drift).
- **Files to change:**
  - `libs/event-contracts/src/auth-events.ts`
  - `libs/event-contracts/src/schemas/auth-events.schema.ts`
  - `libs/event-contracts/src/schemas/__tests__/auth-events.schema.spec.ts`
  - `libs/event-contracts/src/index.ts`
  - `apps/auth-service/src/modules/authentication/services/authentication.service.ts`
  - `apps/auth-service/src/outbox/best-effort-event-publisher.ts`
  - `infrastructure/nats/services.yaml`
  - `infrastructure/docker/nats/nats.conf`
  - `apps/admin-api-service/src/security/handlers/login-attempt.handler.ts`
  - `apps/admin-api-service/src/security/security.module.ts`
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts`
  - `apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts`
  - `apps/admin-api-service/src/security/__tests__/security-telemetry-pipeline.integration.spec.ts`
  - `e2e/tests/integration/nats-invariants.spec.ts`
  - `web/modules/admin-panel/src/services/types/security.ts`
  - `web/modules/admin-panel/src/services/api/security.ts`
  - `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx`
- **Proof of fix:** 1) New apps/admin-api-service/src/security/__tests__/security-telemetry-pipeline.integration.spec.ts: publish 6 failed LoginAttempted events for one email via the @platform/event-bus test harness -> assert admin.login_attempts rows exist, a brute_force_attempt security_event is created, and a critical distributed attack escalates to a security_incident; also assert GET health-score returns dataStatus 'no_data' with an empty DB and never 'healthy' semantics FE-side (FE type makes this compile-enforced). 2) Extend libs/event-contracts/src/schemas/__tests__/auth-events.schema.spec.ts with LoginAttempted valid/invalid fixtures. 3) Extend e2e/tests/integration/nats-invariants.spec.ts: for each subject subscribed by admin-api security handlers, services.yaml grants a matching publish permission to exactly one producer service (regenerated nats.conf sentinel check already covered). 4) Auth-service unit spec (authentication.service.spec.ts) asserts BestEffortEventPublisher.publish called with LoginAttempted on both wrong-password and success paths. 5) nx affected --target=test && --target=lint green; npm run type-check proves the FE BackendSecurityHealthScore change forces the no-data gauge handling.
- **Effort:** L

### APA-241 [MEDIUM] 'Critical (24h)' and 'Blocked (24h)' cards actually show all-time counts

- **Status:** PENDING
- **Symptom:** dashboard.criticalEvents and threatsBlocked are unbounded counts (no createdAt filter) but the cards label them as 24h figures.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:941-950`
  - `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx:210-218,763-795`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-242 [MEDIUM] Incident field drift: FE reads columns the entity does not have

- **Status:** PENDING
- **Symptom:** FE type BackendSecurityIncident declares affectedUsers/relatedEvents/remediation/resolvedAt; the entity has affectedUsersCount/relatedSecurityEvents/remediationSteps and no resolvedAt. Incident cards therefore always show '0 users affected' and never show remediation/related events even when data exists. Timeline actor field also drifts (backend 'actor' vs FE 'user').
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/security.ts:240-259`
  - `apps/admin-api-service/src/security/entities/security.entity.ts:421-422,457-458,468,481-482`
  - `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx:279-299,932-935`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-243 [MEDIUM] 'Affected Tenants' hardcoded 0; 'Unique IPs' capped at 10

- **Status:** PENDING
- **Symptom:** mapDashboardData sets affectedTenants: 0 unconditionally and uniqueSourceIps = topSourceIPs.length, which the backend caps with LIMIT 10 — both cards present placeholder math as measurements.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx:210-219`
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:1000-1009 (.limit(10))`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-244 [LOW] Status/search filters exist as dead state; resolved-count only scans first incident page

- **Status:** PENDING
- **Symptom:** statusFilter/searchTerm have no UI controls (_setStatusFilter/_setSearchTerm unused), and resolvedIncidents counts status==='closed' within the default 20-row first page only. Event modal 'Tenant' always shows N/A (no tenantName in entity or response).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/security/SecurityDashboardPage.tsx:582-583,607,530`
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:909 (limit=20 default)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


## Cross-cutting findings

### APA-245 [CRITICAL] Admin security telemetry ledgers have no producers anywhere in the platform

- **Status:** PENDING
- **Symptom:** admin.activity_logs, admin.login_attempts, admin.api_usage_logs, admin.user_sessions, and admin.security_events are fully modelled (entities with schema:'admin', Baseline migration, indexed) and fully queryable, but no service, interceptor, middleware, or NATS consumer anywhere in the monorepo writes to them: ActivityLoggingService's write methods have zero callers; auth-service never calls admin-api's ingest endpoints (and cannot — the global PlatformAdminGuard demands a SUPER_ADMIN user JWT on every route, including the POST ingest endpoints); the SecurityModule registers no event-bus subscription. Two of the four security pages (Activity Log, Security Dashboard) and the retention/alerting machinery are therefore built on structurally empty tables — the admin panel presents an 'all clear' security posture that reflects nothing. This is an architectural gap (missing ingestion pipeline / event contract from auth-service, gateway-api, and other services into the admin security schema), not a UI bug.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:130-499 (all writers defined, none invoked — repo-wide grep)`
  - `apps/admin-api-service/src/app.module.ts:277-290 (APP_GUARD PlatformAdminGuard blocks machine-to-machine ingest)`
  - `apps/admin-api-service/src/security/security.module.ts:40-82 (no consumers/subscriptions)`
  - `apps/auth-service/src: grep for admin-api security endpoints -> no matches`
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:116-163 (tables exist and are real)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-246 [HIGH] Security alerting/notification layer is stubbed end-to-end

- **Status:** PENDING
- **Symptom:** Every outbound alerting path in the security domain is a log-only stub: AuditTrailService.triggerAlert ('Would send email alert', 'Would send Slack alert', 'Would trigger webhook', 'Would send SMS alert'), checkOverdueRequests ('In production, send notifications'), updateThreatFeeds ('Would update threat feed'), and alert rules themselves are in-memory (non-persisted, per-replica, evaluation path checkAlerts never called). The admin panel surfaces these as configured, active controls. No integration with notification-service exists for any security alert.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:979-1003,871-917`
  - `apps/admin-api-service/src/security/services/compliance.service.ts:912-928`
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:1104-1117`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-247 [MEDIUM] Actor attribution hardcoded to 'admin' on audit-relevant mutations

- **Status:** PENDING
- **Symptom:** createRetentionPolicy/updateRetentionPolicy pass createdBy/updatedBy 'admin' ('Would come from auth context') and updateIncident records actor 'admin'/'Admin User' — on a service whose whole purpose is attribution, retention-policy changes and incident-response timeline entries cannot be traced to the operator who made them, while the same file already demonstrates the JWT pattern (compliance controller C6 fixes).
- **Evidence:**
  - `apps/admin-api-service/src/security/controllers/audit-trail.controller.ts:481-495`
  - `apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts:547-558`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-248 [MEDIUM] Hand-written FE response types drift systematically (no codegen)

- **Status:** PENDING
- **Symptom:** services/types/security.ts diverges from backend shapes in every direction found in this audit: BackendSecurityIncident (4 renamed/missing fields), getComplianceChecks inline type (object requirement, invented id/category/lastChecked/nextReview -> React crashes), BackendComplianceReport.detailedFindings (category/description that persisted results lack), BackendActivityLog (invented userAgent/location/timestamp), getSecurityDashboard inline type (threatLevel/unresolvedEvents/blockedThreats/recentEvents/topThreats — none exist in SecurityDashboardStats). The security.ts api layer itself carries '// Fix:' comments documenting previously-shipped path mismatches, confirming this drift is chronic. Guard status, for the record, is solid: every security endpoint sits behind the global RS256 SUPER_ADMIN PlatformAdminGuard + ThrottlerGuard.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/security.ts:65-96,157-182,240-259`
  - `web/modules/admin-panel/src/services/api/security.ts:69,76,85-86,145,160-168 (in-code fix comments and stale getSecurityDashboard shape)`
  - `apps/admin-api-service/src/security/services/security-monitoring.service.ts:65-89 (actual SecurityDashboardStats)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-249 [MEDIUM] Unvalidated sortBy interpolated into ORDER BY in two query builders

- **Status:** PENDING
- **Symptom:** queryActivities (reachable from GET /security/activities?sortBy=...) and AuditTrailService.getAuditTrail interpolate the caller-supplied sortBy string directly into orderBy(`alias.${sortBy}`). Minimum impact: 500 on unknown column; it is also a raw-SQL interpolation point behind a single role check.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/activity-logging.service.ts:661`
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:283`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-250 [LOW] PDF export is a plaintext placeholder served as application/pdf

- **Status:** PENDING
- **Symptom:** exportAuditTrail 'pdf' format returns the string 'PDF Export - N audit entries' with mimeType application/pdf — a compliance officer downloading a PDF audit export gets a corrupt one-line file.
- **Evidence:**
  - `apps/admin-api-service/src/security/services/audit-trail.service.ts:553-559,641-646`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
