# Impersonation & Debug Tools — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## ImpersonationPage — `/admin/system/impersonation` — verdict: **BROKEN**

**Chain:** FE (services/api/impersonation.ts) -> nginx '/api/' catch-all rewrites /api/X to /api/v1/X (infrastructure/nginx/droplet.conf:377-383) -> admin-api-service global prefix 'api/v1' + VERSION_NEUTRAL versioning (libs/backend-common/src/bootstrap/create-service-app.ts:610,799-810; apps/admin-api-service/src/main.ts:17-19) -> ImpersonationController guarded by PlatformAdminGuard (SUPER_ADMIN only, RS256 JWT: impersonation.controller.ts:281 plus global APP_GUARD app.module.ts:283-286) -> ImpersonationService -> admin.impersonation_sessions / admin.impersonation_permissions (created in 1800000000000-Baseline.ts) + admin.audit_logs. The {success,data,meta} envelope from ResponseInterceptor is correctly unwrapped by http-client for all three list shapes. READ chains verified real-to-DB (sessions, permissions, stats). Security positives verified: token stored SHA-256-hashed, SafeImpersonationSession strips token columns on every read path, ThrottleSensitive on start/end/terminate/extend, Redis rate-limit on start, IP binding on validate, audit rows written for start/end/terminate/extend/expire. HOWEVER: (1) the Baseline migration installs a BEFORE UPDATE OR DELETE trigger on admin.impersonation_sessions that raises on ANY update while the service ends/terminates/extends/expires/log-actions via repo.save() UPDATEs — all session-lifecycle mutations 500; (2) the raw impersonation token returned at start is discarded by the FE and consumed by no client anywhere, so actual impersonated tenant access is impossible; (3) the Permissions tab renders a hand-written FE type that shares almost no fields with the backend entity and crashes on real data.

**Endpoints exercised:** `GET /api/impersonation/sessions (matches @Get('sessions'), default limit 20)`; `GET /api/impersonation/permissions (matches @Get('permissions'); tenantId filter param is latently broken)`; `GET /api/impersonation/stats (matches @Get('stats'))`; `GET /api/admin/tenants/search?q=&limit=100 (tenant.controller.ts:136,176 — tenant dropdown)`; `POST /api/impersonation/sessions/start (StartImpersonationDto — works only until DB trigger side-effects lock the admin out)`; `POST /api/impersonation/sessions/:id/end (500s at DB trigger)`; `POST /api/impersonation/sessions/:id/extend (500s at DB trigger)`; `POST /api/impersonation/sessions/:id/terminate (500s at DB trigger; also unreachable from UI — no button sets confirmAction type 'revoke')`; `POST /api/impersonation/permissions (GrantPermissionDto)`; `POST /api/impersonation/permissions/:superAdminId/revoke (FE passes wrong identifier — always 404)`; `getSessionActions: client-side stub that throws — no backend GET for session actions`

**DB tables:** `admin.impersonation_sessions (Baseline.ts:165-170; append-only trigger Baseline.ts:266-280)`, `admin.impersonation_permissions (Baseline.ts:171-172)`, `admin.audit_logs (Baseline.ts:8; append-only trigger Baseline.ts:249-264)`

### APA-288 [CRITICAL] DB append-only trigger on impersonation_sessions makes every session-lifecycle mutation fail (end/terminate/extend/expire/log-action all 500; live sessions unrevocable; starts eventually hard-blocked)

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The active Baseline migration creates trigger trg_impersonation_sessions_prevent_update which RAISEs an exception on any UPDATE or DELETE of admin.impersonation_sessions ('append-only ... UPDATE/DELETE refused'), and no later migration drops it (grep over apps/admin-api-service/src/migrations found only the Baseline create and its down()). But ImpersonationService mutates existing rows via sessionRepo.save() in endImpersonation, terminateSession, extendSession, logAction, logResourceAccess and the every-minute expireOldSessions cron. Consequences: (a) End Session / Extend / Terminate buttons always 500 — an in-flight impersonation credential CANNOT be revoked or killed (security hole: the kill-switch documented as AUDITTRAIL/H26/H21 fixes is dead); (b) the expiry cron throws every minute forever, and rows stay status='active' in the DB permanently; (c) canImpersonate counts ACTIVE rows against maxConcurrentSessions (default 3), so after 3 starts an admin is permanently locked out with 'Maximum concurrent sessions reached'; (d) validateSession on an expired session calls expireSession -> save -> throws -> 500; (e) revokeImpersonationPermission calls endAllSessionsForAdmin -> endImpersonation -> 500 whenever the admin has active sessions; (f) the in-session action log (logAction) can never persist, so the per-session audit array is permanently empty. The DB immutability guard and the mutable session lifecycle are architecturally contradictory.
- **Evidence:**
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:266-280 (trigger + REVOKE UPDATE,DELETE)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:604-608 (endImpersonation save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:650-654 (terminateSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:727-745 (extendSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:893-896 (logAction save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:1091-1097 (expireSession save, called by EVERY_MINUTE cron at :1072-1089)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:416-424 (ACTIVE count vs maxConcurrentSessions)`
- **Verification:** Verified end-to-end. (1) Active Baseline (apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:265-280) creates trg_impersonation_sessions_prevent_update BEFORE UPDATE OR DELETE FOR EACH ROW that unconditionally RAISEs; grep of all 18 active migrations and runtime code shows nothing drops it (only Baseline down(); .archive/ excluded by the src/migrations/[0-9]*.ts glob in both data-source.ts:35 and app.module.ts:117; synchronize:false so schema comes only from migrations). (2) Entity maps exactly to admin.impersonation_sessions (impersonation-session.entity.ts:57). (3) All six mutation paths load an existing row and repo.save() it (UPDATE by id): endImpersonation :604-608, terminateSession :650-654, extendSession :727-745, logAction :893-896, logResourceAccess :926-927, expireSession :1091-1097 driven by @Cron(EVERY_MINUTE) :1072 (ScheduleModule imported in impersonation.module.ts). A BEFORE trigger fires for every role including the table owner, so every UPDATE fails regardless of grants. (4) Fully reachable from FE: impersonationApi.endSession/extendSession/terminateSession (web/modules/admin-panel/src/services/api/impersonation.ts:72-78) hit @Controller('impersonation') routes sessions/:id/end|terminate|extend (controller :372/:388/:404). (5) Consequences confirmed: INSERT allowed, so sessions start then can never leave ACTIVE; canImpersonate counts ACTIVE vs maxConcurrentSessions default 3 (entity :222, service :416-421) => permanent lockout after 3 starts; validateSession on expired session calls expireSession->save->throws (:814-816); revokeImpersonationPermission->endAllSessionsForAdmin->endImpersonation throws (:777-785); cron throws every minute forever. (6) No gate catches it: unit tests mock the repo; e2e/tests/integration/audit-immutability.spec.ts only covers audit_logs; no e2e references impersonation_sessions. CRITICAL stands: the kill-switch for a live SUPER_ADMIN impersonation credential (H26/H21/terminate) is dead, and the feature hard-bricks after 3 uses per admin. Adversarial digging found the root cause is deeper than stated: the trigger is MANDATED by a triple-hardcoded classification of admin.impersonation_sessions as an append-only audit ledger — libs/backend-common/src/constants/protected-tables.ts:130 (PROTECTED_TABLES SSoT), scripts/migration/baseline-generator.ts:330-339 (hardcoded PROTECTED_TABLE_NAMES whose audit FAILS a regenerated baseline lacking the trigger — dropping the trigger alone would be reintroduced at next baseline regen), and scripts/migration/apply-audit-immutability.mjs:32 (TARGETS list that injected it). The service's own comments (:613-616, :753-754) state the table is 'operational, not audit' and every lifecycle transition already writes the regulatory record to audit_logs via auditLogService (AUDITTRAIL-CRITICAL-003).
- **Root cause:** The BE->DB link broke via a category error propagated by tooling: admin.impersonation_sessions was classified as an append-only AUDIT ledger in the compliance layer (protected-tables.ts:130) and in two hardcoded copies of that list (baseline-generator.ts:330-339, apply-audit-immutability.mjs:32), and the Faz 3.5 script mechanically injected an unconditional UPDATE/DELETE-refusing trigger into the Baseline. But the table is an operational session-state machine (active->ended/expired/terminated, expiresAt extension, in-row action log) whose owning service UPDATEs it on every lifecycle transition — the service code itself documents it as 'operational, not audit' (impersonation.service.ts:613-616, :753-754), with the regulatory audit trail already duplicated into audit_logs (IMPERSONATION_STARTED/ENDED/TERMINATED/EXTENDED/EXPIRED). Drift persisted because (a) the protected-table classification conflates two distinct contracts — 'protected from destructive DDL' and 'append-only rows' — in one list, (b) the classification lives in three hardcoded copies instead of one SSoT consumed by all tools, and (c) no build/test gate exercises an impersonation session state transition against a real migrated schema (unit tests mock the repo; the invariant tests only assert triggers EXIST, never that the owning service's write-set is compatible with them).
- **Fix design:** Systemic class: config/compliance-contract-nobody-reconciled — the append-only DB guard and the mutable domain lifecycle are contradictory contracts; fix at the classification SSoT, not by just dropping the trigger (which the baseline-generator audit would reinstate). Tier-1 design: (A) ADR (docs/adr/037-impersonation-session-lifecycle-guard.md, required by protected-tables.ts's own removal rules + arbiter approval): reclassify admin.impersonation_sessions from append-only ledger to lifecycle-guarded operational table — identity columns tamper-proof, legal state machine enforced, hard-delete refused; regulatory audit remains admin.audit_logs. (B) Split the conflated concept in libs/backend-common/src/constants/protected-tables.ts: keep PROTECTED_TABLES (destructive-DDL guard — impersonation_sessions STAYS listed, DROP TABLE still waiver-gated) and add two exported subsets: APPEND_ONLY_TABLES (the true ledgers: audit_logs, payroll_audit, etc.) and LIFECYCLE_GUARDED_TABLES ({ table: 'admin.impersonation_sessions', immutableColumns: [id, superAdminId, superAdminEmail, targetTenantId, targetUserId, reason, reasonDetails, ticketReference, ipAddress, userAgent, originalSessionToken, impersonationToken, createdAt], transitions: active->ended|expired|terminated, deleteRefused: true }). (C) New migration apps/admin-api-service/src/migrations/1801600000000-ImpersonationSessionLifecycleGuard.ts (never hand-edit Baseline; carries -- COMPLIANCE-WAIVER: marker + this finding ID since it alters a guard on a PROTECTED_TABLES entry, per migration-sql-lint R13): DROP TRIGGER trg_impersonation_sessions_prevent_update + its function; CREATE FUNCTION admin.impersonation_sessions_lifecycle_guard() BEFORE UPDATE — RAISE if any immutable column changes (OLD.x IS DISTINCT FROM NEW.x), RAISE if OLD.status is terminal (row frozen), RAISE on any transition other than active->ended|expired|terminated; separate BEFORE DELETE trigger always RAISEs (no-hard-delete preserved); keep REVOKE DELETE, leave UPDATE governed by the trigger. This makes the wrong behavior (tampering with attribution, resurrecting/deleting sessions) impossible at the DB while making the correct behavior (lifecycle transitions, extendSession, logAction) work with zero service-code change. (D) Kill the triple-hardcode: baseline-generator.ts imports APPEND_ONLY_TABLES/LIFECYCLE_GUARDED_TABLES from the SSoT instead of its local PROTECTED_TABLE_NAMES array, expecting trg_<tbl>_prevent_update for append-only entries and the lifecycle-guard trigger pair for lifecycle-guarded ones; apply-audit-immutability.mjs drops impersonation_sessions from TARGETS (script is superseded for that table). (E) Extend tests/invariants/protected-tables-guard.spec.ts to assert the generator/script table sets are imported from (not copies of) the SSoT, and that every APPEND_ONLY table's owning entity has no @UpdateDateColumn-bearing mutable lifecycle (append-only vs write-path parity).
- **Files to change:**
  - `apps/admin-api-service/src/migrations/1801600000000-ImpersonationSessionLifecycleGuard.ts`
  - `libs/backend-common/src/constants/protected-tables.ts`
  - `scripts/migration/baseline-generator.ts`
  - `scripts/migration/apply-audit-immutability.mjs`
  - `tests/invariants/protected-tables-guard.spec.ts`
  - `e2e/tests/integration/impersonation-session-lifecycle.spec.ts`
  - `e2e/tests/integration/audit-immutability.spec.ts`
  - `docs/adr/037-impersonation-session-lifecycle-guard.md`
- **Proof of fix:** New integration spec e2e/tests/integration/impersonation-session-lifecycle.spec.ts against real migrated Postgres: (1) INSERT active session, UPDATE status->'ended' + endedAt/endReason SUCCEEDS (proves end/terminate/expire path live); (2) UPDATE expiresAt + actionsPerformed + actionCount on active row SUCCEEDS (extend/logAction path); (3) UPDATE superAdminId (or createdAt/impersonationToken) is REFUSED by admin.impersonation_sessions_lifecycle_guard; (4) UPDATE on a row already in 'ended' status is REFUSED (terminal freeze); (5) DELETE is REFUSED; (6) trigger inventory query (mirroring audit-immutability.spec.ts:119-131) asserts the lifecycle-guard trigger pair exists and trg_impersonation_sessions_prevent_update does NOT. Extend tests/invariants/protected-tables-guard.spec.ts to fail if baseline-generator.ts or apply-audit-immutability.mjs carries a table list not imported from protected-tables.ts, and to fail if any APPEND_ONLY_TABLES entry maps to an entity whose service performs lifecycle UPDATEs. Existing service unit specs (impersonation.session-cap.spec.ts etc.) stay green — no service code changes.
- **Effort:** M

### APA-289 [CRITICAL] Impersonation access chain is not wired end-to-end: the issued token is discarded and nothing can consume it — the feature cannot actually access a tenant

- **Status:** PENDING
- **Symptom:** startImpersonation returns the raw impersonationToken exactly once (StartedImpersonationSession), but handleStartImpersonation ignores the response entirely. The 'Open Tenant Portal' button opens /tenant?impersonation_session=<session.id> — a session id, not the token; a repo-wide grep shows NOTHING consumes an 'impersonation_session' query param, and the shell's /tenant/* route is gated by ProtectedRoute requiredRoles=['TENANT_ADMIN'] (+ tenant capabilities), which a SUPER_ADMIN JWT does not carry, so the tab dead-ends at the role gate. The backend validate endpoint (GET /impersonation/sessions/validate reading header x-impersonation-token) has zero callers anywhere in the repo (FE, gateway, middleware — grep for x-impersonation-token matches only the controller). Net effect: the platform mints a scoped, time-limited, hashed, IP-bound credential that no code path can ever present. The page can start and list sessions, but impersonation as a capability (viewing/acting on tenant data) does not exist.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:231-237 (start response discarded)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:664-673 (opens /tenant?impersonation_session=<id>)`
  - `web/shell/src/App.tsx:288-300 (/tenant/* requires TENANT_ADMIN)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:426-434 (validate endpoint, x-impersonation-token header)`
  - `grep 'x-impersonation-token|impersonation_session' across repo: only the controller and the ImpersonationPage URL construction match`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-290 [HIGH] Revoke Permission always 404s: FE sends the permission row id where the route requires superAdminId

- **Status:** PENDING
- **Symptom:** The revoke button sets confirmAction.id = permission.id and handleRevokePermission passes it to impersonationApi.revokePermission -> POST /impersonation/permissions/:superAdminId/revoke. The backend resolves the path param as superAdminId and looks up permissionRepo.findOne({where:{superAdminId}}) — a permission UUID never equals an admin UUID, so revocation of a grant fails with NotFoundException 100% of the time. The API wrapper even names the parameter superAdminId, but the page passes the wrong identifier.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:822-830 (confirmAction.id = permission.id)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:310-313 (handleRevokePermission passes confirmAction.id)`
  - `web/modules/admin-panel/src/services/api/impersonation.ts:48-50`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:326-330`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:292-296 (findOne by superAdminId)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-291 [HIGH] Permissions tab crashes / renders undefined on real data: FE ImpersonationPermission type shares almost no fields with the backend entity

- **Status:** PENDING
- **Symptom:** FE type has tenantId/tenantName/grantedByEmail/maxSessionDuration/allowedActions/reason/revokedAt/revokedBy; the backend entity has superAdminId/superAdminEmail/allowedTenants[]/maxSessionDurationMinutes/notes/etc. — only id/isActive/grantedAt/expiresAt overlap. Rendering any active permission executes permission.allowedActions.join(', ') on undefined -> TypeError -> React subtree crash; typing in the search box executes permission.tenantName.toLowerCase() on undefined -> TypeError. Cards otherwise show 'undefined min', blank tenant and granted-by columns. The permission model is per-ADMIN (which tenants an admin may impersonate), but the UI presents it as per-TENANT — a conceptual inversion, not just field drift.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/impersonation.ts:25-39 (FE type)`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:192-251 (backend entity)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:804 (allowedActions.join crash)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:213-215 (tenantName.toLowerCase crash)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:789-800 (renders tenantName/tenantId/grantedByEmail/maxSessionDuration)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-292 [HIGH] 'View Actions' always shows an empty audit trail even when actions exist

- **Status:** PENDING
- **Symptom:** impersonationApi.getSessionActions is a client-side stub that throws 'Not implemented'; handleViewActions catches it and renders 'No actions recorded for this session'. Yet the session-list/read responses already contain the full actionsPerformed array (SafeImpersonationSession strips only token columns), so the data the modal claims is absent is sitting in the very session object passed to it. For a security review surface this is silent wrong data: an operator auditing an impersonation session is told nothing happened. (Compounded by the DB trigger which prevents logAction from persisting new actions at all.)
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/impersonation.ts:80-83 (stub throws)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:323-335 (catch -> empty list)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1201-1204 ('No actions recorded')`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:971-973 (list returns safe entity incl. actionsPerformed)`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:168-190 (only token fields stripped)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-293 [HIGH] No separation of duties: a SUPER_ADMIN self-grants impersonation permission, and nothing prevents impersonating another SUPER_ADMIN or an unrelated/nonexistent user

- **Status:** PENDING
- **Symptom:** The FE grant form hardcodes superAdminId = currentAdminId, i.e. the operator grants THEMSELVES access to any tenant, then starts a session — the entire permission gate (allowedTenants whitelist, canImpersonate) is self-serviceable in two clicks. The backend accepts grantedBy === superAdminId with no maker/checker rule. startImpersonation performs no validation that targetUserId exists, belongs to targetTenantId, or is not itself a SUPER_ADMIN/platform admin (no auth-service lookup at all) — the extra-scrutiny requirement 'guard against impersonating other SUPER_ADMINs' is unimplemented. Grant/revoke of permissions is also absent from the audit log (only session events are audited; grant writes only a Logger line).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:287-294 (superAdminId: currentAdminId)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:304-319 (no self-grant check)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:235-290 (grant: no audit log, no SoD check)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:431-539 (start: targetUserId never validated)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-294 [HIGH] Audit-write failures are silently swallowed despite in-code claims that they propagate (AUDITTRAIL-CRITICAL-003)

- **Status:** PENDING
- **Symptom:** impersonation.service.ts documents that awaiting auditLogService.log() lets a failure propagate so a SUPER_ADMIN session can never exist without an audit row. But AuditLogService.log wraps the save in try/catch and returns null on error ('Don't throw - audit logging should not break main operations'). The awaited call therefore NEVER throws: under a transient DB blip an impersonation session starts with no row in admin.audit_logs — exactly the half-recorded state the comment claims is cured. The SOC2/GDPR reconstruction guarantee asserted at the call sites is not actually enforced.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:551-575 (comment claims propagation; awaits log)`
  - `apps/admin-api-service/src/audit/audit.service.ts:84-107 (log() catches all errors, returns null)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-295 [MEDIUM] End/Extend failures are swallowed silently, and the operator-override Terminate flow is unreachable from the UI

- **Status:** DESIGNED (brief)
- **Symptom:** handleEndSession and handleExtendSession catch errors with console.error only (no setPageError), then close the modal and refetch — on the backend's owner-only checks (H26: only the session owner may end/extend), a second admin trying to stop a colleague's session gets a silent no-op: modal closes, session still active, zero feedback. The only sanctioned path for stopping someone else's session is POST /sessions/:id/terminate, and the FE has handleRevokeSession + a confirm branch for type 'revoke', but no button anywhere sets confirmAction.type='revoke' — the override is dead code. Net: from this page, one admin cannot stop another admin's active impersonation at all (independent of the DB-trigger issue).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:247-256 (end: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:258-267 (extend: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:269-282,1318-1319 (revoke handler + branch never triggered; grep shows no setConfirmAction type 'revoke')`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:599-602,700-703 (owner-only 403s)`
- **Root cause:** handleEndSession/handleExtendSession (ImpersonationPage.tsx:247-267) catch with console.error only and unconditionally close the modal + refetch, so backend owner-only 403s (impersonation.service.ts:600-602, 701-703) become silent no-ops; and while handleRevokeSession + the confirmAction.type==='revoke' branch exist (269-282, 1318-1319), no UI element ever sets that type, so the sanctioned operator-override POST /sessions/:id/terminate is dead code — a second admin cannot stop a colleague's session from this page.
- **Fix design:** Instance of the page-wide swallowed-catch class. Pattern fix: extract one async-action helper (await api call; on failure setPageError(message) and keep the modal open; on success close modal + refetch) and route ALL handlers (end/extend/revoke/grant/revokePermission) through it so silent failure becomes structurally impossible. Local fix: in the active-session row actions (~640-690), branch on ownership — session.superAdminId === currentAdminId renders End/Extend; otherwise render a 'Terminate' button that sets confirmAction {type:'revoke', id: session.id}, activating the existing revoke confirm branch (which already collects revokeReason). Add an RTL spec asserting (a) a rejected endSession surfaces the page error and leaves the session listed, (b) a non-owner session row exposes Terminate wired to impersonationApi.revokeSession.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.spec.tsx`
- **Effort:** M

### APA-296 [MEDIUM] Grant form drift: duration input allows 15-480 min vs backend @Max(60), and 'Allowed Actions' checkboxes are never sent

- **Status:** DESIGNED (brief)
- **Symptom:** The Max Session Duration input permits up to 480 minutes but GrantPermissionDto caps maxSessionDurationMinutes at IMPERSONATION_MAX_SESSION_MINUTES=60 (forbidNonWhitelisted global pipe) — any value 61-480 the UI accepts produces a 400. The read/write/admin 'Allowed Actions' checkboxes are collected in state but omitted from the grant payload, and the backend has no such field (capabilities live in defaultPermissions, which the FE never sets) — so every grant's session capabilities fall back to view-only defaults regardless of what the operator checks. Fails safe, but the security UI misrepresents what was granted.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1086-1093 (min 15 max 480)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:77-83 (@Max(IMPERSONATION_MAX_SESSION_MINUTES))`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:19 (cap = 60)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:287-294 (payload omits allowedActions)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:501-514 (grantedPerms fallback = view-only defaults)`
- **Root cause:** Grant modal drifted from GrantPermissionDto with no shared contract: the duration Input hardcodes max={480} (ImpersonationPage.tsx:1090) while the DTO enforces @Max(IMPERSONATION_MAX_SESSION_MINUTES)=60 (controller:82, entity:19) so 61-480 always 400s under forbidNonWhitelisted; and the read/write/admin allowedActions checkbox state is never mapped into the payload (handleGrantPermission:288-294 omits it) and matches no backend field — capabilities live in defaultPermissions (ImpersonationPermissions), so every grant falls back to view-only defaults (service:491-503) regardless of operator intent.
- **Fix design:** FE-type-drift class — fix at the contract. (1) Mirror IMPERSONATION_MAX_SESSION_MINUTES and the ImpersonationPermissions shape into the admin-panel impersonation types module and add a contract spec that imports both the FE constant/shape and the backend entity's exports and asserts equality, so drift fails CI. (2) Bind the Input max to the mirrored constant (min stays a UX floor; backend @Min(1) already accepts it). (3) Replace the fictional read/write/admin trio with checkboxes over the real six ImpersonationPermissions capabilities and send them as defaultPermissions in impersonationApi.grantPermission (the api fn already accepts defaultPermissions — services/api/impersonation.ts:34). Update permissionForm state/type accordingly and reset value.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `apps/admin-api-service/src/__tests__/impersonation-contract.spec.ts`
- **Effort:** M

### APA-297 [MEDIUM] Stats mislabeled and aggregates truncated to first 20 sessions (no pagination)

- **Status:** DESIGNED (brief)
- **Symptom:** The 'Total Sessions (30d)' card renders getImpersonationStats().totalSessions which is sessionRepo.count() over ALL time, not 30 days. The 'Actions Logged' card sums actionCount over the sessions state, which is one unpaginated getSessions() call — backend default limit 20 — so both this card and the History tab silently cap at the 20 most recent sessions with no pagination controls. A dedicated backend audit endpoint (GET /impersonation/audit/summary with real 30d windowing, top tenants, reason breakdown) exists but is never called by the page.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:469-470 ('Total Sessions (30d)' label)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:346-349 (count() all-time)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:497-499 (sum over sessions state)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:967-969 (default limit 20)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:499-508 (unused audit/summary endpoint)`
- **Root cause:** The 'Total Sessions (30d)' card (ImpersonationPage.tsx:469-470) renders getImpersonationStats().totalSessions which is sessionRepo.count() over all time (service:349); 'Actions Logged' (497-499) sums actionCount over the sessions state, which is one unpaginated getSessions() call capped by the backend default limit 20 (service:967-969) — same cap silently truncates the History tab, which has no pagination controls. The purpose-built GET /impersonation/audit/summary with real 30-day windowing (controller:499-508, service getAuditSummary) is never called.
- **Fix design:** Wire the page to the endpoint that owns the semantics instead of relabeling: add impersonationApi.getAuditSummary(startDate?, endDate?) returning the backend ImpersonationAuditSummary shape (mirror the type in services/types), fetch it in fetchData alongside the others, and drive the '(30d)' card and 'Actions Logged' card from summary fields; also feed the Audit Summary tab from it (real top-tenants/reason breakdown). Add server-side pagination to Session History: hold page state, pass {page, limit} to getSessions, render a pager from the returned total (the {items,total} envelope already carries it). RTL spec: stats cards read from the summary fetch and History pager requests page 2 with the correct query params.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.spec.tsx`
- **Effort:** M

### APA-298 [MEDIUM] GET /impersonation/permissions?tenantId=... 500s: ANY() applied to a jsonb column

- **Status:** DESIGNED (brief)
- **Symptom:** queryPermissions filters with ':tenantId = ANY(p.allowedTenants)' but allowedTenants is a jsonb column — Postgres rejects ANY/ALL on jsonb ('op ANY/ALL (array) requires array on right side'). The page calls getPermissions() without tenantId so it is latent here, but the documented API param is broken and any future caller (or the FE checkPermission flow) filtering by tenant gets a 500.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:320-324`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:210-211 (jsonb allowedTenants)`
- **Root cause:** allowedTenants/restrictedTenants are semantically UUID arrays but persisted as jsonb (impersonation-session.entity.ts:210-214); queryPermissions applies the SQL array operator ':tenantId = ANY(p.allowedTenants)' (impersonation.service.ts:323) which Postgres rejects on jsonb — every tenantId-filtered call to GET /impersonation/permissions 500s. Latent only because the page calls getPermissions() without tenantId.
- **Fix design:** Tier-1 fix at the storage type, not the query: migrate both columns to uuid[] (new migration: ALTER TABLE ... ALTER COLUMN "allowedTenants" TYPE uuid[] USING ARRAY(SELECT jsonb_array_elements_text("allowedTenants"))::uuid[], same for restrictedTenants, preserving NULLs), change the entity to @Column({ type: 'uuid', array: true, nullable: true }), after which the existing ANY() predicate is valid SQL and the type system matches the semantics (in-memory .includes() checks in canImpersonate are unaffected). Add an integration spec that seeds a permission and calls queryPermissions({tenantId}) against real Postgres so the operator/type mismatch class is caught at test time, not at the first filtered request.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
  - `apps/admin-api-service/src/migrations/<ts>-ImpersonationTenantArraysToUuidArray.ts`
  - `apps/admin-api-service/src/__tests__/integration/impersonation-permissions.integration.spec.ts`
- **Effort:** M

### APA-299 [LOW] targetTenantName is client-supplied and stored unverified into the session/audit record

- **Status:** DESIGNED (brief)
- **Symptom:** The FE sends the display name it happens to have cached; the backend persists it without cross-checking auth.tenants. The audit trail's human-readable tenant identity is therefore spoofable by the request author (mitigated by targetTenantId being the real key).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:233`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:117-120`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:517-521`
- **Root cause:** targetTenantName is an optional client-supplied field on StartImpersonationDto (controller:117-120) that the FE fills from its cached tenant list (ImpersonationPage.tsx:233) and the service persists verbatim into the session/audit record (service:521) — the human-readable tenant identity in the audit trail is author-controlled (targetTenantId remains the trustworthy key).
- **Fix design:** Server-side identity-resolution class (same as i12): remove targetTenantName from StartImpersonationDto and from the FE StartImpersonationRequest type/payload entirely, and have startImpersonation resolve the display name authoritatively from the tenant record by targetTenantId (inject the admin-api tenants read service the page's tenantsApi.search already fronts) before persisting — the wrong value becomes impossible because the field no longer crosses the trust boundary. forbidNonWhitelisted then rejects any client still sending it (BREAKING CHANGE footer on the request contract). Extend the impersonation service spec: started session stores the resolved name even when the request carries a spoofed one.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/impersonation.service.spec.ts`
- **Effort:** M

### APA-300 [LOW] Top-admins emails render 'Unknown' going forward (H-08 removed email from JWT)

- **Status:** DESIGNED (brief)
- **Symptom:** superAdminEmail is populated from the JWT (user.email), which post H-08 is absent, so new session rows store null and the stats topAdmins fallback shows 'Unknown' — the Audit Summary tab degrades to opaque UUID-keyed rows with no email backfill from auth-service.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:352-361 (user.email may be undefined)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:371-375 (email || 'Unknown')`
- **Root cause:** superAdminEmail is snapshotted from the JWT (controller:360 user.email) which H-08 deliberately removed, so new sessions persist null and getImpersonationStats' topAdmins falls back to 'Unknown' (service:373) — the Audit Summary degrades to UUID-only rows with no backfill path.
- **Fix design:** Same server-side identity-resolution class as i11: stop reading email from the request context at all; at startImpersonation resolve it by user.id from the authoritative admin-user record (admin-api's platform-admin store, or the signed HTTP client to auth-service per libs/backend-common service-identity) and persist that as the deliberate denormalized audit snapshot. Delete the user.email read from the controller so the removed-claim dependency cannot regress. Optionally one backfill migration setting superAdminEmail for null rows whose admin still resolves. Spec: startImpersonation stores the directory-resolved email when the JWT has no email claim; stats topAdmins never emits 'Unknown' for a resolvable admin.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  - `apps/admin-api-service/src/migrations/<ts>-BackfillImpersonationAdminEmail.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/impersonation.service.spec.ts`
- **Effort:** M


## DebugToolsPage — `/admin/system/debug` — verdict: **BROKEN**

**Chain:** FE (debugApi + databaseApi) -> /api/debug/* and /api/database/monitoring/connections. The /debug backend exists (DebugToolsController, PlatformAdminGuard SUPER_ADMIN) but is DISABLED by default: DebugToolsModule.forRoot() registers no controllers unless ENABLE_DEBUG_TOOLS=true, and that env var is set in no compose/env file in the repo (grep matched only the module + docs); production nginx additionally hard-404s 'location /api/debug'. So in every environment as shipped, the default Cache tab's calls 404 and the page shows 'Cache service unavailable'. Even when enabled, the cache surface is hollow: entries come from the admin.cache_entries_snapshot DB table whose only writer (POST /debug/cache/capture) has zero callers in the platform; all invalidation methods are logger no-op placeholders returning 0; and the list response shape ({entries,summary}) does not match the FE's PaginatedResult so entries could never render anyway. The Logs and Config tabs are explicit client-side TODO stubs; the SQL Query Executor throws client-side 'not yet implemented' (no arbitrary-SQL endpoint exists — a security positive contradicted by the scary production warning in the UI). The Database tab's only real call (GET /database/monitoring/connections, real pg_stat_activity query) is then used to FABRICATE connection rows client-side with hardcoded database/user/application values.

**Endpoints exercised:** `GET /api/debug/cache?limit=&keyPattern= (backend @Get('cache') ignores both params; 404 as deployed)`; `GET /api/debug/cache/stats (derived from snapshot table, not a real cache; 404 as deployed)`; `POST /api/debug/cache/invalidate (backend no-op, always returns {invalidated:0}; 404 as deployed)`; `DELETE /api/debug/cache/:key (backend no-op placeholder; 404 as deployed)`; `GET /api/database/monitoring/connections (real pg_stat_activity aggregate — the page's only working call)`; `Logs tab: no call (client TODO stub)`; `Config tab: no call (client TODO stub)`; `SQL executor: no call (client-side throw)`

**DB tables:** `admin.cache_entries_snapshot (Baseline.ts:185-187; never populated — capture endpoint has no callers)`, `admin.debug_sessions / admin.captured_queries / admin.captured_api_calls / admin.feature_flag_overrides (wired in debugApi but unused by this page; capture endpoints also have no producers)`, `pg_stat_activity (system view, via /database/monitoring/connections)`

### APA-301 [HIGH] Entire /debug backend is unreachable as deployed: module disabled by default (ENABLE_DEBUG_TOOLS unset anywhere) and nginx 404s /api/debug in production — yet the page ships in the admin nav

- **Status:** PENDING
- **Symptom:** DebugToolsModule.forRoot() returns an empty module unless ENABLE_DEBUG_TOOLS='true'; grep across the repo finds the flag set in no docker-compose/.env/deploy file. Production nginx independently returns 404 for 'location /api/debug' (H-3). The FE nav unconditionally links 'Debug Tools' and the default Cache tab fires 4 calls that all 404, surfacing a persistent 'Cache service unavailable' toast. The security posture (off by default) may be intentional, but shipping an operator page whose primary tab can never succeed in any environment is a broken product surface; there is no capability check or feature-flag awareness in the FE.
- **Evidence:**
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts:53-61 (empty module unless flag)`
  - `apps/admin-api-service/src/app.module.ts:235-237`
  - `infrastructure/nginx/droplet.conf:198-200 (location /api/debug { return 404; })`
  - `grep ENABLE_DEBUG_TOOLS: matches only module/docs, no env/compose sets it`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx:211 (unconditional nav item)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:101-126 (cache load -> 'Cache service unavailable')`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-302 [HIGH] Cache management is a placebo even when enabled: all invalidation paths are logger no-ops, and the FE fakes success on failure

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** CacheInspectorService.invalidateCacheByKey/invalidateCacheKey are empty placeholders that only log; invalidateCachePattern logs and returns 0 ('In production, this would use SCAN and DEL on Redis'). No RedisService is even injected. So 'Clear All Cache' (pattern '*') and per-entry 'Invalidate' touch no real cache anywhere and the endpoint truthfully reports {invalidated:0} — which the FE never checks. Worse, both FE handlers' catch blocks are labeled 'Mock success for demo': on error they close the confirm modal / optimistically remove the row from local state, so a failing destructive control is presented as having succeeded. MOCK_ONLY behavior on a SUPER_ADMIN operational control.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:118-138 (no-op invalidation, return 0)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:589-598 (returns {invalidated: count})`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:203-214 ('Mock success for demo' on clear)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:216-227 (optimistic local removal on error)`
- **Verification:** Every cited line verified verbatim. CacheInspectorService (cache-inspector.service.ts:118-138) has zero Redis wiring — constructor injects only the CacheEntrySnapshot repo; invalidateCacheByKey/invalidateCacheKey only this.logger.log, invalidateCachePattern logs and returns 0. Controller (debug-tools.controller.ts:589-598) returns {invalidated: count} = always {invalidated: 0}. Reachability confirmed end-to-end: DebugToolsModule.forRoot() registers the controller when ENABLE_DEBUG_TOOLS=true (debug-tools.module.ts:53-100); nginx /api->/api/v1 rewrite + PlatformAdminGuard complete the chain. Refutation attempts failed: (a) RedisService with del/deletePattern exists in @Global RedisModule registered at app.module.ts:188 — so a real cache backend was available and simply never wired; (b) prod protection makes it WORSE, not moot: droplet.conf:198 404s /api/debug but the FE route system/debug (Module.tsx:168) is unconditional, so a prod SUPER_ADMIN's 'Clear All Cache' 404s at nginx and DebugToolsPage.tsx:208-213 ('Mock success for demo') closes the confirm modal as success; per-entry handler (216-227) optimistically deletes the row from state on error; (c) tests cannot catch it — debug-tools.controller.spec.ts:52 mocks invalidateCachePattern to resolve 5. Real caches exist to purge (ReportsService 4h-TTL Redis report cache in the same service), so the deception has operational consequence. Same class also present in AdminDashboard.tsx:478-487 (silent-swallow clear cache on a production dashboard card). Severity HIGH upheld: deceptive success on a destructive SUPER_ADMIN operational control, reachable in every configuration (backend no-op when enabled; FE-faked success when blocked); not CRITICAL because there is no direct data/security compromise and debug tools are disabled by default (NEW-03).
- **Root cause:** The Service->cache-backend link of the chain was never built: CacheInspectorService was scaffolded against a DB snapshot table (CacheEntrySnapshot) with 'in production this would...' placeholder invalidation methods, despite RedisService (with del/deletePattern already implemented) being globally available in the same app. The drift persisted invisibly because both guardrails that should have exposed it were themselves fake: the controller unit spec mocks the service to resolve a nonzero count, and the FE handlers carry demo-era 'Mock success for demo' catch blocks that convert every failure (including prod nginx 404s) into visual success while ignoring the {invalidated} count the endpoint returns. FE, BE, and tests each independently simulated success, so no layer could ever observe the no-op.
- **Fix design:** This is an instance of two systemic classes — MOCK_ONLY backend control and FE-fakes-success-on-error — so the fix is applied at both the local and pattern level. BACKEND (make correct behavior automatic): inject RedisService into CacheInspectorService via ordinary constructor injection (RedisModule is @Global in app.module.ts:188, no module wiring change needed). Implement the three methods for real: invalidateCacheByKey(key) -> `const invalidated = await redis.del(key); await cacheSnapshotRepo.delete({ key }); return invalidated;`; invalidateCacheKey(tenantId, key) -> delete via the platform tenant key convention (reuse TenantRedisService/the shared tenant prefix from libs/backend-common/src/redis — do NOT re-derive the prefix locally); invalidateCachePattern(tenantId, pattern) -> redis.deletePattern (SCAN + batched DEL already exists at redis.service.ts:159) scoped by tenant prefix when tenantId is set, purge matching CacheEntrySnapshot rows so the inspector view reflects reality, return the REAL count. Fail closed: because app-level Redis mode is 'optional', each invalidation method throws ServiceUnavailableException when the Redis client is absent — a destructive control must never silently no-op (tier 1: wrong behavior impossible). Change signatures to return the count everywhere (facade debug-tools.service.ts and controller) so every invalidation route uniformly returns {invalidated: n} — no fabricated 204-void paths. FRONTEND (make deception impossible): delete both 'Mock success for demo' catch blocks in DebugToolsPage.tsx — on failure setError(...) and leave the confirm modal open / do NOT filter the row out of local state; on success read the returned {invalidated} count and render it ('Invalidated N keys'), making the BE contract load-bearing so a future no-op regression (0 with entries present) is user-visible. Apply the same-class fix to AdminDashboard.tsx handleClearCache (lines 478-487): replace the empty catch with surfaced error state. Align debug.ts types so invalidateCacheEntry also returns {invalidated: number}. PATTERN GATE (tier 3): add tests/invariants/no-fake-success-handlers.spec.ts, a grep invariant (same style as nats-invariants/schema-invariants) failing on any 'Mock success' / 'mock success' marker under web/modules/**/src, pinning the whole class out of the codebase.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts`
  - `apps/admin-api-service/src/impersonation/services/debug-tools.service.ts`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/controllers/__tests__/debug-tools.controller.spec.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/cache-inspector.service.spec.ts`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `web/modules/admin-panel/src/pages/AdminDashboard.tsx`
  - `web/modules/admin-panel/src/services/api/debug.ts`
  - `tests/invariants/no-fake-success-handlers.spec.ts`
- **Proof of fix:** 1) New apps/admin-api-service/src/impersonation/services/__tests__/cache-inspector.service.spec.ts: asserts invalidateCachePattern delegates to RedisService.deletePattern and returns its actual count (and purges matching snapshot rows); invalidateCacheByKey delegates to redis.del; all three throw ServiceUnavailableException when the Redis client is absent (fail-closed — proves the no-op is structurally gone). 2) Extend apps/admin-api-service/src/impersonation/controllers/__tests__/debug-tools.controller.spec.ts: mocked service count must flow through to the {invalidated} envelope on every invalidation route (no fabricated response). 3) New DebugToolsPage handler test (web/modules/admin-panel/src/pages/system/__tests__/DebugToolsPage.spec.tsx): on rejected invalidateCacheEntry/invalidateCacheByPattern the row remains in the list, the confirm modal does not report success, and an error is rendered; on success the returned count is displayed. 4) New grep invariant tests/invariants/no-fake-success-handlers.spec.ts: zero occurrences of 'Mock success' (case-insensitive) under web/modules/**/src — pins the systemic class, catches AdminDashboard and any future reintroduction.
- **Effort:** M

### APA-303 [HIGH] Cache entries/stats are DB snapshots that nothing ever writes, with a fabricated hit-rate formula — and the FE response-shape mismatch means entries could never render regardless

- **Status:** PENDING
- **Symptom:** GET /debug/cache reads admin.cache_entries_snapshot, whose only writer is POST /debug/cache/capture — grep shows no caller anywhere except the controller's own spec. The table is perpetually empty (plus a daily cron deletes >7d rows), so this is not a Redis inspector at all. getCacheStats computes hitRate = totalHits/(totalHits+totalEntries)*100 — a meaningless formula presented as 'Hit Rate %'. Independently, the backend list returns {entries, summary} while the FE expects PaginatedResult and reads response.data — undefined — so even seeded data would render as 'No cache entries found'; the FE's keyPattern/limit query params are also silently ignored by the controller (@Query('tenantId'/'debugSessionId'/'cacheStore') only).
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:27-78 (snapshotCache -> {entries, summary})`
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:143-183 (hitRate formula :169)`
  - `grep 'cache/capture|captureCacheEntry' — writers exist only in controller/facade/spec, no producer`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:105-109 (.data || [] on non-paginated shape)`
  - `web/modules/admin-panel/src/services/api/debug.ts:72-73 (expects PaginatedResult; sends keyPattern/limit)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:560-567 (params ignored)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-304 [HIGH] 'Active Connections' table is fabricated in the FE: hardcoded database/user/application/state values synthesized from a bare count

- **Status:** PENDING
- **Symptom:** loadDatabaseData calls the real GET /database/monitoring/connections (genuine pg_stat_activity aggregate) but then manufactures N rows as {database:'aquaculture_prod', user:'app_user', applicationName:'service-N', state:'active'} from response.active alone. Every cell except the row count is invented; the Query/Duration columns can never populate. A SUPER_ADMIN debugging a production incident is shown fake connection identities presented as live data — silent wrong data on a diagnostic surface.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:144-164 (fabricated rows)`
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:93-128 (backend returns aggregate counts only, no per-connection rows)`
  - `web/modules/admin-panel/src/services/api/database.ts:167-168`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-305 [MEDIUM] Log Viewer and Config Viewer tabs are client-side TODO stubs (NOT_WIRED features shipped in the UI)

- **Status:** DESIGNED (brief)
- **Symptom:** loadLogs and loadConfig set an empty list and an error string ('Log viewer API not yet implemented' / 'Config viewer API not yet implemented') without any network call — two of the page's four tabs are pure chrome. The Config tab even ships a 'Show Secrets' toggle and a secret-redaction column for an API that does not exist (no secret exposure occurs, but the control implies backend secret access is one flag away).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:128-142 (loadLogs TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:166-180 (loadConfig TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:748-759 (Show Secrets toggle)`
- **Root cause:** NOT_WIRED facade class: loadLogs (DebugToolsPage.tsx:128-142) and loadConfig (166-180) make no network call — they set empty data plus a hardcoded 'not yet implemented' error — yet the Logs and Config tabs ship as full UI, including a 'Show Secrets' toggle (748-759) for a config API that does not exist.
- **Fix design:** Features that don't exist must not render: remove the Logs and Config tabs, their state (logLevel/logContext/logSearch/configCategory/configSearch/showSecrets), loadLogs/loadConfig, and the Show Secrets control (UI must never imply secret access absent the capability). If log/config viewing is wanted product, that is tracked new work (Logs could front the existing /debug/api-calls captured-call surface; Config the config-service) under a finding ID with owner+deadline. Pattern-level gate shared with i5: an invariant spec that scans web/modules/admin-panel/src/pages for facade markers ('not yet implemented', 'TODO: Implement ... API') and fails CI, so shipped stubs become detectable.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `tests/invariants/admin-panel-no-facade-features.spec.ts`
- **Effort:** S

### APA-306 [MEDIUM] SQL Query Executor is a facade: warns about executing on the production database, then always throws client-side

- **Status:** DESIGNED (brief)
- **Symptom:** handleExecuteQuery unconditionally throws 'Query execution API endpoint not yet implemented' — no request is made and no arbitrary-SQL endpoint exists in admin-api (verified: no such route in DebugToolsController; the analyze-query monitoring endpoint is EXPLAIN-only). Security-positive: no remote SQL execution surface exists. Product-negative: the UI presents a full editor, 10k-char textarea, results grid, and a 'Warning: This will execute queries on the production database' banner for a capability that does not exist. Note the adjacent /database/explorer row-CRUD endpoints (out of this section's scope) provide a real generic table read/write surface, so any future wiring of this textarea must not route there without parameterization review.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:229-244 (unconditional throw)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:598-611 (production warning banner)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts (no SQL-execution route present)`
- **Root cause:** Same NOT_WIRED facade class: handleExecuteQuery (DebugToolsPage.tsx:236-238) unconditionally throws 'Query execution API endpoint not yet implemented' — no request is ever made and DebugToolsController intentionally has no arbitrary-SQL route — yet the tab ships a 10k-char editor, results grid, and a 'executes on the production database' warning banner (598-611).
- **Fix design:** Delete the SQL Query Executor block (queryInput/queryExecuting/queryError/queryResult state, handleExecuteQuery, textarea, warning banner, results grid) from the database tab, keeping the real connection-stats view. Deliberately do NOT add a SQL-execution endpoint — the absence is the security posture; any future query capability must be a reviewed, parameterized design that does not route through the generic /database/explorer row-CRUD surface. Covered by the same admin-panel-no-facade-features invariant spec as i4, which prevents this class from shipping again.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `tests/invariants/admin-panel-no-facade-features.spec.ts`
- **Effort:** S

### APA-307 [MEDIUM] Route-declaration-order shadowing in DebugToolsController makes two endpoints unreachable

- **Status:** DESIGNED (brief)
- **Symptom:** @Get('feature-overrides/:id') is declared before @Get('feature-overrides/value'), so GET /debug/feature-overrides/value resolves :id='value' and hits getFeatureOverride with a non-UUID (Postgres uuid cast error -> 500) — the feature-flag value endpoint is dead. Likewise DELETE 'cache/:tenantId/:key' (declared first) captures DELETE /debug/cache/tenant/<id>, shadowing DELETE 'cache/tenant/:tenantId' with tenantId='tenant'. Neither is called by this page, but both are part of the published debug API surface.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:662-665 (':id' before 'value')`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:667-692 (shadowed 'value' route)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:600-616 (cache/:tenantId/:key before cache/tenant/:tenantId)`
- **Root cause:** Nest matches routes in declaration order within a controller: @Get('feature-overrides/:id') (debug-tools.controller.ts:662) precedes @Get('feature-overrides/value') (667), so /debug/feature-overrides/value binds id='value' and 500s on the uuid cast; @Delete('cache/:tenantId/:key') (600) precedes @Delete('cache/tenant/:tenantId') (609), so DELETE /debug/cache/tenant/<id> runs invalidateCacheKey('tenant', <id>) — both published routes are permanently unreachable.
- **Fix design:** Route-declaration-order is a systemic class. Local: reorder so literal-segment routes precede param siblings ('feature-overrides/value' above ':id'; 'cache/tenant/:tenantId' above 'cache/:tenantId/:key'), and add ParseUUIDPipe to :id/:tenantId params so a non-UUID can never reach the repository as a 500 (tier-1: 400 at the edge). Pattern: add an architecture spec that instantiates the admin-api testing module, walks each controller's method decorators in declaration order via Reflect PATH_METADATA, and fails when a route with a literal segment is preceded by a same-method param route that captures it — applied to every admin-api controller so the class is detectable at build time.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/__tests__/route-shadowing.architecture.spec.ts`
- **Effort:** M

### APA-308 [LOW] Cache key is URL-decoded twice (FE encode -> Express decode -> controller decodeURIComponent)

- **Status:** DESIGNED (brief)
- **Symptom:** Express already decodes route params; the controller decodes again in getCacheEntry/invalidateCacheByKey, so any key containing a literal %-sequence (e.g. 'rate%20limit') is corrupted before lookup/deletion.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/debug.ts:74-76 (encodeURIComponent)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:578-587 (second decodeURIComponent)`
- **Root cause:** Double decode: the FE encodes the cache key once (debug.ts:74-76 encodeURIComponent), Express decodes route params before Nest binds them, and getCacheEntry/invalidateCacheByKey decode AGAIN (debug-tools.controller.ts:580,586) — any key containing a literal %-sequence (e.g. 'rate%20limit') is corrupted ('rate limit') before lookup/deletion.
- **Fix design:** Single-decode contract: the framework owns param decoding, so delete both decodeURIComponent calls and pass @Param('key') through untouched (FE encodeURIComponent + Express decode is already an exact round-trip, including %2F which path-to-regexp keeps within one segment). Prove it with a controller-level e2e/supertest case requesting /debug/cache/rate%2520limit and asserting the service receives the literal 'rate%20limit' for both GET and DELETE, which pins the contract against reintroduction.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/debug-tools.controller.spec.ts`
- **Effort:** S


## Cross-cutting findings

### APA-309 [HIGH] Platform audit trail is best-effort by construction: AuditLogService.log swallows every persistence failure while security-critical callers document reliance on propagation

- **Status:** PENDING
- **Symptom:** admin-api's central AuditLogService.log wraps the save in try/catch and returns null on failure ('Don't throw - audit logging should not break main operations'). Every admin-api surface that awaits it for compliance-grade guarantees — most explicitly the impersonation lifecycle, whose AUDITTRAIL-CRITICAL-003 comments claim the await makes audit failures propagate — actually gets a silent null. A SUPER_ADMIN cross-tenant session (or any audited admin action) can complete with no audit row and no operator-visible error, contradicting the SOC2 CC1 / GDPR Art 30 reconstruction claims embedded in the code. Either log() must offer a throwing strict mode for CRITICAL actions, or the callers' claims must be corrected and the gap tracked.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.service.ts:84-107`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:551-575`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-310 [HIGH] DB immutability triggers were applied to an operational (mutable-lifecycle) table, not just audit tables — schema policy and service behavior are in direct conflict

- **Status:** PENDING
- **Symptom:** The Baseline migration applies the same append-only trigger pattern to admin.audit_logs (correct — insert-only) AND admin.impersonation_sessions (incorrect — the entity has a status/endedAt/expiresAt/actionCount lifecycle mutated by five service paths and a cron). No test or invariant catches a trigger that contradicts entity write patterns; the drift validator checks columns/schemas, not DML permissions. Any future 'protected-tables-guard' addition can silently break a service the same way. An invariant (e.g. e2e asserting UPDATE succeeds on lifecycle tables, or a lint tying append-only triggers to a declared insert-only entity list) is needed.
- **Evidence:**
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:249-280`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:604-608,650-654,727-745,893-896,1091-1097`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-311 [MEDIUM] Hand-written FE types with no codegen have drifted to the point of conceptual inversion

- **Status:** PENDING
- **Symptom:** The admin-panel's services/types are maintained by hand against admin-api. In this section that produced: an ImpersonationPermission FE type sharing only id/isActive/grantedAt/expiresAt with the backend entity (and modeling per-tenant grants where the backend models per-admin grants), a cache list typed as PaginatedResult against a {entries,summary} response, and a revoke call whose parameter is named superAdminId while the page passes a permission id. Field-level drift here is not cosmetic — it produces render crashes, permanent 404s, and permanently-empty tables. A codegen or contract-test layer (OpenAPI from the Nest controllers, or response-shape assertions in CI) is the architectural fix.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/impersonation.ts:25-39 vs apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:192-251`
  - `web/modules/admin-panel/src/services/api/debug.ts:72-73 vs apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:68-77`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-312 [MEDIUM] Backend feature availability (env flags, nginx blocks) is invisible to the admin-panel: pages ship for surfaces that are disabled by design

- **Status:** PENDING
- **Symptom:** DebugToolsModule is off unless ENABLE_DEBUG_TOOLS=true and production nginx 404s /api/debug outright, yet the admin nav unconditionally renders the Debug Tools page; similarly the Impersonation page ships an 'Open Tenant Portal' action for an access mechanism no client implements. There is no capability/feature-flag handshake between admin-api and the panel (e.g. a /capabilities endpoint or config-service flag the nav consumes), so operators encounter dead tools with generic error toasts instead of an honest 'disabled in this environment' state.
- **Evidence:**
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts:53-61`
  - `infrastructure/nginx/droplet.conf:198-200`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx:210-211`
  - `web/shell/src/App.tsx:288-300`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-313 [LOW] NestJS static-segment routes declared after parameterized siblings are shadowed — recurring pattern risk

- **Status:** PENDING
- **Symptom:** DebugToolsController has two instances (feature-overrides/value after feature-overrides/:id; cache/tenant/:tenantId after cache/:tenantId/:key). ImpersonationController got the ordering right (sessions/validate, sessions/active before sessions/:id), showing the team knows the rule but has no lint/test enforcing it. A controller-route-ordering invariant test would make this class of bug detectable at build time.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:600-616,662-692`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:426-449`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).
