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

# Impersonation & Debug Tools — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the
> verified severity where status is CONFIRMED, else the auditor's grade pending verification.

## ImpersonationPage — `/admin/system/impersonation` — verdict: **BROKEN**

**Chain:** FE (services/api/impersonation.ts) -> nginx '/api/' catch-all rewrites /api/X to
/api/v1/X (infrastructure/nginx/droplet.conf:377-383) -> admin-api-service global prefix 'api/v1' +
VERSION_NEUTRAL versioning (libs/backend-common/src/bootstrap/create-service-app.ts:610,799-810;
apps/admin-api-service/src/main.ts:17-19) -> ImpersonationController guarded by PlatformAdminGuard
(SUPER_ADMIN only, RS256 JWT: impersonation.controller.ts:281 plus global APP_GUARD
app.module.ts:283-286) -> ImpersonationService -> admin.impersonation_sessions /
admin.impersonation_permissions (created in 1800000000000-Baseline.ts) + admin.audit_logs. The
{success,data,meta} envelope from ResponseInterceptor is correctly unwrapped by http-client for all
three list shapes. READ chains verified real-to-DB (sessions, permissions, stats). Security
positives verified: token stored SHA-256-hashed, SafeImpersonationSession strips token columns on
every read path, ThrottleSensitive on start/end/terminate/extend, Redis rate-limit on start, IP
binding on validate, audit rows written for start/end/terminate/extend/expire. HOWEVER: (1) the
Baseline migration installs a BEFORE UPDATE OR DELETE trigger on admin.impersonation_sessions that
raises on ANY update while the service ends/terminates/extends/expires/log-actions via repo.save()
UPDATEs — all session-lifecycle mutations 500; (2) the raw impersonation token returned at start is
discarded by the FE and consumed by no client anywhere, so actual impersonated tenant access is
impossible; (3) the Permissions tab renders a hand-written FE type that shares almost no fields with
the backend entity and crashes on real data.

**Endpoints exercised:**
`GET /api/impersonation/sessions (matches @Get('sessions'), default limit 20)`;
`GET /api/impersonation/permissions (matches @Get('permissions'); tenantId filter param is latently broken)`;
`GET /api/impersonation/stats (matches @Get('stats'))`;
`GET /api/admin/tenants/search?q=&limit=100 (tenant.controller.ts:136,176 — tenant dropdown)`;
`POST /api/impersonation/sessions/start (StartImpersonationDto — works only until DB trigger side-effects lock the admin out)`;
`POST /api/impersonation/sessions/:id/end (500s at DB trigger)`;
`POST /api/impersonation/sessions/:id/extend (500s at DB trigger)`;
`POST /api/impersonation/sessions/:id/terminate (500s at DB trigger; also unreachable from UI — no button sets confirmAction type 'revoke')`;
`POST /api/impersonation/permissions (GrantPermissionDto)`;
`POST /api/impersonation/permissions/:superAdminId/revoke (FE passes wrong identifier — always 404)`;
`getSessionActions: client-side stub that throws — no backend GET for session actions`

**DB tables:**
`admin.impersonation_sessions (Baseline.ts:165-170; append-only trigger Baseline.ts:266-280)`,
`admin.impersonation_permissions (Baseline.ts:171-172)`,
`admin.audit_logs (Baseline.ts:8; append-only trigger Baseline.ts:249-264)`

### APA-288 [CRITICAL] DB append-only trigger on impersonation_sessions makes every session-lifecycle mutation fail (end/terminate/extend/expire/log-action all 500; live sessions unrevocable; starts eventually hard-blocked)

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The active Baseline migration creates trigger
  trg_impersonation_sessions_prevent_update which RAISEs an exception on any UPDATE or DELETE of
  admin.impersonation_sessions ('append-only ... UPDATE/DELETE refused'), and no later migration
  drops it (grep over apps/admin-api-service/src/migrations found only the Baseline create and its
  down()). But ImpersonationService mutates existing rows via sessionRepo.save() in
  endImpersonation, terminateSession, extendSession, logAction, logResourceAccess and the
  every-minute expireOldSessions cron. Consequences: (a) End Session / Extend / Terminate buttons
  always 500 — an in-flight impersonation credential CANNOT be revoked or killed (security hole: the
  kill-switch documented as AUDITTRAIL/H26/H21 fixes is dead); (b) the expiry cron throws every
  minute forever, and rows stay status='active' in the DB permanently; (c) canImpersonate counts
  ACTIVE rows against maxConcurrentSessions (default 3), so after 3 starts an admin is permanently
  locked out with 'Maximum concurrent sessions reached'; (d) validateSession on an expired session
  calls expireSession -> save -> throws -> 500; (e) revokeImpersonationPermission calls
  endAllSessionsForAdmin -> endImpersonation -> 500 whenever the admin has active sessions; (f) the
  in-session action log (logAction) can never persist, so the per-session audit array is permanently
  empty. The DB immutability guard and the mutable session lifecycle are architecturally
  contradictory.
- **Evidence:**
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:266-280 (trigger + REVOKE UPDATE,DELETE)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:604-608 (endImpersonation save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:650-654 (terminateSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:727-745 (extendSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:893-896 (logAction save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:1091-1097 (expireSession save, called by EVERY_MINUTE cron at :1072-1089)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:416-424 (ACTIVE count vs maxConcurrentSessions)`
- **Verification:** Verified end-to-end. (1) Active Baseline
  (apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:265-280) creates
  trg_impersonation_sessions_prevent_update BEFORE UPDATE OR DELETE FOR EACH ROW that
  unconditionally RAISEs; grep of all 18 active migrations and runtime code shows nothing drops it
  (only Baseline down(); .archive/ excluded by the src/migrations/[0-9]\*.ts glob in both
  data-source.ts:35 and app.module.ts:117; synchronize:false so schema comes only from migrations).
  (2) Entity maps exactly to admin.impersonation_sessions (impersonation-session.entity.ts:57). (3)
  All six mutation paths load an existing row and repo.save() it (UPDATE by id): endImpersonation
  :604-608, terminateSession :650-654, extendSession :727-745, logAction :893-896, logResourceAccess
  :926-927, expireSession :1091-1097 driven by @Cron(EVERY_MINUTE) :1072 (ScheduleModule imported in
  impersonation.module.ts). A BEFORE trigger fires for every role including the table owner, so
  every UPDATE fails regardless of grants. (4) Fully reachable from FE:
  impersonationApi.endSession/extendSession/terminateSession
  (web/modules/admin-panel/src/services/api/impersonation.ts:72-78) hit @Controller('impersonation')
  routes sessions/:id/end|terminate|extend (controller :372/:388/:404). (5) Consequences confirmed:
  INSERT allowed, so sessions start then can never leave ACTIVE; canImpersonate counts ACTIVE vs
  maxConcurrentSessions default 3 (entity :222, service :416-421) => permanent lockout after 3
  starts; validateSession on expired session calls expireSession->save->throws (:814-816);
  revokeImpersonationPermission->endAllSessionsForAdmin->endImpersonation throws (:777-785); cron
  throws every minute forever. (6) No gate catches it: unit tests mock the repo;
  e2e/tests/integration/audit-immutability.spec.ts only covers audit_logs; no e2e references
  impersonation_sessions. CRITICAL stands: the kill-switch for a live SUPER_ADMIN impersonation
  credential (H26/H21/terminate) is dead, and the feature hard-bricks after 3 uses per admin.
  Adversarial digging found the root cause is deeper than stated: the trigger is MANDATED by a
  triple-hardcoded classification of admin.impersonation_sessions as an append-only audit ledger —
  libs/backend-common/src/constants/protected-tables.ts:130 (PROTECTED_TABLES SSoT),
  scripts/migration/baseline-generator.ts:330-339 (hardcoded PROTECTED_TABLE_NAMES whose audit FAILS
  a regenerated baseline lacking the trigger — dropping the trigger alone would be reintroduced at
  next baseline regen), and scripts/migration/apply-audit-immutability.mjs:32 (TARGETS list that
  injected it). The service's own comments (:613-616, :753-754) state the table is 'operational, not
  audit' and every lifecycle transition already writes the regulatory record to audit_logs via
  auditLogService (AUDITTRAIL-CRITICAL-003).
- **Root cause:** The BE->DB link broke via a category error propagated by tooling:
  admin.impersonation_sessions was classified as an append-only AUDIT ledger in the compliance layer
  (protected-tables.ts:130) and in two hardcoded copies of that list (baseline-generator.ts:330-339,
  apply-audit-immutability.mjs:32), and the Faz 3.5 script mechanically injected an unconditional
  UPDATE/DELETE-refusing trigger into the Baseline. But the table is an operational session-state
  machine (active->ended/expired/terminated, expiresAt extension, in-row action log) whose owning
  service UPDATEs it on every lifecycle transition — the service code itself documents it as
  'operational, not audit' (impersonation.service.ts:613-616, :753-754), with the regulatory audit
  trail already duplicated into audit_logs
  (IMPERSONATION_STARTED/ENDED/TERMINATED/EXTENDED/EXPIRED). Drift persisted because (a) the
  protected-table classification conflates two distinct contracts — 'protected from destructive DDL'
  and 'append-only rows' — in one list, (b) the classification lives in three hardcoded copies
  instead of one SSoT consumed by all tools, and (c) no build/test gate exercises an impersonation
  session state transition against a real migrated schema (unit tests mock the repo; the invariant
  tests only assert triggers EXIST, never that the owning service's write-set is compatible with
  them).
- **Fix design:** Systemic class: config/compliance-contract-nobody-reconciled — the append-only DB
  guard and the mutable domain lifecycle are contradictory contracts; fix at the classification
  SSoT, not by just dropping the trigger (which the baseline-generator audit would reinstate).
  Tier-1 design: (A) ADR (docs/adr/037-impersonation-session-lifecycle-guard.md, required by
  protected-tables.ts's own removal rules + arbiter approval): reclassify
  admin.impersonation*sessions from append-only ledger to lifecycle-guarded operational table —
  identity columns tamper-proof, legal state machine enforced, hard-delete refused; regulatory audit
  remains admin.audit_logs. (B) Split the conflated concept in
  libs/backend-common/src/constants/protected-tables.ts: keep PROTECTED_TABLES (destructive-DDL
  guard — impersonation_sessions STAYS listed, DROP TABLE still waiver-gated) and add two exported
  subsets: APPEND_ONLY_TABLES (the true ledgers: audit_logs, payroll_audit, etc.) and
  LIFECYCLE_GUARDED_TABLES ({ table: 'admin.impersonation_sessions', immutableColumns: [id,
  superAdminId, superAdminEmail, targetTenantId, targetUserId, reason, reasonDetails,
  ticketReference, ipAddress, userAgent, originalSessionToken, impersonationToken, createdAt],
  transitions: active->ended|expired|terminated, deleteRefused: true }). (C) New migration
  apps/admin-api-service/src/migrations/1801600000000-ImpersonationSessionLifecycleGuard.ts (never
  hand-edit Baseline; carries -- COMPLIANCE-WAIVER: marker + this finding ID since it alters a guard
  on a PROTECTED_TABLES entry, per migration-sql-lint R13): DROP TRIGGER
  trg_impersonation_sessions_prevent_update + its function; CREATE FUNCTION
  admin.impersonation_sessions_lifecycle_guard() BEFORE UPDATE — RAISE if any immutable column
  changes (OLD.x IS DISTINCT FROM NEW.x), RAISE if OLD.status is terminal (row frozen), RAISE on any
  transition other than active->ended|expired|terminated; separate BEFORE DELETE trigger always
  RAISEs (no-hard-delete preserved); keep REVOKE DELETE, leave UPDATE governed by the trigger. This
  makes the wrong behavior (tampering with attribution, resurrecting/deleting sessions) impossible
  at the DB while making the correct behavior (lifecycle transitions, extendSession, logAction) work
  with zero service-code change. (D) Kill the triple-hardcode: baseline-generator.ts imports
  APPEND_ONLY_TABLES/LIFECYCLE_GUARDED_TABLES from the SSoT instead of its local
  PROTECTED_TABLE_NAMES array, expecting trg*<tbl>\_prevent_update for append-only entries and the
  lifecycle-guard trigger pair for lifecycle-guarded ones; apply-audit-immutability.mjs drops
  impersonation_sessions from TARGETS (script is superseded for that table). (E) Extend
  tests/invariants/protected-tables-guard.spec.ts to assert the generator/script table sets are
  imported from (not copies of) the SSoT, and that every APPEND_ONLY table's owning entity has no
  @UpdateDateColumn-bearing mutable lifecycle (append-only vs write-path parity).
- **Files to change:**
  - `apps/admin-api-service/src/migrations/1801600000000-ImpersonationSessionLifecycleGuard.ts`
  - `libs/backend-common/src/constants/protected-tables.ts`
  - `scripts/migration/baseline-generator.ts`
  - `scripts/migration/apply-audit-immutability.mjs`
  - `tests/invariants/protected-tables-guard.spec.ts`
  - `e2e/tests/integration/impersonation-session-lifecycle.spec.ts`
  - `e2e/tests/integration/audit-immutability.spec.ts`
  - `docs/adr/037-impersonation-session-lifecycle-guard.md`
- **Proof of fix:** New integration spec
  e2e/tests/integration/impersonation-session-lifecycle.spec.ts against real migrated Postgres: (1)
  INSERT active session, UPDATE status->'ended' + endedAt/endReason SUCCEEDS (proves
  end/terminate/expire path live); (2) UPDATE expiresAt + actionsPerformed + actionCount on active
  row SUCCEEDS (extend/logAction path); (3) UPDATE superAdminId (or createdAt/impersonationToken) is
  REFUSED by admin.impersonation_sessions_lifecycle_guard; (4) UPDATE on a row already in 'ended'
  status is REFUSED (terminal freeze); (5) DELETE is REFUSED; (6) trigger inventory query (mirroring
  audit-immutability.spec.ts:119-131) asserts the lifecycle-guard trigger pair exists and
  trg_impersonation_sessions_prevent_update does NOT. Extend
  tests/invariants/protected-tables-guard.spec.ts to fail if baseline-generator.ts or
  apply-audit-immutability.mjs carries a table list not imported from protected-tables.ts, and to
  fail if any APPEND_ONLY_TABLES entry maps to an entity whose service performs lifecycle UPDATEs.
  Existing service unit specs (impersonation.session-cap.spec.ts etc.) stay green — no service code
  changes.
- **Effort:** M

### APA-289 [CRITICAL] Impersonation access chain is not wired end-to-end: the issued token is discarded and nothing can consume it — the feature cannot actually access a tenant

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** startImpersonation returns the raw impersonationToken exactly once
  (StartedImpersonationSession), but handleStartImpersonation ignores the response entirely. The
  'Open Tenant Portal' button opens /tenant?impersonation_session=<session.id> — a session id, not
  the token; a repo-wide grep shows NOTHING consumes an 'impersonation_session' query param, and the
  shell's /tenant/\* route is gated by ProtectedRoute requiredRoles=['TENANT_ADMIN'] (+ tenant
  capabilities), which a SUPER_ADMIN JWT does not carry, so the tab dead-ends at the role gate. The
  backend validate endpoint (GET /impersonation/sessions/validate reading header
  x-impersonation-token) has zero callers anywhere in the repo (FE, gateway, middleware — grep for
  x-impersonation-token matches only the controller). Net effect: the platform mints a scoped,
  time-limited, hashed, IP-bound credential that no code path can ever present. The page can start
  and list sessions, but impersonation as a capability (viewing/acting on tenant data) does not
  exist.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:231-237 (start response discarded)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:664-673 (opens /tenant?impersonation_session=<id>)`
  - `web/shell/src/App.tsx:288-300 (/tenant/* requires TENANT_ADMIN)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:426-434 (validate endpoint, x-impersonation-token header)`
  - `grep 'x-impersonation-token|impersonation_session' across repo: only the controller and the ImpersonationPage URL construction match`
- **Verification:** Verified against source. Confirmed: (1) impersonation.service.ts:582 returns the
  raw token exactly once and ImpersonationPage.tsx:231-237 awaits startSession() without capturing
  the response — the credential is discarded at issuance; (2) ImpersonationPage.tsx:668 opens
  /tenant?impersonation_session=<session.id> and repo-wide grep proves nothing consumes that param;
  (3) x-impersonation-token is read only by GET /impersonation/sessions/validate
  (impersonation.controller.ts:428), which itself sits behind controller-level PlatformAdminGuard,
  and has zero callers (grep: controller + its own spec only); (4) apps/gateway-api has zero
  impersonation integration. One sub-claim REFUTED: the tab does NOT dead-end at the role gate —
  ProtectedRoute uses hasRoleOrHigher and ROLE_HIERARCHY.SUPER_ADMIN includes TENANT_ADMIN
  (web/shell/src/App.tsx:102-114, web/shared-ui/src/contexts/AuthContext.tsx:163-167), and
  App.tsx:124 exempts SUPER_ADMIN from the tenant check, so the portal loads. The actual dead-end is
  tenant-context resolution: the tenant-admin module keys all data off getTenantId(), which is null
  for SUPER_ADMIN (AuthContext only ever calls setTenantId(user.tenantId ?? null); nothing maps
  impersonation_session → target tenant), so no X-Tenant-Id header is sent,
  EffectiveTenantMiddleware resolves effectiveTenantId = null, and tenant-scoped ops fail closed
  (its own comment, effective-tenant.middleware.ts:156-159) — portal renders with no data. Net
  outcome identical to the finding: the impersonation feature cannot view or act on tenant data.
  Severity stays CRITICAL for a dual failure: a flagship security-sensitive capability is dead
  end-to-end, AND the only live cross-tenant channel (gateway act-as via
  x-act-as-tenant/x-tenant-id, reachable today by a SUPER_ADMIN hand-planting localStorage tenantId
  since getTenantId() falls back to storage) is completely unbound from impersonation sessions — the
  exact 'ambient impersonation' gap the repo's own research flags as breach-equivalent
  (docs/research/admin-expert/2026-04-08-impersonation-security-mfa-audit.md:74). Actual
  cross-tenant access would leave zero impersonation_sessions record, defeating the SOC 2
  access-reconstruction purpose behind that table's 7-year retention
  (docs/compliance/retention-matrix.md:71). The governance plane (permission grants, token hashing,
  IP binding, time-box, action logs) is decorative.
- **Root cause:** The broken link is issued-credential → presentation: two parallel designs for
  SUPER_ADMIN cross-tenant scope evolved independently and were never joined. Design A
  (admin-api-service bounded context): token-based ImpersonationSession — hashed, IP-bound,
  time-boxed credential plus a validate endpoint — built self-contained with no consumer ever wired.
  Design B (gateway tenant-context SSoT): act-as header captured pre-strip by
  CaptureRequestedTenantMiddleware, validated by EffectiveTenantMiddleware, signed as
  effectiveTenantId into the HMAC verified-user assertion — the only channel subgraphs actually
  trust. The FE ImpersonationPage was written against A's start/list/end endpoints, but the access
  hop (attach credential → validate → grant scope) was never implemented in either design's terms:
  the FE discards the token, no middleware reads x-impersonation-token, the portal link passes a
  session id nobody consumes, and Design B grants scope with no session requirement at all. It
  drifted because no end-to-end test asserts the minted credential has a consumer — each half is
  unit-tested green in isolation. This is an instance of the systemic classes 'credential/config
  minted that nobody reads' and 'FE flow with no backend consumer'; the repo's own design-of-record
  already mandates the join (research doc: X-Act-As-Tenant without a matching active
  ImpersonationSession must not be allowed) but it was never built.
- **Fix design:** Bind the access plane to the governance plane so ungoverned cross-tenant access is
  structurally impossible (tier 1) and governed access is automatic (tier 2). The gateway becomes
  the single consumer of the impersonation credential; the raw token never travels past it. (1)
  Gateway: capture x-impersonation-token pre-strip (alongside act-as intent in
  CaptureRequestedTenantMiddleware); in EffectiveTenantMiddleware's SUPER_ADMIN branch, cross-tenant
  scope is granted ONLY from a validated impersonation session — a new ImpersonationLookupService
  makes a service-signed internal call to admin-api GET /impersonation/sessions/validate (forwarding
  the admin's Authorization, the token, and the gateway-verified client IP); the validated context's
  targetTenantId becomes effectiveTenantId and the sessionId is added to the signed verified-user
  assertion. Bare x-act-as-tenant/x-tenant-id cross-tenant intent without a matching active session
  → 403 (closes the ambient-impersonation channel; MFA step-up and tenant-ACTIVE checks stay).
  Mirror the same closure in libs/backend-common TenantGuard's X-Act-As-Tenant branch
  (defense-in-depth: require the assertion-carried sessionId for cross-tenant). (2) Contract: add
  optional impersonationSessionId to the gateway verified-user assertion (service-identity.util.ts
  builder + VerifiedUserAssertionMiddleware parser) so subgraph audit rows carry the correlation key
  audit-log.tokens.ts already reserves — fix at the contract source, both sides together. (3)
  admin-api validate endpoint: derive the IP-binding check from the gateway-minted verified client
  network context (x-client-ip trusted only under verified gateway identity, mechanism exists per
  ORPHAN-MEDIUM-319) instead of raw req.ip, otherwise IP binding always fails behind the gateway.
  (4) FE: handleStartImpersonation captures the typed StartImpersonationResponse; new shared-ui
  impersonation-session store — beginImpersonation({sessionId, token, targetTenantId, expiresAt})
  persists the context, api-client automatically attaches x-impersonation-token + X-Tenant-Id:
  targetTenantId on every request while active and bumps the session epoch (session-epoch.ts exists
  for exactly this A→B→A cache round-trip); 'Open Tenant Portal' navigates to /tenant with NO
  credential or session id in the URL (URL = history/log leakage); endImpersonation() clears the
  store and bumps the epoch. ProtectedRoute already admits SUPER_ADMIN via role hierarchy — no shell
  route change needed. Pattern-level gate (tier 3): an e2e chain spec that exercises
  mint→present→validate→scoped-read→audit-correlation, so a consumer-less credential can never ship
  silently again.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/shared-ui/src/utils/impersonation-session.ts`
  - `web/shared-ui/src/utils/api-client.ts`
  - `web/shared-ui/src/utils/index.ts`
  - `apps/gateway-api/src/middleware/effective-tenant.middleware.ts`
  - `apps/gateway-api/src/services/impersonation-lookup.service.ts`
  - `apps/gateway-api/src/federation/authenticated-data-source.ts`
  - `libs/backend-common/src/utils/service-identity.util.ts`
  - `libs/backend-common/src/middleware/verified-user-assertion.middleware.ts`
  - `libs/backend-common/src/guards/tenant.guard.ts`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/gateway-api/src/middleware/effective-tenant.middleware.spec.ts`
  - `e2e/tests/integration/impersonation-chain.spec.ts`
  - `tests/invariants/farm-identity-ssot.spec.ts`
- **Proof of fix:** New e2e spec e2e/tests/integration/impersonation-chain.spec.ts proving the full
  chain: (1) SUPER_ADMIN starts a session, attaches the returned token as x-impersonation-token →
  tenant-scoped read returns the target tenant's data AND the audit row carries
  impersonationSessionId; (2) the same request with bare x-act-as-tenant and no token → 403
  (ambient-impersonation channel closed); (3) expired/terminated token → 403; (4) token bound to IP
  A presented from IP B → 403 (proves IP binding works behind the gateway via x-client-ip). Extend
  apps/gateway-api/src/middleware/effective-tenant.middleware.spec.ts: SUPER_ADMIN cross-tenant
  intent without a validated session → ForbiddenException; with one → effectiveTenantId ===
  session.targetTenantId and assertion carries sessionId. Extend
  tests/invariants/farm-identity-ssot.spec.ts to assert the assertion contract includes
  impersonationSessionId handling in both builder and parser. New FE spec for ImpersonationPage: the
  start handler stores the token in the impersonation store, and the portal navigation URL contains
  neither token nor session id.
- **Effort:** L

### APA-290 [HIGH] Revoke Permission always 404s: FE sends the permission row id where the route requires superAdminId

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The revoke button sets confirmAction.id = permission.id and handleRevokePermission
  passes it to impersonationApi.revokePermission -> POST
  /impersonation/permissions/:superAdminId/revoke. The backend resolves the path param as
  superAdminId and looks up permissionRepo.findOne({where:{superAdminId}}) — a permission UUID never
  equals an admin UUID, so revocation of a grant fails with NotFoundException 100% of the time. The
  API wrapper even names the parameter superAdminId, but the page passes the wrong identifier.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:822-830 (confirmAction.id = permission.id)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:310-313 (handleRevokePermission passes confirmAction.id)`
  - `web/modules/admin-panel/src/services/api/impersonation.ts:48-50`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:326-330`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:292-296 (findOne by superAdminId)`
- **Verification:** Verified every link: ImpersonationPage.tsx:823-825 sets confirmAction.id =
  permission.id (the row PK); the confirm modal (line 1320-1321) passes it to handleRevokePermission
  (line 310-312), whose first arg becomes the path param in impersonationApi.revokePermission
  (services/api/impersonation.ts:49-50) -> POST /impersonation/permissions/:superAdminId/revoke.
  Backend (impersonation.controller.ts:326-330 -> impersonation.service.ts:292-296) resolves the
  param as superAdminId and does permissionRepo.findOne({where:{superAdminId}}). The entity
  (impersonation-session.entity.ts:194-199) has id = @PrimaryGeneratedColumn('uuid') and
  superAdminId as a distinct @Column('uuid'); queryPermissions returns raw entities and fetchData
  stores them unmapped, so permission.id is genuinely the PK and never equals any superAdminId ->
  NotFoundException 404 on every revoke attempt. No alternate route, no FE mapping layer, no rewrite
  that could rescue it. The page is routed (Module.tsx:167 'system/impersonation'). One nuance: the
  same type drift makes the Active Permissions card crash at render (permission.allowedActions.join
  at line 804 — field absent on real rows), so operators currently hit a render crash before
  reaching the 404; this masks but does not refute the defect (both are the same drift instance and
  the 404 fires as soon as the card renders). Severity stays HIGH: the only operator surface for
  revoking an impersonation grant is non-functional, and server-side revoke also mass-terminates the
  admin's active sessions (endAllSessionsForAdmin) — a broken security-revocation control in the
  SUPER_ADMIN panel. Not CRITICAL because no data exposure or privilege escalation occurs and the
  API itself works when called correctly (curl with superAdminId).
- **Root cause:** The FE-type link of the FE->BE chain broke, in the systemic 'hand-written FE type
  drift' class. The hand-written ImpersonationPermission interface
  (web/modules/admin-panel/src/services/types/impersonation.ts:25-39) was authored against an
  imagined per-tenant grant model (tenantId/tenantName/allowedActions/maxSessionDuration/revokedBy)
  and omits superAdminId entirely, while the backend entity is a per-admin record keyed by
  superAdminId (grant upserts one row per admin, so the revoke route keying by :superAdminId is
  coherent backend-side). Because the FE type offered only 'id', the page author passed
  permission.id into a wrapper whose superAdminId parameter is a plain string — the compiler cannot
  distinguish a permission PK from an admin id. The one CI gate for this surface
  (contract-validation.spec.ts, the admin-route-contract project) matches normalized paths only
  (${x} -> :param), so it verifies the route exists but is structurally blind to which identifier is
  interpolated one call level above the wrapper. Compiler blind + CI gate blind = drift shipped. The
  same drift independently crashes the permissions tab render (allowedActions.join on a nonexistent
  field), currently masking the 404.
- **Fix design:** Fix the contract at the source, then make the wrong identifier a compile error
  (tier 1) and the drift class CI-detectable (tier 3). (1) Rewrite the FE ImpersonationPermission
  interface to be the serialized backend entity read model exactly: id, superAdminId,
  superAdminEmail?, canImpersonate, isActive, allowedTenants?, restrictedTenants?,
  defaultPermissions?, maxSessionDurationMinutes, maxConcurrentSessions, requireReason,
  requireTicketReference, notifyTenantAdmin, grantedBy?, grantedAt?, expiresAt?, notes?, createdAt,
  updatedAt (Dates as ISO strings). Delete the invented fields (tenantName, allowedActions,
  maxSessionDuration, reason, revokedAt, revokedBy). (2) Introduce a branded identifier type in the
  types module — export type SuperAdminId = string & { readonly [SuperAdminIdBrand]: true } (same
  precedent as the branded EventId in @platform/event-contracts) — and type
  ImpersonationPermission.superAdminId, ImpersonationSession.superAdminId, and the API wrapper
  params (revokePermission(superAdminId: SuperAdminId), getPermission, checkPermission) with it.
  Passing permission.id (plain string) then fails tsc at the callsite — the wrong behavior becomes
  impossible, not merely discouraged. (3) In ImpersonationPage.tsx, make confirmAction a
  discriminated union so the 'revoke_permission' arm carries id: SuperAdminId (the other arms keep
  session id: string); the revoke button sets id: permission.superAdminId; handleRevokePermission
  takes SuperAdminId. Rework the permissions tab to render the real contract fields (allowedTenants
  resolved to names via the already-cached tenant list, maxSessionDurationMinutes, notes, grantedBy;
  drop the revokedBy/revokedAt columns the backend does not have) — this also removes the render
  crash that currently masks the 404. (4) Remove the dead \_revokedBy/\_reason parameters from
  impersonationApi.revokePermission — a misleading surface that invited the wrong call pattern (the
  page was passing currentAdminId into a discarded slot). (5) Pattern-level gate: extend the
  existing admin-route-contract spec
  (apps/admin-api-service/src/**tests**/contract-validation.spec.ts) with a compile-time FE<->BE
  shape assertion for ImpersonationPermission — import the backend entity class and the FE interface
  in the same monorepo spec and assert the FE type extends Serialized<Entity> (Date->string mapped),
  so any future hand-written drift on this resource fails the strict, blocking test:contract CI
  step; this closes the shape half of the drift class at the established gate rather than adding a
  parallel mechanism. Note for the auditor (separate product gap, not gated here): the backend
  records no revokedBy/revokedAt on revocation — if revocation audit metadata is wanted, that is a
  new entity+migration+DTO finding, not part of this identifier fix.
- **Files to change:**
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.spec.tsx`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Proof of fix:** Three gates. (a) New behavioral spec
  web/modules/admin-panel/src/pages/system/**tests**/ImpersonationPage.spec.tsx (pattern: existing
  pages/**tests**/TenantManagementPage.spec.tsx): mock impersonationApi with an entity-shaped
  permission fixture whose id and superAdminId are distinct UUIDs; render the Permissions tab
  (proves the card no longer crashes on real rows), click Revoke then Confirm, assert
  impersonationApi.revokePermission was called with the fixture's superAdminId and never with its
  id. (b) Extend apps/admin-api-service/src/**tests**/contract-validation.spec.ts (runs as the
  strict, blocking admin-route-contract CI project per
  tests/invariants/admin-route-contract-ci.spec.ts) with the compile-time
  Serialized<ImpersonationPermission entity> vs FE-interface assertion — reintroducing any invented
  field or dropping superAdminId fails CI. (c) npm run type-check: with the branded SuperAdminId,
  reverting the page to pass permission.id is a tsc error — run nx affected --target=test and the
  type-check to prove all three.
- **Effort:** M

### APA-291 [HIGH] Permissions tab crashes / renders undefined on real data: FE ImpersonationPermission type shares almost no fields with the backend entity

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** FE type has
  tenantId/tenantName/grantedByEmail/maxSessionDuration/allowedActions/reason/revokedAt/revokedBy;
  the backend entity has
  superAdminId/superAdminEmail/allowedTenants[]/maxSessionDurationMinutes/notes/etc. — only
  id/isActive/grantedAt/expiresAt overlap. Rendering any active permission executes
  permission.allowedActions.join(', ') on undefined -> TypeError -> React subtree crash; typing in
  the search box executes permission.tenantName.toLowerCase() on undefined -> TypeError. Cards
  otherwise show 'undefined min', blank tenant and granted-by columns. The permission model is
  per-ADMIN (which tenants an admin may impersonate), but the UI presents it as per-TENANT — a
  conceptual inversion, not just field drift.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/impersonation.ts:25-39 (FE type)`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:192-251 (backend entity)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:804 (allowedActions.join crash)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:213-215 (tenantName.toLowerCase crash)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:789-800 (renders tenantName/tenantId/grantedByEmail/maxSessionDuration)`
- **Verification:** Confirmed end-to-end against current code. GET /api/impersonation/permissions
  (Module.tsx:167 route -> impersonationApi.getPermissions ->
  ImpersonationController.queryPermissions:289 -> ImpersonationService.queryPermissions:314) returns
  raw admin.impersonation_permissions entity rows (no read-DTO, no serializer — the entity file
  itself documents no ClassSerializerInterceptor); Baseline migration line 171 confirms DB columns
  match the entity. ResponseInterceptor + apiFetch envelope unwrap deliver those rows verbatim into
  the page's permissions state (ImpersonationPage.tsx:167). The FE ImpersonationPermission type
  (types/impersonation.ts:25-39) shares only id/grantedBy/grantedAt/expiresAt/isActive with the
  entity. Two concrete crashes: (1) ImpersonationPage.tsx:213-215
  permission.tenantName.toLowerCase() throws TypeError whenever searchQuery is non-empty and >=1
  permission row exists — and this useMemo runs regardless of active tab, so typing in the search
  box on the Active Sessions or History tabs also crashes; (2) line 804
  permission.allowedActions.join(', ') throws on rendering any active permission card. No
  ErrorBoundary exists anywhere in web/modules/admin-panel/src (only Suspense), so the render error
  kills the page. The crash state is self-inflicted through normal use: handleGrantPermission (lines
  288-294) posts a DTO-valid body, so one successful grant permanently bricks the Permissions tab.
  Additional confirmed collateral from the same model inversion: handleRevokePermission (line 312)
  passes permission.id where the backend route POST /permissions/:superAdminId/revoke requires
  superAdminId, so revoking the offending grant via the UI is a guaranteed no-op — the operator has
  no escape hatch. Severity HIGH is correct (admin-only surface, no security bypass, but the
  impersonation-governance UI is unusable with real data and its revoke path is broken). The
  conceptual inversion is real: the backend grant is per-ADMIN (allowedTenants[] on a superAdmin)
  while the UI renders per-TENANT cards.
- **Root cause:** The FE->BE READ contract for impersonation permissions was never fixed at the
  source: the FE type was hand-invented against an imagined per-TENANT grant model
  (tenantId/tenantName/allowedActions/revokedAt) while the backend entity models per-ADMIN grants
  (superAdminId/allowedTenants[]/maxSessionDurationMinutes/notes). The file shows partial
  remediation drift — the session types and the WRITE paths were later re-aligned to the backend
  ("Fix: backend uses superAdminId..." comments in services/api/impersonation.ts), but the
  ImpersonationPermission read type, the page's permission rendering/filtering, and the revoke call
  (row id vs superAdminId path param) were left on the old model. Contributing structural gaps: the
  backend exposes no declared read view for permissions (raw entity rows leak to the wire, unlike
  sessions which have SafeImpersonationSession), and nothing at build/test time binds the
  hand-written FE mirror to the backend shape — an instance of the systemic FE-type-drift class. The
  UI additionally displays revocation provenance (revokedBy/revokedAt) that the backend model simply
  never records.
- **Fix design:** Fix the contract at the source, per-ADMIN model end to end, plus a build-time
  drift gate (systemic-class application). (A) Backend read contract: in
  impersonation-session.entity.ts export an explicit ImpersonationPermissionView read type
  (analogous to SafeImpersonationSession) and have
  queryPermissions/getImpersonationPermission/canImpersonate return it; add the two fields the UI
  legitimately needs but the model never recorded — nullable revokedAt timestamptz + revokedBy uuid
  — set by revokeImpersonationPermission(superAdminId, revokedBy) (controller already holds the JWT
  user at impersonation.controller.ts:326-330, currently discarded). New blue-green-safe migration
  adding the two nullable columns (never edit Baseline). (B) FE type: rewrite
  ImpersonationPermission in services/types/impersonation.ts as a field-for-field mirror of
  ImpersonationPermissionView (dates as ISO strings; include a mirrored ImpersonationPermissions
  capability-flags interface for defaultPermissions), and type grantPermission's body with it
  instead of the inline Record shape. (C) Page: re-orient the Permissions tab to the per-admin model
  — card heading superAdminEmail ?? superAdminId; allowed tenants resolved via the already-fetched
  tenant list (tenantNameById map); Max Duration from maxSessionDurationMinutes; notes instead of
  reason; render defaultPermissions flags instead of the nonexistent allowedActions; search filter
  matches superAdminEmail/superAdminId and resolved allowed-tenant names (nullable columns handled
  with the same explicit ??-with-WHY pattern already established for sessions at lines 204-207 —
  data modeling of genuinely nullable columns, not defensive masking); revoked table shows
  revokedBy/revokedAt from the new columns; handleRevokePermission passes permission.superAdminId
  (the actual path param) instead of permission.id; grant modal maps the read/write/admin checkboxes
  onto defaultPermissions capability flags (canViewData/canModifyData/canManageUsers) so the UI
  intent lands in a real contract field instead of dead form state. (D) Drift gate (make it
  detectable at build time — pattern-level fix for the FE-type-drift class, applied locally): add a
  type-equality contract spec that imports BOTH the backend ImpersonationPermissionView and the FE
  ImpersonationPermission and asserts mutual assignability via Expect<Equal<...>> type-level
  assertions, so any future divergence fails type-check/tests instead of crashing at runtime; extend
  the existing controller spec to pin the {data,total,page,limit} response shape and the
  revoke-uses-JWT-identity behavior, and the lifecycle service spec to prove revoke stamps
  revokedAt/revokedBy. (The durable tier-1 endgame for the whole class is generating admin-panel
  types from the admin-api OpenAPI document — flag under the systemic FE-type-drift finding; this
  fix delivers the contract-equality gate that the codegen would later replace.)
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
  - `apps/admin-api-service/src/migrations/1800800000000-ImpersonationPermissionRevocationProvenance.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `e2e/tests/integration/admin-impersonation-permission-contract.spec.ts`
  - `apps/admin-api-service/src/impersonation/controllers/__tests__/impersonation.controller.spec.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.service.lifecycle.spec.ts`
- **Proof of fix:** New e2e/tests/integration/admin-impersonation-permission-contract.spec.ts:
  type-level Expect<Equal<FE ImpersonationPermission, backend
  ImpersonationPermissionView-with-string-dates>> assertions in both directions (fails npm run
  type-check / nx affected --target=test on any drift), plus a runtime keyset assertion that
  queryPermissions rows expose exactly the view's keys. Extend
  apps/admin-api-service/src/impersonation/controllers/**tests**/impersonation.controller.spec.ts:
  revoke endpoint passes the JWT user id as revokedBy and the response envelope for GET
  /impersonation/permissions is {data,total,page,limit}. Extend
  apps/admin-api-service/src/impersonation/services/**tests**/impersonation.service.lifecycle.spec.ts:
  revokeImpersonationPermission sets isActive=false AND stamps revokedAt/revokedBy. FE proof: a
  component test (or the contract spec's FE leg) rendering the Permissions tab with a real
  backend-shaped row and a non-empty search query — no TypeError, card shows superAdminEmail,
  resolved allowed-tenant names, maxSessionDurationMinutes; revoke fires POST
  /impersonation/permissions/{superAdminId}/revoke. Migration verified by the existing schema-drift
  validator at admin-api cold start plus e2e/tests/integration/schema-invariants.spec.ts.
- **Effort:** M

### APA-292 [MEDIUM] 'View Actions' always shows an empty audit trail even when actions exist

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** impersonationApi.getSessionActions is a client-side stub that throws 'Not
  implemented'; handleViewActions catches it and renders 'No actions recorded for this session'. Yet
  the session-list/read responses already contain the full actionsPerformed array
  (SafeImpersonationSession strips only token columns), so the data the modal claims is absent is
  sitting in the very session object passed to it. For a security review surface this is silent
  wrong data: an operator auditing an impersonation session is told nothing happened. (Compounded by
  the DB trigger which prevents logAction from persisting new actions at all.)
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/impersonation.ts:80-83 (stub throws)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:323-335 (catch -> empty list)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1201-1204 ('No actions recorded')`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:971-973 (list returns safe entity incl. actionsPerformed)`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:168-190 (only token fields stripped)`
- **Verification:** CONFIRMED in real wiring. Every cited link holds:
- FE api (services/api/impersonation.ts:81-83): getSessionActions is a stub whose body is
  `throw new Error('Not implemented: no backend GET endpoint...')`. It never inspects the session
  and unconditionally throws.
- FE page (ImpersonationPage.tsx:323-336): handleViewActions calls
  `impersonationApi.getSessionActions(session.id)`, catches the throw, and does
  `setSessionActions([])`. It passes session.id (not the session object) so it discards the actions
  data it was already handed.
- FE render (ImpersonationPage.tsx:1201-1204): with sessionActions.length===0 the modal shows "No
  actions recorded for this session". So EVERY click of "View Actions"/"View" on ANY session shows
  an empty trail, 100% of the time, independent of reality.
- Backend read model DOES carry the data: querySessions (impersonation.service.ts:973) and
  getSession (:982) both return `toSafeImpersonationSession(...)`; the safe view
  (impersonation-session.entity.ts:168-190) strips ONLY originalSessionToken + impersonationToken,
  so `actionsPerformed` and `actionCount` remain on the wire.
- Wire delivery confirmed: http-client.ts:341-349 unwraps the {success,data,meta} envelope and
  returns envelope.data verbatim — it does NOT strip unknown keys, so actionsPerformed reaches the
  browser at runtime even though the FE type omits it.

Compounding claim CONFIRMED as an even deeper rot: the ACTIVE Baseline migration
(1800000000000-Baseline.ts:265-280) installs `trg_impersonation_sessions_prevent_update` — a BEFORE
UPDATE OR DELETE trigger that unconditionally RAISEs 'append-only; UPDATE/DELETE refused',
misclassifying an operational table as an audit table. Because
logAction/extendSession/endImpersonation/terminateSession/expireSession all persist via
sessionRepo.save() (an UPDATE), the trigger kills the entire write path: actionsPerformed can never
grow past its creation value ([]) and actionCount can never increment past 0.

Why I lower HIGH→MEDIUM (over-graded as a "security surface silent-wrong-data" bug): (1) The
compliance-grade audit trail is intact and untouched: start/end/terminate/extend/expire are each
written to admin.audit_logs via auditLogService with actor, tenant, reason, IP, and CRITICAL
severity on terminate. The security-critical "who impersonated whom, when, why" facts are recorded
elsewhere; actionsPerformed is operational session metadata, not the regulatory ledger. (2) The
acute harm the title claims — "empty audit trail even when actions exist" — is NOT reachable in
current wiring: because the same trigger also blocks the write path, actionCount is always 0 and
actionsPerformed is always []. So today the operator sees a self-consistent (count 0, modal empty)
picture — there is no visible data contradiction, no bypass, no leak, no corruption. The modal only
becomes ACTIVELY misleading once the trigger is fixed (count N vs empty modal), making this a
latent/broken-feature defect rather than an in-production silent-wrong-audit. It is a genuine broken
read-only feature on a low-traffic admin-only surface with audit-completeness (not audit-integrity)
impact — MEDIUM is the honest grade.

This is an instance of a systemic class: FE-type drift + FE-route-with-no-backend +
config/mis-scoped-DB-guard. The FE ImpersonationSession type (services/types/impersonation.ts:41-68)
deliberately drops actionsPerformed ("intentionally omitted: the UI only consumes the numeric
actionCount"), which directly contradicts a modal built to display those very actions; lacking the
field, the api author invented a "missing endpoint" and stubbed a throw, when the data was already
delivered.

- **Root cause:** The FE→BE→DB chain for in-session impersonation actions is broken at three links
  that drifted independently:

1. DB (source of the compounding failure): Baseline migration mis-classified
   admin.impersonation_sessions as an append-only audit table and installed
   trg_impersonation_sessions_prevent_update (RAISE on any UPDATE/DELETE). The append-only guard was
   correct for audit_logs but wrong for this operational, mutable table — it silently kills
   logAction/extend/end/terminate/expire persistence, so actionsPerformed never populates.
2. FE type: ImpersonationSession was hand-narrowed to expose only actionCount and OMIT
   actionsPerformed, diverging from the backend SafeImpersonationSession which keeps the array. This
   drift is possible because admin-panel uses hand-written types with no codegen parity gate against
   the backend read model.
3. FE api/page: Because the array was absent from the FE type, the api author assumed "no backend
   GET endpoint" and wrote getSessionActions as a hard `throw`; handleViewActions then swallows it
   into an empty list. No separate endpoint is even needed — the list/get responses already carry
   actionsPerformed; the stub fabricated a missing-endpoint problem for data that is already
   delivered.

- **Fix design:** Fix all three links at the source together (per repo discipline:
  entity/migration + FE type + api + page), highest applicable tier each:

TIER-1/2 (restore correct behavior at the DB — make persistence possible again): Add a NEW forward
migration apps/admin-api-service/src/migrations/1801600000000-MakeImpersonationSessionsMutable.ts
(never hand-edit the Baseline). In up(): DROP TRIGGER IF EXISTS
trg_impersonation_sessions_prevent_update ON admin.impersonation_sessions; DROP FUNCTION IF EXISTS
admin.impersonation_sessions_prevent_update_or_delete(); and restore the service role's UPDATE grant
that the Baseline REVOKEd. impersonation_sessions is operational — the append-only immutability
guard belongs ONLY to true audit tables (audit_logs), whose trigger stays. Keep the migration
blue-green safe (idempotent DROP IF EXISTS). This unblocks logAction/extend/end/terminate/expire so
actionsPerformed/actionCount actually persist.

TIER-1 (make the data structurally present to the modal — kill the FE-type drift): In
web/modules/admin-panel/src/services/types/impersonation.ts add
`actionsPerformed?: ImpersonationAction[];` to ImpersonationSession so the FE read model is a
faithful mirror of the backend SafeImpersonationSession (which already ships it). Update the
misleading "intentionally omitted" comment.

TIER-1 (delete the throwing stub — the anti-pattern): In
web/modules/admin-panel/src/services/api/impersonation.ts remove the getSessionActions throw stub
entirely (no GET endpoint is needed; the array is already on the session). In ImpersonationPage.tsx
rewrite handleViewActions to be synchronous and read directly from the session it is handed:
`setSelectedSession(session); setSessionActions(session.actionsPerformed ?? []); setShowActionsModal(true);`
— drop the loadingActions/try-catch fetch machinery. The modal's existing SEC-008 primitive-only
whitelist for details stays.

TIER-3 (make the drift detectable so it cannot silently return): (a) add an architecture/invariant
spec asserting admin.impersonation_sessions carries NO update-blocking append-only trigger while
audit_logs still does — this permanently prevents the mis-scoped guard from being re-added; (b) add
a backend spec proving logAction→getSession round-trips a non-empty actionsPerformed (write path
alive); (c) add a FE spec asserting the modal renders N rows for a session with actionsPerformed of
length N (never "No actions recorded" when data is present).

- **Files to change:**
  - `apps/admin-api-service/src/migrations/1801600000000-MakeImpersonationSessionsMutable.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `apps/admin-api-service/src/__tests__/impersonation-sessions-mutable.architecture.spec.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.action-persistence.spec.ts`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.actions.spec.tsx`
- **Proof of fix:** 1)
  apps/admin-api-service/src/**tests**/impersonation-sessions-mutable.architecture.spec.ts (NEW) —
  query pg_trigger/information_schema after migrations run and assert NO trigger on
  admin.impersonation_sessions blocks UPDATE (and that admin.audit_logs still has
  trg_audit_logs_prevent_update), locking in the correct table classification.

2. apps/admin-api-service/src/impersonation/services/**tests**/impersonation.action-persistence.spec.ts
   (NEW, integration against a migrated DB) — start a session, call logAction(...) and
   extendSession(...), then getSession(id) and assert actionsPerformed.length>0 and actionCount>0
   (proves the trigger no longer kills the write path).
3. web/modules/admin-panel/src/pages/system/**tests**/ImpersonationPage.actions.spec.tsx (NEW) —
   render with a mocked getSessions returning a session whose actionsPerformed has 2 entries; click
   "View Actions"; assert both entries render and the "No actions recorded for this session" text is
   absent. Add a case with actionsPerformed omitted/empty asserting the empty-state still shows.
   Confirms handleViewActions reads the session object and the throwing stub is gone.

- **Effort:** M

### APA-293 [HIGH] No separation of duties: a SUPER_ADMIN self-grants impersonation permission, and nothing prevents impersonating another SUPER_ADMIN or an unrelated/nonexistent user

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The FE grant form hardcodes superAdminId = currentAdminId, i.e. the operator grants
  THEMSELVES access to any tenant, then starts a session — the entire permission gate
  (allowedTenants whitelist, canImpersonate) is self-serviceable in two clicks. The backend accepts
  grantedBy === superAdminId with no maker/checker rule. startImpersonation performs no validation
  that targetUserId exists, belongs to targetTenantId, or is not itself a SUPER_ADMIN/platform admin
  (no auth-service lookup at all) — the extra-scrutiny requirement 'guard against impersonating
  other SUPER_ADMINs' is unimplemented. Grant/revoke of permissions is also absent from the audit
  log (only session events are audited; grant writes only a Logger line).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:287-294 (superAdminId: currentAdminId)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:304-319 (no self-grant check)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:235-290 (grant: no audit log, no SoD check)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:431-539 (start: targetUserId never validated)`
- **Verification:** All three sub-claims are factually confirmed and concretely reachable behind
  PlatformAdminGuard (SUPER_ADMIN). (a) SELF-GRANT: FE hardcodes `superAdminId: currentAdminId`
  (ImpersonationPage.tsx:289); controller (impersonation.controller.ts:314-318) sets
  `grantedBy = user.id` from JWT but never asserts `grantedBy !== superAdminId`; service grant
  (impersonation.service.ts:235-290) has no maker/checker rule. A single operator issues themselves
  a permission with `allowedTenants:[any]`, then `canImpersonate` (381-425) passes on their own
  whitelist — the entire ImpersonationPermission gate is self-serviceable, i.e. security theater.
  (b) NO TARGET VALIDATION: startImpersonation (431-583) validates only rate-limit + tenant
  whitelist + reason/ticket; `targetUserId` is written to the session (522) with no lookup — no
  existence, no tenant-membership, no anti-SUPER_ADMIN check, so impersonating another SUPER_ADMIN
  (breaking non-repudiation/attribution) or a nonexistent/cross-tenant user is unblocked. (c) AUDIT
  GAP: grant (287-289) and revoke (298-306) write only a Logger line while every session event calls
  auditLogService.log under an explicit SOC2/GDPR reconstruction rationale — the root-of-trust grant
  is invisible in audit.audit_logs. Severity stays HIGH (not CRITICAL) because the precondition is
  the most-privileged role; but the combination of a self-defeating SoD control + unaudited grant of
  the impersonation right + attribution-breaking impersonation of other admins is a genuine
  accountability/audit-integrity defect on a platform that explicitly claims SOC2 CC1 / GDPR Art 30
  guarantees. Not NOT_A_BUG: the ImpersonationPermission subsystem exists precisely to be a gate,
  and it provides zero assurance as wired. This is partly a SYSTEMIC class: audit-coverage asymmetry
  (session-lifecycle methods audit, permission-lifecycle methods do not) — the fix must add a
  coverage invariant, not just the two log calls.
- **Root cause:** The impersonation permission subsystem was built as a DATA-MODEL gate
  (allowedTenants/canImpersonate whitelist) but the AUTHORIZATION SEMANTICS of who may grant it were
  never encoded. A prior fix correctly moved `grantedBy` to the JWT (killing header spoofing) but
  stopped short of the maker≠checker assertion; the FE, needing a value for the required
  `superAdminId` DTO field and having no admin-selector, defaulted it to the current admin — so
  self-grant became the default UX. Separately, `targetUserId` was added to the Start DTO/entity as
  free-form data with no matching validation step, because admin-api treats `auth.users` as an
  external read model and nobody wired the lookup — so the field is persisted but never checked
  against existence/tenant/role. Finally, audit coverage grew reactively (AUDITTRAIL-CRITICAL-003
  instrumented session lifecycle) but the permission-grant/revoke paths were outside that finding's
  scope and kept their Logger-only lines. The broken link is BE authorization+validation+audit on
  the grant and start endpoints; the FE merely encodes the resulting gap as default behavior.
- **Fix design:** Three-part architectural fix at the source, plus one pattern-level gate. (1)
  SEPARATION OF DUTIES (Tier 1 make-impossible): in `grantImpersonationPermission`, reject
  `data.superAdminId === data.grantedBy` with ForbiddenException at the single service boundary
  (covers controller + internal callers); persist `grantedBy` (column already exists) so two-person
  integrity is recorded. FE: remove the hardcoded `superAdminId: currentAdminId` and add a
  target-admin selector to the Grant form (fetch platform admins) so the UI structurally cannot
  express grant-to-self. (2) TARGET VALIDATION (Tier 1/2): in `startImpersonation`, when
  `targetUserId` is present, resolve it via the existing `auth.users` read model (UserReadOnly repo)
  or the NATS auth query already used by users.service, and reject when the user does not exist,
  `user.tenantId !== targetTenantId`, or `user.role === SUPER_ADMIN` (and any platform-admin role) —
  implementing the anti-SUPER_ADMIN guard; populate `targetUserEmail` from the lookup instead of
  trusting the client. Register the UserReadOnly repository (or auth NATS client) in the
  impersonation module so the service can perform the lookup. (3) AUDIT GRANT/REVOKE (Tier 2
  automatic): add
  `auditLogService.log({ action:'IMPERSONATION_PERMISSION_GRANTED' | 'IMPERSONATION_PERMISSION_REVOKED', performedBy: grantedBy, entityType:'ImpersonationPermission', entityId: saved.id, details:{ superAdminId, allowedTenants, expiresAt } })`,
  and add these actions to `determineSeverity` warning/critical lists. (4) PATTERN-LEVEL
  DETECTABILITY (Tier 3): add an invariant/contract spec asserting every state-mutating
  ImpersonationService method writes an audit row, so the session-vs-permission coverage asymmetry
  cannot recur silently. No defensive `?.`/`as any`/shims — each is a real
  authorization/validation/audit control added at the responsible layer.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/adminApi.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.service.authorization.spec.ts`
  - `apps/admin-api-service/src/impersonation/controllers/__tests__/impersonation.controller.spec.ts`
- **Proof of fix:** Add
  `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.service.authorization.spec.ts`
  asserting: (a) grant where `superAdminId === grantedBy` throws ForbiddenException and persists
  nothing; (b) startImpersonation with a `targetUserId` that is absent from auth.users, or whose
  tenantId differs from targetTenantId, or whose role is SUPER_ADMIN, throws and creates no session;
  a valid non-admin same-tenant user succeeds and its email is taken from the lookup; (c) grant and
  revoke each invoke auditLogService.log with action IMPERSONATION_PERMISSION_GRANTED / \_REVOKED
  and performedBy=grantedBy. Extend `impersonation.controller.spec.ts` to prove the self-grant
  rejection surfaces as HTTP 403. Add a coverage-invariant spec asserting every state-mutating
  ImpersonationService method calls auditLogService.log (so future methods cannot skip auditing).
  Gate: `nx affected --target=test --projects=admin-api-service` and the admin-panel build green.
- **Effort:** L

### APA-294 [HIGH] Audit-write failures are silently swallowed despite in-code claims that they propagate (AUDITTRAIL-CRITICAL-003)

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** impersonation.service.ts documents that awaiting auditLogService.log() lets a failure
  propagate so a SUPER_ADMIN session can never exist without an audit row. But AuditLogService.log
  wraps the save in try/catch and returns null on error ('Don't throw - audit logging should not
  break main operations'). The awaited call therefore NEVER throws: under a transient DB blip an
  impersonation session starts with no row in admin.audit_logs — exactly the half-recorded state the
  comment claims is cured. The SOC2/GDPR reconstruction guarantee asserted at the call sites is not
  actually enforced.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:551-575 (comment claims propagation; awaits log)`
  - `apps/admin-api-service/src/audit/audit.service.ts:84-107 (log() catches all errors, returns null)`
- **Verification:** Confirmed reachable in real wiring. AuditLogService.log()
  (audit.service.ts:84-108) wraps its ENTIRE body in one try/catch and returns null on any error
  (BUG-029 made the non-throwing behavior permanent) — it cannot propagate a DB failure.
  startImpersonation (impersonation.service.ts:559-575) awaits log() but discards the null return
  and continues, so the comment's claim (551-558) that awaiting 'lets a failure propagate ...
  instead of a half-recorded SUPER_ADMIN session' is contradicted by the collaborator it calls.
  Compounding it, sessionRepo.save() at line 539 commits the session BEFORE the audit write with no
  enclosing transaction, so even a throwing audit call could not roll the session back. Under a
  transient DB error on the admin.audit_logs insert, an ACTIVE cross-tenant SUPER_ADMIN session
  exists and is returned with a usable token while no audit row exists — precisely the SOC2 CC1 /
  GDPR Art 30 reconstruction gap the comment says is cured. HIGH (not CRITICAL): it is not an
  access-control bypass and requires a transient failure narrowly hitting the audit insert; but it
  defeats the audit-completeness guarantee on the single highest audit-criticality action on the
  platform, and the same swallow-then-await pattern recurs at end/terminate/extend/expire (617, 661,
  755, 1105), making it a systemic class. Two tables (impersonation_sessions, audit_logs) both live
  in schema admin on one connection and the RLS bypass is AsyncLocalStorage/SET LOCAL
  transaction-scoped, so an atomic transactional fix is feasible.
- **Root cause:** The BE service/DB link broke: two collaborators encode contradictory contracts and
  nothing reconciles them. AuditLogService.log() is intentionally fire-and-forget (signature
  Promise<AuditLog | null>, catches everything so 'audit logging should not break main operations'),
  while the impersonation call site asserts in prose that the awaited log propagates so a session
  can never exist without its audit row. The drift happened because a prior 'cure' swapped
  .catch(()=>warn) for await log(...) and added a comment, but never changed log()'s swallowing
  behavior and never introduced a transaction binding the session save to the audit write — a prose
  fix over a behavioral no-op. The type system does not catch it because log()'s nullable return is
  ignored by the caller, and the session is committed at line 539 outside any transaction, so the
  audit write is a non-atomic afterthought.
- **Fix design:** Tier 1 (make the half-recorded state impossible) + Tier 3 (detectable), fixing the
  pattern at the source, not the symptom. (1) In AuditLogService add a transactional, throwing
  variant that participates in a caller-supplied EntityManager and does NOT catch: logOrThrow(input:
  AuditLogInput, manager: EntityManager): Promise<AuditLog> — uses
  manager.getRepository(AuditLog).save(...) and lets errors propagate; its non-nullable return type
  gives compliance-critical callers a compile-time non-null guarantee, distinct from the swallowing
  log() which stays unchanged for best-effort operational logging. (2) In ImpersonationService
  inject DataSource and wrap each state-changing mutation together with its audit write in one
  dataSource.transaction(async (manager) => { const saved = await
  manager.getRepository(ImpersonationSession).save(session); await
  auditLogService.logOrThrow({...IMPERSONATION_STARTED...}, manager); return saved; }). Because both
  tables are in schema admin on the same connection and the RLS-bypass frame plus SET LOCAL are
  transaction-scoped, this is atomic: if the audit insert fails the transaction rolls back and NO
  impersonation_sessions row is committed, so a SUPER_ADMIN session cannot exist without its audit
  row. Apply the identical transactional binding to
  endImpersonation/terminateSession/extendSession/expireSession so every state transition and its
  audit row commit atomically. Move this.localActiveSessions.set(...) and the raw-token return to
  AFTER the transaction commits so the in-memory cache never diverges from committed state. (3)
  Replace the now-accurate-by-construction comments (551-558 and the sibling blocks) with a
  description of the transactional invariant rather than the false propagation claim.
- **Files to change:**
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
- **Proof of fix:** Add
  apps/admin-api-service/src/impersonation/**tests**/impersonation-audit-atomicity.spec.ts: mock the
  audit repository/manager save to reject during startImpersonation and assert (a)
  startImpersonation rejects, (b) the impersonation_sessions save is rolled back (session count
  unchanged / no persisted row), (c) localActiveSessions gained no entry and no token was returned;
  plus a happy-path case asserting both rows commit. Extend
  apps/admin-api-service/src/audit/**tests**/audit.service.spec.ts to pin the contract difference:
  logOrThrow re-throws on a repository save failure while log() returns null. Optionally add an
  architecture guard spec asserting the impersonation mutation paths
  (start/end/terminate/extend/expire) call logOrThrow inside a DataSource.transaction and never the
  swallowing log(), so the invariant cannot silently regress.
- **Effort:** M

### APA-295 [MEDIUM] End/Extend failures are swallowed silently, and the operator-override Terminate flow is unreachable from the UI

- **Status:** DESIGNED (brief)
- **Symptom:** handleEndSession and handleExtendSession catch errors with console.error only (no
  setPageError), then close the modal and refetch — on the backend's owner-only checks (H26: only
  the session owner may end/extend), a second admin trying to stop a colleague's session gets a
  silent no-op: modal closes, session still active, zero feedback. The only sanctioned path for
  stopping someone else's session is POST /sessions/:id/terminate, and the FE has
  handleRevokeSession + a confirm branch for type 'revoke', but no button anywhere sets
  confirmAction.type='revoke' — the override is dead code. Net: from this page, one admin cannot
  stop another admin's active impersonation at all (independent of the DB-trigger issue).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:247-256 (end: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:258-267 (extend: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:269-282,1318-1319 (revoke handler + branch never triggered; grep shows no setConfirmAction type 'revoke')`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:599-602,700-703 (owner-only 403s)`
- **Root cause:** handleEndSession/handleExtendSession (ImpersonationPage.tsx:247-267) catch with
  console.error only and unconditionally close the modal + refetch, so backend owner-only 403s
  (impersonation.service.ts:600-602, 701-703) become silent no-ops; and while handleRevokeSession +
  the confirmAction.type==='revoke' branch exist (269-282, 1318-1319), no UI element ever sets that
  type, so the sanctioned operator-override POST /sessions/:id/terminate is dead code — a second
  admin cannot stop a colleague's session from this page.
- **Fix design:** Instance of the page-wide swallowed-catch class. Pattern fix: extract one
  async-action helper (await api call; on failure setPageError(message) and keep the modal open; on
  success close modal + refetch) and route ALL handlers (end/extend/revoke/grant/revokePermission)
  through it so silent failure becomes structurally impossible. Local fix: in the active-session row
  actions (~640-690), branch on ownership — session.superAdminId === currentAdminId renders
  End/Extend; otherwise render a 'Terminate' button that sets confirmAction {type:'revoke', id:
  session.id}, activating the existing revoke confirm branch (which already collects revokeReason).
  Add an RTL spec asserting (a) a rejected endSession surfaces the page error and leaves the session
  listed, (b) a non-owner session row exposes Terminate wired to impersonationApi.revokeSession.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.spec.tsx`
- **Effort:** M

### APA-296 [MEDIUM] Grant form drift: duration input allows 15-480 min vs backend @Max(60), and 'Allowed Actions' checkboxes are never sent

- **Status:** DESIGNED (brief)
- **Symptom:** The Max Session Duration input permits up to 480 minutes but GrantPermissionDto caps
  maxSessionDurationMinutes at IMPERSONATION_MAX_SESSION_MINUTES=60 (forbidNonWhitelisted global
  pipe) — any value 61-480 the UI accepts produces a 400. The read/write/admin 'Allowed Actions'
  checkboxes are collected in state but omitted from the grant payload, and the backend has no such
  field (capabilities live in defaultPermissions, which the FE never sets) — so every grant's
  session capabilities fall back to view-only defaults regardless of what the operator checks. Fails
  safe, but the security UI misrepresents what was granted.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1086-1093 (min 15 max 480)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:77-83 (@Max(IMPERSONATION_MAX_SESSION_MINUTES))`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:19 (cap = 60)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:287-294 (payload omits allowedActions)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:501-514 (grantedPerms fallback = view-only defaults)`
- **Root cause:** Grant modal drifted from GrantPermissionDto with no shared contract: the duration
  Input hardcodes max={480} (ImpersonationPage.tsx:1090) while the DTO enforces
  @Max(IMPERSONATION_MAX_SESSION_MINUTES)=60 (controller:82, entity:19) so 61-480 always 400s under
  forbidNonWhitelisted; and the read/write/admin allowedActions checkbox state is never mapped into
  the payload (handleGrantPermission:288-294 omits it) and matches no backend field — capabilities
  live in defaultPermissions (ImpersonationPermissions), so every grant falls back to view-only
  defaults (service:491-503) regardless of operator intent.
- **Fix design:** FE-type-drift class — fix at the contract. (1) Mirror
  IMPERSONATION_MAX_SESSION_MINUTES and the ImpersonationPermissions shape into the admin-panel
  impersonation types module and add a contract spec that imports both the FE constant/shape and the
  backend entity's exports and asserts equality, so drift fails CI. (2) Bind the Input max to the
  mirrored constant (min stays a UX floor; backend @Min(1) already accepts it). (3) Replace the
  fictional read/write/admin trio with checkboxes over the real six ImpersonationPermissions
  capabilities and send them as defaultPermissions in impersonationApi.grantPermission (the api fn
  already accepts defaultPermissions — services/api/impersonation.ts:34). Update permissionForm
  state/type accordingly and reset value.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `apps/admin-api-service/src/__tests__/impersonation-contract.spec.ts`
- **Effort:** M

### APA-297 [MEDIUM] Stats mislabeled and aggregates truncated to first 20 sessions (no pagination)

- **Status:** DESIGNED (brief)
- **Symptom:** The 'Total Sessions (30d)' card renders getImpersonationStats().totalSessions which
  is sessionRepo.count() over ALL time, not 30 days. The 'Actions Logged' card sums actionCount over
  the sessions state, which is one unpaginated getSessions() call — backend default limit 20 — so
  both this card and the History tab silently cap at the 20 most recent sessions with no pagination
  controls. A dedicated backend audit endpoint (GET /impersonation/audit/summary with real 30d
  windowing, top tenants, reason breakdown) exists but is never called by the page.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:469-470 ('Total Sessions (30d)' label)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:346-349 (count() all-time)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:497-499 (sum over sessions state)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:967-969 (default limit 20)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:499-508 (unused audit/summary endpoint)`
- **Root cause:** The 'Total Sessions (30d)' card (ImpersonationPage.tsx:469-470) renders
  getImpersonationStats().totalSessions which is sessionRepo.count() over all time (service:349);
  'Actions Logged' (497-499) sums actionCount over the sessions state, which is one unpaginated
  getSessions() call capped by the backend default limit 20 (service:967-969) — same cap silently
  truncates the History tab, which has no pagination controls. The purpose-built GET
  /impersonation/audit/summary with real 30-day windowing (controller:499-508, service
  getAuditSummary) is never called.
- **Fix design:** Wire the page to the endpoint that owns the semantics instead of relabeling: add
  impersonationApi.getAuditSummary(startDate?, endDate?) returning the backend
  ImpersonationAuditSummary shape (mirror the type in services/types), fetch it in fetchData
  alongside the others, and drive the '(30d)' card and 'Actions Logged' card from summary fields;
  also feed the Audit Summary tab from it (real top-tenants/reason breakdown). Add server-side
  pagination to Session History: hold page state, pass {page, limit} to getSessions, render a pager
  from the returned total (the {items,total} envelope already carries it). RTL spec: stats cards
  read from the summary fetch and History pager requests page 2 with the correct query params.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/pages/system/__tests__/ImpersonationPage.spec.tsx`
- **Effort:** M

### APA-298 [MEDIUM] GET /impersonation/permissions?tenantId=... 500s: ANY() applied to a jsonb column

- **Status:** DESIGNED (brief)
- **Symptom:** queryPermissions filters with ':tenantId = ANY(p.allowedTenants)' but allowedTenants
  is a jsonb column — Postgres rejects ANY/ALL on jsonb ('op ANY/ALL (array) requires array on right
  side'). The page calls getPermissions() without tenantId so it is latent here, but the documented
  API param is broken and any future caller (or the FE checkPermission flow) filtering by tenant
  gets a 500.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:320-324`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:210-211 (jsonb allowedTenants)`
- **Root cause:** allowedTenants/restrictedTenants are semantically UUID arrays but persisted as
  jsonb (impersonation-session.entity.ts:210-214); queryPermissions applies the SQL array operator
  ':tenantId = ANY(p.allowedTenants)' (impersonation.service.ts:323) which Postgres rejects on jsonb
  — every tenantId-filtered call to GET /impersonation/permissions 500s. Latent only because the
  page calls getPermissions() without tenantId.
- **Fix design:** Tier-1 fix at the storage type, not the query: migrate both columns to uuid[] (new
  migration: ALTER TABLE ... ALTER COLUMN "allowedTenants" TYPE uuid[] USING ARRAY(SELECT
  jsonb_array_elements_text("allowedTenants"))::uuid[], same for restrictedTenants, preserving
  NULLs), change the entity to @Column({ type: 'uuid', array: true, nullable: true }), after which
  the existing ANY() predicate is valid SQL and the type system matches the semantics (in-memory
  .includes() checks in canImpersonate are unaffected). Add an integration spec that seeds a
  permission and calls queryPermissions({tenantId}) against real Postgres so the operator/type
  mismatch class is caught at test time, not at the first filtered request.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
  - `apps/admin-api-service/src/migrations/<ts>-ImpersonationTenantArraysToUuidArray.ts`
  - `apps/admin-api-service/src/__tests__/integration/impersonation-permissions.integration.spec.ts`
- **Effort:** M

### APA-299 [LOW] targetTenantName is client-supplied and stored unverified into the session/audit record

- **Status:** DESIGNED (brief)
- **Symptom:** The FE sends the display name it happens to have cached; the backend persists it
  without cross-checking auth.tenants. The audit trail's human-readable tenant identity is therefore
  spoofable by the request author (mitigated by targetTenantId being the real key).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:233`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:117-120`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:517-521`
- **Root cause:** targetTenantName is an optional client-supplied field on StartImpersonationDto
  (controller:117-120) that the FE fills from its cached tenant list (ImpersonationPage.tsx:233) and
  the service persists verbatim into the session/audit record (service:521) — the human-readable
  tenant identity in the audit trail is author-controlled (targetTenantId remains the trustworthy
  key).
- **Fix design:** Server-side identity-resolution class (same as i12): remove targetTenantName from
  StartImpersonationDto and from the FE StartImpersonationRequest type/payload entirely, and have
  startImpersonation resolve the display name authoritatively from the tenant record by
  targetTenantId (inject the admin-api tenants read service the page's tenantsApi.search already
  fronts) before persisting — the wrong value becomes impossible because the field no longer crosses
  the trust boundary. forbidNonWhitelisted then rejects any client still sending it (BREAKING CHANGE
  footer on the request contract). Extend the impersonation service spec: started session stores the
  resolved name even when the request carries a spoofed one.
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
- **Symptom:** superAdminEmail is populated from the JWT (user.email), which post H-08 is absent, so
  new session rows store null and the stats topAdmins fallback shows 'Unknown' — the Audit Summary
  tab degrades to opaque UUID-keyed rows with no email backfill from auth-service.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:352-361 (user.email may be undefined)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:371-375 (email || 'Unknown')`
- **Root cause:** superAdminEmail is snapshotted from the JWT (controller:360 user.email) which H-08
  deliberately removed, so new sessions persist null and getImpersonationStats' topAdmins falls back
  to 'Unknown' (service:373) — the Audit Summary degrades to UUID-only rows with no backfill path.
- **Fix design:** Same server-side identity-resolution class as i11: stop reading email from the
  request context at all; at startImpersonation resolve it by user.id from the authoritative
  admin-user record (admin-api's platform-admin store, or the signed HTTP client to auth-service per
  libs/backend-common service-identity) and persist that as the deliberate denormalized audit
  snapshot. Delete the user.email read from the controller so the removed-claim dependency cannot
  regress. Optionally one backfill migration setting superAdminEmail for null rows whose admin still
  resolves. Spec: startImpersonation stores the directory-resolved email when the JWT has no email
  claim; stats topAdmins never emits 'Unknown' for a resolvable admin.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  - `apps/admin-api-service/src/migrations/<ts>-BackfillImpersonationAdminEmail.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/impersonation.service.spec.ts`
- **Effort:** M

## DebugToolsPage — `/admin/system/debug` — verdict: **BROKEN**

**Chain:** FE (debugApi + databaseApi) -> /api/debug/\* and /api/database/monitoring/connections.
The /debug backend exists (DebugToolsController, PlatformAdminGuard SUPER_ADMIN) but is DISABLED by
default: DebugToolsModule.forRoot() registers no controllers unless ENABLE_DEBUG_TOOLS=true, and
that env var is set in no compose/env file in the repo (grep matched only the module + docs);
production nginx additionally hard-404s 'location /api/debug'. So in every environment as shipped,
the default Cache tab's calls 404 and the page shows 'Cache service unavailable'. Even when enabled,
the cache surface is hollow: entries come from the admin.cache_entries_snapshot DB table whose only
writer (POST /debug/cache/capture) has zero callers in the platform; all invalidation methods are
logger no-op placeholders returning 0; and the list response shape ({entries,summary}) does not
match the FE's PaginatedResult so entries could never render anyway. The Logs and Config tabs are
explicit client-side TODO stubs; the SQL Query Executor throws client-side 'not yet implemented' (no
arbitrary-SQL endpoint exists — a security positive contradicted by the scary production warning in
the UI). The Database tab's only real call (GET /database/monitoring/connections, real
pg_stat_activity query) is then used to FABRICATE connection rows client-side with hardcoded
database/user/application values.

**Endpoints exercised:**
`GET /api/debug/cache?limit=&keyPattern= (backend @Get('cache') ignores both params; 404 as deployed)`;
`GET /api/debug/cache/stats (derived from snapshot table, not a real cache; 404 as deployed)`;
`POST /api/debug/cache/invalidate (backend no-op, always returns {invalidated:0}; 404 as deployed)`;
`DELETE /api/debug/cache/:key (backend no-op placeholder; 404 as deployed)`;
`GET /api/database/monitoring/connections (real pg_stat_activity aggregate — the page's only working call)`;
`Logs tab: no call (client TODO stub)`; `Config tab: no call (client TODO stub)`;
`SQL executor: no call (client-side throw)`

**DB tables:**
`admin.cache_entries_snapshot (Baseline.ts:185-187; never populated — capture endpoint has no callers)`,
`admin.debug_sessions / admin.captured_queries / admin.captured_api_calls / admin.feature_flag_overrides (wired in debugApi but unused by this page; capture endpoints also have no producers)`,
`pg_stat_activity (system view, via /database/monitoring/connections)`

### APA-301 [MEDIUM] Entire /debug backend is unreachable as deployed: module disabled by default (ENABLE_DEBUG_TOOLS unset anywhere) and nginx 404s /api/debug in production — yet the page ships in the admin nav

- **Status:** CONFIRMED+DESIGNED (audited HIGH → verified MEDIUM)
- **Symptom:** DebugToolsModule.forRoot() returns an empty module unless ENABLE_DEBUG_TOOLS='true';
  grep across the repo finds the flag set in no docker-compose/.env/deploy file. Production nginx
  independently returns 404 for 'location /api/debug' (H-3). The FE nav unconditionally links 'Debug
  Tools' and the default Cache tab fires 4 calls that all 404, surfacing a persistent 'Cache service
  unavailable' toast. The security posture (off by default) may be intentional, but shipping an
  operator page whose primary tab can never succeed in any environment is a broken product surface;
  there is no capability check or feature-flag awareness in the FE.
- **Evidence:**
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts:53-61 (empty module unless flag)`
  - `apps/admin-api-service/src/app.module.ts:235-237`
  - `infrastructure/nginx/droplet.conf:198-200 (location /api/debug { return 404; })`
  - `grep ENABLE_DEBUG_TOOLS: matches only module/docs, no env/compose sets it`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx:211 (unconditional nav item)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:101-126 (cache load -> 'Cache service unavailable')`
- **Verification:** Every cited fact independently verified in real wiring. (1)
  debug-tools.module.ts:53-61 returns `{ module: DebugToolsModule }` (no controllers/providers)
  unless `process.env['ENABLE_DEBUG_TOOLS'] === 'true'`. (2) A broad grep over docker-compose*,
  infrastructure/, .env*, and the admin-api Dockerfile finds the flag set NOWHERE — only in the
  module itself, app.module.ts comments, and docs/audit files. So the /debug routes are registered
  in zero environments as shipped. (3) droplet.conf:198-200 hard-404s `location /api/debug`; nginx
  longest-prefix matching makes this block win over the general `/api/`->`/api/v1/` rewrite, so even
  if the module were enabled, prod would 404. (4) FE ships the page unconditionally:
  admin-nav-items.tsx:211 static nav entry + Module.tsx:168 route, with no capability/feature-flag
  check. (5) The default tab is 'cache' (DebugToolsPage.tsx:68); loadCacheData runs on mount
  (useEffect line 183-185) and calls debugApi.getCacheEntries -> `/debug/cache` and getCacheStats ->
  `/debug/cache/stats` (debug.ts:72-86); both 404 -> both Promise.allSettled entries reject ->
  setError('Cache service unavailable') (lines 111-114), a persistent bottom-right toast. Refutation
  attempts failed: no alternate gateway route to /debug; no ENABLE_DEBUG_TOOLS in any deploy
  artifact; no /capabilities endpoint in admin-api and no capabilities awareness in the admin-panel
  FE (grep confirmed). Severity corrected DOWN from HIGH to MEDIUM: the surface is genuinely
  non-functional in every environment, but it FAILS SAFE (error toast, no crash, no data loss, no
  security exposure) and the off-by-default backend is deliberate security hardening (NEW-03). This
  is a product-completeness/UX defect (dead operator nav surface + missing FE/BE capability
  handshake), not a correctness/security/data-integrity defect, so MEDIUM is the honest grade. This
  is an instance of a systemic class — backend availability invisible to the FE — the same class as
  the Impersonation 'Open Tenant Portal' dead action; the fix must be designed at the pattern level,
  not just hide the one nav item.
- **Root cause:** The broken link is the FE->BE contract for feature availability: whether the
  /debug surface exists is decided entirely server-side by two independent switches
  (ENABLE_DEBUG_TOOLS gating DebugToolsModule.forRoot() controller registration, and nginx 404'ing
  /api/debug in prod), but there is NO discoverable signal the frontend can consume. The admin-panel
  nav (admin-nav-items.tsx) is a static array and the route (Module.tsx) is unconditional, so the
  panel advertises and mounts a page whose backend is registered in none of the shipped
  configurations. It drifted because the security hardening (NEW-03: disable-by-default + nginx
  block) was added on the backend without a corresponding contract change on the FE — the two sides
  evolved independently with no shared source of truth for 'is this capability live'. This is
  systemic: any env-gated or prod-blocked backend module (debug tools today, tenant-portal
  impersonation tomorrow) will silently present as a dead nav item because feature availability has
  no typed handshake.
- **Fix design:** Tier-2 (make correct behavior automatic) + Tier-3 (detectable at test time):
  introduce a capability handshake whose value is derived from the SAME decision that gates
  registration, so it can never drift from reality. BACKEND: add a CapabilitiesModule in admin-api
  exposing GET /capabilities inside the PlatformAdminGuard boundary. Feature modules contribute
  descriptors through a multi-provider DI token (ADMIN_CAPABILITY: { key, enabled }).
  DebugToolsModule.forRoot() computes `isEnabled` ONCE and (a) uses it to gate controllers/providers
  AND (b) contributes { key: 'debugTools', enabled: isEnabled } in BOTH branches from that same
  boolean — one decision point, no second env read anywhere. The capabilities controller aggregates
  all ADMIN_CAPABILITY providers into a typed map. FRONTEND: add services/api/capabilities.ts + a
  shared capabilities type; convert the static nav array into buildAdminNavItems(caps) that filters
  entries carrying a `requiredCapability` field (tag 'system-debug' with
  requiredCapability:'debugTools'); AdminLayout.tsx consumes GET /capabilities via a cached query
  and passes caps into buildAdminNavItems so the Debug Tools entry (and future gated entries) simply
  never render when disabled. DebugToolsPage renders an explicit 'Debug tools are disabled in this
  environment' state when caps.debugTools is false instead of firing requests that 404. Keep the
  nginx /api/debug 404 as defense-in-depth — in prod the module is off, so the capability is false
  and the nav never surfaces the page. This fixes the whole class: the 'Open Tenant Portal'
  impersonation dead action is remediated the same way (a 'tenantPortal' capability, false until a
  consuming client exists). Do NOT paper over it by hardcoding a hidden flag in the FE — that would
  re-create the drift.
- **Files to change:**
  - `apps/admin-api-service/src/capabilities/admin-capability.token.ts`
  - `apps/admin-api-service/src/capabilities/capabilities.controller.ts`
  - `apps/admin-api-service/src/capabilities/capabilities.module.ts`
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts`
  - `apps/admin-api-service/src/app.module.ts`
  - `web/modules/admin-panel/src/services/types/capabilities.ts`
  - `web/modules/admin-panel/src/services/types/index.ts`
  - `web/modules/admin-panel/src/services/api/capabilities.ts`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx`
  - `web/modules/admin-panel/src/components/AdminLayout.tsx`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
- **Proof of fix:** Add apps/admin-api-service/src/**tests**/integration/capabilities.spec.ts: boot
  the Nest app twice (ENABLE_DEBUG_TOOLS='true' and unset), and assert the single invariant that GET
  /capabilities' `debugTools` value EXACTLY equals whether the DebugToolsController route is
  registered (introspect the router / attempt GET /debug/cache/stats -> 200-or-guarded vs 404) —
  proving the flag cannot drift from actual registration. Add
  web/modules/admin-panel/src/components/**tests**/admin-nav-items.spec.tsx: assert
  buildAdminNavItems({ debugTools:false }) omits the 'system-debug' entry and buildAdminNavItems({
  debugTools:true }) includes it; plus a DebugToolsPage test asserting the disabled-state render (no
  network calls fired) when the capability is false. These gate the contract at build/test time so a
  future env-gated module without a capability descriptor fails CI.
- **Effort:** L

### APA-302 [HIGH] Cache management is a placebo even when enabled: all invalidation paths are logger no-ops, and the FE fakes success on failure

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** CacheInspectorService.invalidateCacheByKey/invalidateCacheKey are empty placeholders
  that only log; invalidateCachePattern logs and returns 0 ('In production, this would use SCAN and
  DEL on Redis'). No RedisService is even injected. So 'Clear All Cache' (pattern '\*') and
  per-entry 'Invalidate' touch no real cache anywhere and the endpoint truthfully reports
  {invalidated:0} — which the FE never checks. Worse, both FE handlers' catch blocks are labeled
  'Mock success for demo': on error they close the confirm modal / optimistically remove the row
  from local state, so a failing destructive control is presented as having succeeded. MOCK_ONLY
  behavior on a SUPER_ADMIN operational control.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:118-138 (no-op invalidation, return 0)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:589-598 (returns {invalidated: count})`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:203-214 ('Mock success for demo' on clear)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:216-227 (optimistic local removal on error)`
- **Verification:** Every cited line verified verbatim. CacheInspectorService
  (cache-inspector.service.ts:118-138) has zero Redis wiring — constructor injects only the
  CacheEntrySnapshot repo; invalidateCacheByKey/invalidateCacheKey only this.logger.log,
  invalidateCachePattern logs and returns 0. Controller (debug-tools.controller.ts:589-598) returns
  {invalidated: count} = always {invalidated: 0}. Reachability confirmed end-to-end:
  DebugToolsModule.forRoot() registers the controller when ENABLE_DEBUG_TOOLS=true
  (debug-tools.module.ts:53-100); nginx /api->/api/v1 rewrite + PlatformAdminGuard complete the
  chain. Refutation attempts failed: (a) RedisService with del/deletePattern exists in @Global
  RedisModule registered at app.module.ts:188 — so a real cache backend was available and simply
  never wired; (b) prod protection makes it WORSE, not moot: droplet.conf:198 404s /api/debug but
  the FE route system/debug (Module.tsx:168) is unconditional, so a prod SUPER_ADMIN's 'Clear All
  Cache' 404s at nginx and DebugToolsPage.tsx:208-213 ('Mock success for demo') closes the confirm
  modal as success; per-entry handler (216-227) optimistically deletes the row from state on error;
  (c) tests cannot catch it — debug-tools.controller.spec.ts:52 mocks invalidateCachePattern to
  resolve 5. Real caches exist to purge (ReportsService 4h-TTL Redis report cache in the same
  service), so the deception has operational consequence. Same class also present in
  AdminDashboard.tsx:478-487 (silent-swallow clear cache on a production dashboard card). Severity
  HIGH upheld: deceptive success on a destructive SUPER_ADMIN operational control, reachable in
  every configuration (backend no-op when enabled; FE-faked success when blocked); not CRITICAL
  because there is no direct data/security compromise and debug tools are disabled by default
  (NEW-03).
- **Root cause:** The Service->cache-backend link of the chain was never built:
  CacheInspectorService was scaffolded against a DB snapshot table (CacheEntrySnapshot) with 'in
  production this would...' placeholder invalidation methods, despite RedisService (with
  del/deletePattern already implemented) being globally available in the same app. The drift
  persisted invisibly because both guardrails that should have exposed it were themselves fake: the
  controller unit spec mocks the service to resolve a nonzero count, and the FE handlers carry
  demo-era 'Mock success for demo' catch blocks that convert every failure (including prod nginx
  404s) into visual success while ignoring the {invalidated} count the endpoint returns. FE, BE, and
  tests each independently simulated success, so no layer could ever observe the no-op.
- **Fix design:** This is an instance of two systemic classes — MOCK_ONLY backend control and
  FE-fakes-success-on-error — so the fix is applied at both the local and pattern level. BACKEND
  (make correct behavior automatic): inject RedisService into CacheInspectorService via ordinary
  constructor injection (RedisModule is @Global in app.module.ts:188, no module wiring change
  needed). Implement the three methods for real: invalidateCacheByKey(key) ->
  `const invalidated = await redis.del(key); await cacheSnapshotRepo.delete({ key }); return invalidated;`;
  invalidateCacheKey(tenantId, key) -> delete via the platform tenant key convention (reuse
  TenantRedisService/the shared tenant prefix from libs/backend-common/src/redis — do NOT re-derive
  the prefix locally); invalidateCachePattern(tenantId, pattern) -> redis.deletePattern (SCAN +
  batched DEL already exists at redis.service.ts:159) scoped by tenant prefix when tenantId is set,
  purge matching CacheEntrySnapshot rows so the inspector view reflects reality, return the REAL
  count. Fail closed: because app-level Redis mode is 'optional', each invalidation method throws
  ServiceUnavailableException when the Redis client is absent — a destructive control must never
  silently no-op (tier 1: wrong behavior impossible). Change signatures to return the count
  everywhere (facade debug-tools.service.ts and controller) so every invalidation route uniformly
  returns {invalidated: n} — no fabricated 204-void paths. FRONTEND (make deception impossible):
  delete both 'Mock success for demo' catch blocks in DebugToolsPage.tsx — on failure setError(...)
  and leave the confirm modal open / do NOT filter the row out of local state; on success read the
  returned {invalidated} count and render it ('Invalidated N keys'), making the BE contract
  load-bearing so a future no-op regression (0 with entries present) is user-visible. Apply the
  same-class fix to AdminDashboard.tsx handleClearCache (lines 478-487): replace the empty catch
  with surfaced error state. Align debug.ts types so invalidateCacheEntry also returns {invalidated:
  number}. PATTERN GATE (tier 3): add tests/invariants/no-fake-success-handlers.spec.ts, a grep
  invariant (same style as nats-invariants/schema-invariants) failing on any 'Mock success' / 'mock
  success' marker under web/modules/\*\*/src, pinning the whole class out of the codebase.
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
- **Proof of fix:** 1) New
  apps/admin-api-service/src/impersonation/services/**tests**/cache-inspector.service.spec.ts:
  asserts invalidateCachePattern delegates to RedisService.deletePattern and returns its actual
  count (and purges matching snapshot rows); invalidateCacheByKey delegates to redis.del; all three
  throw ServiceUnavailableException when the Redis client is absent (fail-closed — proves the no-op
  is structurally gone). 2) Extend
  apps/admin-api-service/src/impersonation/controllers/**tests**/debug-tools.controller.spec.ts:
  mocked service count must flow through to the {invalidated} envelope on every invalidation route
  (no fabricated response). 3) New DebugToolsPage handler test
  (web/modules/admin-panel/src/pages/system/**tests**/DebugToolsPage.spec.tsx): on rejected
  invalidateCacheEntry/invalidateCacheByPattern the row remains in the list, the confirm modal does
  not report success, and an error is rendered; on success the returned count is displayed. 4) New
  grep invariant tests/invariants/no-fake-success-handlers.spec.ts: zero occurrences of 'Mock
  success' (case-insensitive) under web/modules/\*\*/src — pins the systemic class, catches
  AdminDashboard and any future reintroduction.
- **Effort:** M

### APA-303 [HIGH] Cache entries/stats are DB snapshots that nothing ever writes, with a fabricated hit-rate formula — and the FE response-shape mismatch means entries could never render regardless

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** GET /debug/cache reads admin.cache_entries_snapshot, whose only writer is POST
  /debug/cache/capture — grep shows no caller anywhere except the controller's own spec. The table
  is perpetually empty (plus a daily cron deletes >7d rows), so this is not a Redis inspector at
  all. getCacheStats computes hitRate = totalHits/(totalHits+totalEntries)\*100 — a meaningless
  formula presented as 'Hit Rate %'. Independently, the backend list returns {entries, summary}
  while the FE expects PaginatedResult and reads response.data — undefined — so even seeded data
  would render as 'No cache entries found'; the FE's keyPattern/limit query params are also silently
  ignored by the controller (@Query('tenantId'/'debugSessionId'/'cacheStore') only).
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:27-78 (snapshotCache -> {entries, summary})`
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:143-183 (hitRate formula :169)`
  - `grep 'cache/capture|captureCacheEntry' — writers exist only in controller/facade/spec, no producer`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:105-109 (.data || [] on non-paginated shape)`
  - `web/modules/admin-panel/src/services/api/debug.ts:72-73 (expects PaginatedResult; sends keyPattern/limit)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:560-567 (params ignored)`
- **Verification:** Every sub-claim survived adversarial verification against current code. (1)
  Producer absence: repo-wide grep for captureCacheEntry|cache/capture hits only
  debug-tools.controller.ts:569-576, the debug-tools.service.ts facade (215-228),
  cache-inspector.service.ts:83-102, and the controller spec mock — no
  middleware/interceptor/service ever posts snapshots, and the EVERY_DAY_AT_5AM cron
  (cache-inspector.service.ts:188-195) purges >7d rows, so admin.cache_entries_snapshot is
  structurally empty. (2) Fabricated formula confirmed verbatim at cache-inspector.service.ts:169:
  hitRate=(totalHits/(totalHits+totalEntries))\*100 — mixes hits with entry count; no miss counter
  exists anywhere. (3) FE shape mismatch is concretely reachable: backend returns {entries,summary};
  ResponseInterceptor wraps as {success,data} with no meta.page, so apiFetch
  (http-client.ts:341-349) unwraps to {entries,summary}; DebugToolsPage.tsx:109 reads .data on it →
  undefined → '|| []' → perpetual 'No cache entries found' even with seeded rows. (4) Params
  ignored: controller (560-567) reads only tenantId/debugSessionId/cacheStore via individual
  @Query() primitives (no DTO, so the global ValidationPipe whitelist cannot reject them); the FE's
  keyPattern/limit vanish and the service hardcodes limit(500). Aggravator the finding understates:
  invalidateCacheByKey/invalidateCachePattern (cache-inspector.service.ts:118-138) are logging stubs
  returning fake success/0, so a SUPER_ADMIN 'clearing cache' during an incident is told it worked
  while nothing happened. HIGH stands: an operator-facing debugging surface that presents fabricated
  metrics, an unreachable entry list, and false-success invalidation actively misleads during
  incidents. Fix feasibility verified: RedisModule is already registered in admin-api
  (app.module.ts:188-193) and RedisService provides scan/ttl/del/deletePattern/getClient, so a real
  inspector is implementable in-service.
- **Root cause:** Two links of the FE→BE→DB chain broke independently. (a) BE→data source: the cache
  inspector was scaffolded on a capture-then-inspect DB-snapshot model
  (admin.cache_entries_snapshot) that presumes an external producer pushing snapshots — that
  producer was never built, and the invalidation paths were left as 'In production, this would...'
  logging placeholders, so the whole feature reads a table nothing writes and mutates nothing, while
  a fabricated hitRate formula papers over the absence of real hit/miss telemetry. This is an
  instance of the systemic 'config-table-nobody-reads' class (DB mirror with no producer), despite
  the real substrate (RedisService via RedisModule) already being wired into the service. (b) FE→BE
  contract: the hand-written FE client (debug.ts) was authored against an assumed generic
  PaginatedResult+keyPattern/limit contract, never checked against the actual controller, which
  returns {entries,summary} and accepts different query params — the systemic
  FE-type-drift/envelope-shape-mismatch class with no contract test to catch it. The drift persisted
  precisely because the table is always empty: the page 'works' (renders an empty list) so nothing
  ever surfaced the mismatch.
- **Fix design:** Replace the fiction with a real Redis inspector, delete the dead snapshot model,
  and align the FE/BE contract — all three links fixed at the source, plus the pattern-level gate.
  (A) BE data source (tier 1 — make the wrong behavior impossible by removing the fake substrate):
  rewrite CacheInspectorService against the already-registered RedisService (app.module.ts registers
  RedisModule with buildRedisOptions(config,'admin','optional'); RedisService exposes
  scan/ttl/del/deletePattern/getClient). listEntries({keyPattern, limit, cursor}) = SCAN with the
  pattern + pipelined TTL/TYPE/MEMORY USAGE/OBJECT IDLETIME per key via getClient(); getCacheStats()
  = INFO stats + INFO memory + DBSIZE, computing the TRUE hitRate =
  keyspace_hits/(keyspace_hits+keyspace_misses)\*100 and byStore breakdown from the platform
  key-prefix convention; invalidateCacheByKey/invalidateCachePattern actually call del/deletePattern
  (RedisService already implements both) — the fake-success logging stubs are deleted, and when
  Redis is unavailable ('optional' mode) the endpoints return an explicit 503/available:false
  instead of fabricated zeros. (B) Dead model removal: drop the CacheEntrySnapshot entity, the
  inline CaptureSnapshotDto + POST /debug/cache/capture route, the captureCacheEntry facade method,
  and the snapshot cleanup cron; add a NEW migration dropping admin.cache_entries_snapshot
  (precedent: 1801400000000-DropRetiredLegacyConfigStores.ts; never hand-edit old migrations). (C)
  Contract alignment (tier 1 via types + tier 3 via test): GET /debug/cache accepts a validated
  query DTO class (keyPattern, limit, cursor) so ValidationPipe whitelist governs params instead of
  silently dropping them, and returns a shape the http-client unwrap actually produces for the FE —
  either emit meta.page so apiFetch returns PaginatedResult, or (better for SCAN semantics) an
  explicit ScanResult {entries, cursor, count} that the FE types declare verbatim. FE:
  services/types/debug.ts CacheEntry reshaped to what Redis truthfully reports (key, store, type,
  ttlSeconds, sizeBytes, idleSeconds) — per-key hitCount/tags/value are dropped from the list (value
  only via the GET /debug/cache/:key detail endpoint backed by a real GET+TTL);
  services/api/debug.ts getCacheEntries/getCacheStats retyped to the real contract; DebugToolsPage
  reads the aligned shape and surfaces the available:false degraded state. (D) Pattern level — this
  finding is an instance of two systemic classes already in this audit: 'config-table-nobody-reads'
  (DB mirror with no producer) and 'FE-type drift/envelope-shape mismatch' (hand-written FE types
  never checked against controllers). Apply the shared fix: add the debug-cache routes to the admin
  contract-test harness (supertest through ResponseInterceptor asserting the exact JSON the FE
  unwrap consumes, including that keyPattern/limit actually filter), so any future divergence
  between debug.ts declared types and controller output fails CI rather than rendering as silent
  empty states.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts`
  - `apps/admin-api-service/src/impersonation/services/debug-tools.service.ts`
  - `apps/admin-api-service/src/impersonation/services/debug-tools-types.ts`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts`
  - `apps/admin-api-service/src/impersonation/impersonation.module.ts`
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts`
  - `apps/admin-api-service/src/migrations/1801600000000-DropCacheEntriesSnapshot.ts`
  - `apps/admin-api-service/src/impersonation/controllers/__tests__/debug-tools.controller.spec.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/cache-inspector.service.spec.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/integration/debug-cache.contract.spec.ts`
  - `web/modules/admin-panel/src/services/api/debug.ts`
  - `web/modules/admin-panel/src/services/types/debug.ts`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
- **Proof of fix:** Add
  apps/admin-api-service/src/impersonation/**tests**/integration/debug-cache.contract.spec.ts:
  supertest against DebugToolsController with the real ResponseInterceptor, backed by ioredis-mock
  (or the e2e Redis from npm run infra:up), asserting (1) GET /debug/cache?keyPattern=X&limit=N
  returns exactly the shape the FE type declares after http-client unwrap (replicate
  parseApiEnvelope logic in the assertion) and that keyPattern/limit actually filter/bound the
  seeded keys; (2) GET /debug/cache/stats returns hitRate ===
  keyspace_hits/(keyspace_hits+keyspace_misses)\*100 from INFO stats, not a fabricated value, and
  available:false/503 when Redis is down; (3) DELETE /debug/cache/:key and POST
  /debug/cache/invalidate actually remove the seeded keys from Redis (assert absence afterwards —
  kills the fake-success stubs); (4) POST /debug/cache/capture returns 404 (route deleted). Extend
  apps/admin-api-service/src/impersonation/services/**tests**/cache-inspector.service.spec.ts for
  the SCAN pipeline. The dropped table is covered by the existing every-PR gates:
  e2e/tests/integration/schema-invariants.spec.ts plus the runtime schema-drift validator (entity
  deletion + drop migration must land together or drift detection fails at cold start). FE: extend
  the admin-panel type tests so debug.ts getCacheEntries/getCacheStats return types compile against
  the shared response contract; DebugToolsPage spec asserts seeded entries render (no more '.data on
  non-paginated shape'). All under nx affected --target=test.
- **Effort:** L

### APA-304 [HIGH] 'Active Connections' table is fabricated in the FE: hardcoded database/user/application/state values synthesized from a bare count

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** loadDatabaseData calls the real GET /database/monitoring/connections (genuine
  pg_stat_activity aggregate) but then manufactures N rows as {database:'aquaculture_prod',
  user:'app_user', applicationName:'service-N', state:'active'} from response.active alone. Every
  cell except the row count is invented; the Query/Duration columns can never populate. A
  SUPER_ADMIN debugging a production incident is shown fake connection identities presented as live
  data — silent wrong data on a diagnostic surface.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:144-164 (fabricated rows)`
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts:93-128 (backend returns aggregate counts only, no per-connection rows)`
  - `web/modules/admin-panel/src/services/api/database.ts:167-168`
- **Verification:** Confirmed end-to-end. FE:
  web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:148-155 calls
  databaseApi.getConnectionStats() (GET /database/monitoring/connections, real) then fabricates
  Array.from({length: response.active}) rows with hardcoded database:'aquaculture_prod',
  user:'app_user', applicationName:'service-${i}', state:'active'; query/queryStart/duration are
  never populated. Backend: monitoring.controller.ts:58-61 ->
  DatabaseMonitoringService.getConnectionStats() (database-monitoring.service.ts:93-133) returns
  only aggregate counts from pg_stat_activity — no per-connection endpoint exists (the per-row
  pg_stat_activity mapper getSlowQueriesFromPgActivity is a private slow-queries fallback, not
  exposed). Reachable: Module.tsx:168 routes system/debug; the tab effect fires loadDatabaseData.
  active>=1 on any live DB (the stats query counts itself; pg_backend_pid not excluded), so
  fabricated rows always render under 'Active Connections' with green 'active' badges. Unlike the
  logs/config tabs which show explicit 'not yet implemented' errors, this is silent wrong data on a
  SUPER_ADMIN production diagnostic surface — an operator debugging a connection leak sees invented
  connection identities (wrong DB name, wrong user, nonexistent applications, all-active states, no
  idle_in_transaction visibility). HIGH stands: actively misleading diagnostics, but read-only
  display with no security or data-loss path, so not CRITICAL.
- **Root cause:** FE->BE contract gap bridged by client-side fabrication instead of surfacing the
  missing endpoint. The page UI was designed for a per-connection pg_stat_activity listing, but the
  backend only ever exposed an aggregate (getConnectionStats). Because the DatabaseConnection
  interface is declared locally inside DebugToolsPage.tsx (tied to no backend contract),
  synthesizing rows compiled cleanly and nothing detected it. This is an instance of the systemic
  'FE fabricates data the backend never sent' class (sibling of FE-route-with-no-backend and
  hand-written FE-type drift): hand-written page-local types plus no render-equals-payload test let
  invented data ship as live diagnostics, while the honest pattern (logs/config tabs show 'API not
  yet implemented') was abandoned for this tab.
- **Fix design:** Fix the contract at the source (tier 1+2) and gate the fabrication class (tier 3).
  BACKEND — expose the real data: add DatabaseMonitoringService.getActiveConnections(limit=100)
  querying pg_stat_activity per-row (pid, datname AS database, usename AS user, application_name,
  client_addr, state, query_start, wait_event_type, wait_event, left(query,500), EXTRACT(EPOCH FROM
  (now()-query_start))\*1000 AS elapsed_ms; WHERE datname=current_database() AND pid !=
  pg_backend_pid()), with an explicit ActiveConnectionInfo[] return type and a normalized typed
  state union
  ('active'|'idle'|'idle_in_transaction'|'idle_in_transaction_aborted'|'fastpath'|'disabled')
  mapping Postgres's spaced state strings; factor the shared pg_stat_activity row mapping with the
  existing getSlowQueriesFromPgActivity to avoid duplication. Expose @Get('connections/list') in
  monitoring.controller.ts (static path — no shadowing with 'connections' or
  'connections/by-tenant'). FE — consume the contract and delete the fabrication: add
  ActiveConnectionInfo + DatabaseConnectionState to services/types/database.ts (this repo's
  hand-written-type contract discipline); add databaseApi.getActiveConnections() ->
  apiFetch<ActiveConnectionInfo[]>('/database/monitoring/connections/list') in
  services/api/database.ts; in DebugToolsPage.tsx delete the page-local DatabaseConnection interface
  and the Array.from fabrication block entirely, have loadDatabaseData set connections verbatim from
  getActiveConnections(), render database/user/applicationName/state/query/elapsedMs from the
  payload (Query and Duration columns now genuinely populate), extend getConnectionStateBadge to the
  normalized union, and on API failure show the error state exactly as the logs/config tabs do —
  never synthesized rows. PATTERN LEVEL: this is the FE-fabrication systemic class; the durable gate
  is a render-equals-payload component test (mock the API with distinctive values and assert those
  exact strings appear — any hardcoded 'aquaculture_prod'/'app_user' synthesis fails it), plus
  registering the new connections/list path in the audit's FE-api-path-to-controller-route coverage
  invariant so the sibling no-backend class stays covered.
- **Files to change:**
  - `apps/admin-api-service/src/database-management/services/database-monitoring.service.ts`
  - `apps/admin-api-service/src/database-management/controllers/monitoring.controller.ts`
  - `apps/admin-api-service/src/database-management/__tests__/database-monitoring.service.spec.ts`
  - `web/modules/admin-panel/src/services/types/database.ts`
  - `web/modules/admin-panel/src/services/api/database.ts`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `web/modules/admin-panel/src/pages/system/__tests__/DebugToolsPage.spec.tsx`
- **Proof of fix:** 1) New backend spec
  apps/admin-api-service/src/database-management/**tests**/database-monitoring.service.spec.ts:
  getActiveConnections maps mocked pg_stat_activity rows to ActiveConnectionInfo, normalizes 'idle
  in transaction' -> 'idle_in_transaction' (all pg states covered exhaustively via the typed union),
  excludes pg_backend_pid, and MonitoringController GET connections/list returns the service
  result. 2) New FE spec web/modules/admin-panel/src/pages/system/**tests**/DebugToolsPage.spec.tsx
  (anti-fabrication gate): mock databaseApi.getActiveConnections with distinctive rows (e.g.
  database 'tenant_db_x', user 'readonly_svc', state 'idle_in_transaction', query 'SELECT 1',
  elapsedMs 4200), activate the Database tab, and assert those exact cell values render — this fails
  if any code path synthesizes 'aquaculture_prod'/'app_user'/'service-N'; also assert a rejected API
  shows the error state and an empty table, not rows. 3) Grep-level assertion in the same FE spec
  (or the audit's fabrication-class invariant) that DebugToolsPage.tsx no longer contains the
  literals 'aquaculture_prod'/'app_user'. nx affected --target=test and --target=lint green.
- **Effort:** M

### APA-305 [MEDIUM] Log Viewer and Config Viewer tabs are client-side TODO stubs (NOT_WIRED features shipped in the UI)

- **Status:** DESIGNED (brief)
- **Symptom:** loadLogs and loadConfig set an empty list and an error string ('Log viewer API not
  yet implemented' / 'Config viewer API not yet implemented') without any network call — two of the
  page's four tabs are pure chrome. The Config tab even ships a 'Show Secrets' toggle and a
  secret-redaction column for an API that does not exist (no secret exposure occurs, but the control
  implies backend secret access is one flag away).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:128-142 (loadLogs TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:166-180 (loadConfig TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:748-759 (Show Secrets toggle)`
- **Root cause:** NOT_WIRED facade class: loadLogs (DebugToolsPage.tsx:128-142) and loadConfig
  (166-180) make no network call — they set empty data plus a hardcoded 'not yet implemented' error
  — yet the Logs and Config tabs ship as full UI, including a 'Show Secrets' toggle (748-759) for a
  config API that does not exist.
- **Fix design:** Features that don't exist must not render: remove the Logs and Config tabs, their
  state (logLevel/logContext/logSearch/configCategory/configSearch/showSecrets),
  loadLogs/loadConfig, and the Show Secrets control (UI must never imply secret access absent the
  capability). If log/config viewing is wanted product, that is tracked new work (Logs could front
  the existing /debug/api-calls captured-call surface; Config the config-service) under a finding ID
  with owner+deadline. Pattern-level gate shared with i5: an invariant spec that scans
  web/modules/admin-panel/src/pages for facade markers ('not yet implemented', 'TODO: Implement ...
  API') and fails CI, so shipped stubs become detectable.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `tests/invariants/admin-panel-no-facade-features.spec.ts`
- **Effort:** S

### APA-306 [MEDIUM] SQL Query Executor is a facade: warns about executing on the production database, then always throws client-side

- **Status:** DESIGNED (brief)
- **Symptom:** handleExecuteQuery unconditionally throws 'Query execution API endpoint not yet
  implemented' — no request is made and no arbitrary-SQL endpoint exists in admin-api (verified: no
  such route in DebugToolsController; the analyze-query monitoring endpoint is EXPLAIN-only).
  Security-positive: no remote SQL execution surface exists. Product-negative: the UI presents a
  full editor, 10k-char textarea, results grid, and a 'Warning: This will execute queries on the
  production database' banner for a capability that does not exist. Note the adjacent
  /database/explorer row-CRUD endpoints (out of this section's scope) provide a real generic table
  read/write surface, so any future wiring of this textarea must not route there without
  parameterization review.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:229-244 (unconditional throw)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:598-611 (production warning banner)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts (no SQL-execution route present)`
- **Root cause:** Same NOT_WIRED facade class: handleExecuteQuery (DebugToolsPage.tsx:236-238)
  unconditionally throws 'Query execution API endpoint not yet implemented' — no request is ever
  made and DebugToolsController intentionally has no arbitrary-SQL route — yet the tab ships a
  10k-char editor, results grid, and a 'executes on the production database' warning banner
  (598-611).
- **Fix design:** Delete the SQL Query Executor block
  (queryInput/queryExecuting/queryError/queryResult state, handleExecuteQuery, textarea, warning
  banner, results grid) from the database tab, keeping the real connection-stats view. Deliberately
  do NOT add a SQL-execution endpoint — the absence is the security posture; any future query
  capability must be a reviewed, parameterized design that does not route through the generic
  /database/explorer row-CRUD surface. Covered by the same admin-panel-no-facade-features invariant
  spec as i4, which prevents this class from shipping again.
- **Files to change:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `tests/invariants/admin-panel-no-facade-features.spec.ts`
- **Effort:** S

### APA-307 [MEDIUM] Route-declaration-order shadowing in DebugToolsController makes two endpoints unreachable

- **Status:** DESIGNED (brief)
- **Symptom:** @Get('feature-overrides/:id') is declared before @Get('feature-overrides/value'), so
  GET /debug/feature-overrides/value resolves :id='value' and hits getFeatureOverride with a
  non-UUID (Postgres uuid cast error -> 500) — the feature-flag value endpoint is dead. Likewise
  DELETE 'cache/:tenantId/:key' (declared first) captures DELETE /debug/cache/tenant/<id>, shadowing
  DELETE 'cache/tenant/:tenantId' with tenantId='tenant'. Neither is called by this page, but both
  are part of the published debug API surface.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:662-665 (':id' before 'value')`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:667-692 (shadowed 'value' route)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:600-616 (cache/:tenantId/:key before cache/tenant/:tenantId)`
- **Root cause:** Nest matches routes in declaration order within a controller:
  @Get('feature-overrides/:id') (debug-tools.controller.ts:662) precedes
  @Get('feature-overrides/value') (667), so /debug/feature-overrides/value binds id='value' and 500s
  on the uuid cast; @Delete('cache/:tenantId/:key') (600) precedes @Delete('cache/tenant/:tenantId')
  (609), so DELETE /debug/cache/tenant/<id> runs invalidateCacheKey('tenant', <id>) — both published
  routes are permanently unreachable.
- **Fix design:** Route-declaration-order is a systemic class. Local: reorder so literal-segment
  routes precede param siblings ('feature-overrides/value' above ':id'; 'cache/tenant/:tenantId'
  above 'cache/:tenantId/:key'), and add ParseUUIDPipe to :id/:tenantId params so a non-UUID can
  never reach the repository as a 500 (tier-1: 400 at the edge). Pattern: add an architecture spec
  that instantiates the admin-api testing module, walks each controller's method decorators in
  declaration order via Reflect PATH_METADATA, and fails when a route with a literal segment is
  preceded by a same-method param route that captures it — applied to every admin-api controller so
  the class is detectable at build time.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/__tests__/route-shadowing.architecture.spec.ts`
- **Effort:** M

### APA-308 [LOW] Cache key is URL-decoded twice (FE encode -> Express decode -> controller decodeURIComponent)

- **Status:** DESIGNED (brief)
- **Symptom:** Express already decodes route params; the controller decodes again in
  getCacheEntry/invalidateCacheByKey, so any key containing a literal %-sequence (e.g.
  'rate%20limit') is corrupted before lookup/deletion.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/debug.ts:74-76 (encodeURIComponent)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:578-587 (second decodeURIComponent)`
- **Root cause:** Double decode: the FE encodes the cache key once (debug.ts:74-76
  encodeURIComponent), Express decodes route params before Nest binds them, and
  getCacheEntry/invalidateCacheByKey decode AGAIN (debug-tools.controller.ts:580,586) — any key
  containing a literal %-sequence (e.g. 'rate%20limit') is corrupted ('rate limit') before
  lookup/deletion.
- **Fix design:** Single-decode contract: the framework owns param decoding, so delete both
  decodeURIComponent calls and pass @Param('key') through untouched (FE encodeURIComponent + Express
  decode is already an exact round-trip, including %2F which path-to-regexp keeps within one
  segment). Prove it with a controller-level e2e/supertest case requesting
  /debug/cache/rate%2520limit and asserting the service receives the literal 'rate%20limit' for both
  GET and DELETE, which pins the contract against reintroduction.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/__tests__/debug-tools.controller.spec.ts`
- **Effort:** S

## Cross-cutting findings

### APA-309 [HIGH] Platform audit trail is best-effort by construction: AuditLogService.log swallows every persistence failure while security-critical callers document reliance on propagation

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** admin-api's central AuditLogService.log wraps the save in try/catch and returns null
  on failure ('Don't throw - audit logging should not break main operations'). Every admin-api
  surface that awaits it for compliance-grade guarantees — most explicitly the impersonation
  lifecycle, whose AUDITTRAIL-CRITICAL-003 comments claim the await makes audit failures propagate —
  actually gets a silent null. A SUPER_ADMIN cross-tenant session (or any audited admin action) can
  complete with no audit row and no operator-visible error, contradicting the SOC2 CC1 / GDPR Art 30
  reconstruction claims embedded in the code. Either log() must offer a throwing strict mode for
  CRITICAL actions, or the callers' claims must be corrected and the gap tracked.
- **Evidence:**
  - `apps/admin-api-service/src/audit/audit.service.ts:84-107`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:551-575`
- **Verification:** CONFIRMED against the actual code. (1) `AuditLogService.log`
  (audit.service.ts:84-108) wraps `auditLogRepository.save` in try/catch and returns `null` on any
  failure — it never throws ("Don't throw - audit logging should not break main operations"). (2)
  The impersonation lifecycle callers (impersonation.service.ts:559, 617, 661, 755, 1105) `await`
  `log()` but DISCARD the return value, while their AUDITTRAIL-CRITICAL-003 comments explicitly
  assert "Awaiting the log lets a failure propagate; the operator gets a clear error instead of a
  half-recorded SUPER_ADMIN session." That claim is false: awaiting a method that internally
  swallows all errors and resolves to `null` cannot propagate anything — the caller sees success. So
  under a transient audit-DB failure, `startImpersonation` commits the ImpersonationSession row
  (sessionRepo.save at line 539, a SEPARATE auto-commit transaction from the audit write at 559),
  returns the started session to the operator, and NO audit.audit_logs row exists and NO error
  surfaces — exactly the SOC2 CC1 / GDPR Art 30 reconstruction gap the comments claim is cured. (3)
  The same swallow-then-discard pattern applies to the security-critical tenant flows:
  suspend-tenant.handler.ts:157 writes the TENANT_SUSPENDED audit AFTER `commitTransaction()`
  (line 151) and discards the result; tenant-erasure.handler.ts:191 writes TENANT_ERASURE_REQUESTED
  after commit and discards. This is a systemic class — "silent audit failure on security-critical
  writes." Decisively, the correct architectural pattern ALREADY EXISTS in the same service:
  database-management's `requireAuditLog()` (backup-restore.service.ts:504-511 checks
  `!auditLog?.id` → throws InternalServerErrorException; explorer.controller.ts:324-329 checks
  `!auditLog` → throws ForbiddenException). Only the meta-audit READ-trail callers
  (audit.controller.ts:30, audit-trail.controller.ts:330) are legitimately best-effort (`.catch()`
  with explicit "must not block the primary read" comments) and must stay non-strict. So the
  impersonation/tenant modules drifted: they document the durability guarantee that
  `requireAuditLog` provides but never adopt it. HIGH is appropriate (not over-graded): the audit
  trail for the platform's highest-privilege cross-tenant action carries explicit, load-bearing
  false compliance claims that reviewers/auditors trust, and the failure is silent to the operator.
  It is not CRITICAL because it requires an infra-level audit-DB failure (no attacker can force the
  split) and rows persist correctly under normal operation.
- **Root cause:** The broken link is BE contract design at the audit-write boundary.
  `AuditLogService.log` conflates two incompatible durability intents behind a single
  `Promise<AuditLog | null>` signature: (a) best-effort meta-audit (audit-read trail) that must
  never block the primary operation, and (b) compliance-grade lifecycle audit for security-critical
  actions that must be durable or fail loud. Because the swallowing behavior is baked into the one
  method and the criticality distinction is NOT encoded in the type/contract, every caller must
  remember to re-implement the guard. database-management remembered (requireAuditLog);
  impersonation and tenant did not, and instead added comments asserting a propagation guarantee
  that the API structurally cannot deliver. Compounding it, in `startImpersonation` the operational
  write (sessionRepo.save) and the audit write are two independent auto-commit transactions, so even
  a caller-side null-check that threw would still leave a committed ACTIVE session with no audit row
  — true durability requires the audit write to share the operational transaction.
- **Fix design:** Fix at the pattern/contract level (tier 1 make-it-impossible + tier 3
  make-it-detectable), reusing the already-proven requireAuditLog behavior:

1. Encode the two intents in the AuditLogService API so misuse is not expressible by accident. Add
   `logStrict(input: AuditLogInput, manager?: EntityManager): Promise<AuditLog>` that saves and
   returns the persisted row or throws a typed `AuditPersistenceError` — it NEVER returns null, so a
   caller cannot silently drop it. Keep the existing swallowing method but rename/document it
   explicitly as best-effort (`logBestEffort`, `Promise<AuditLog | null>`) reserved for the
   meta-audit read-trail callsites (audit.controller.ts, audit-trail.controller.ts). The
   non-null-or-throw return type makes the compliance path structurally distinct from the
   best-effort path.

2. Make the impersonation-start guarantee actually atomic (tier 1). Wrap
   `sessionRepo.save(session)` + the IMPERSONATION_STARTED audit write in a single transaction:
   `dataSource.transaction(async (m) => { const saved = await m.save(session); await auditLogService.logStrict({...}, m); return saved; })`.
   Now either the session AND its audit row commit together, or neither does — it is impossible to
   hold a SUPER_ADMIN session with no audit trail, and the operator gets a real error (matching the
   comment's claim). Apply the same transactional coupling to end/terminate/extend/expire audit
   writes.

3. Fix the tenant handlers in the same class: suspend-tenant.handler.ts and
   tenant-erasure.handler.ts already run a queryRunner transaction — move the audit write INSIDE
   that transaction via `logStrict(input, queryRunner.manager)` before `commitTransaction()`,
   instead of firing it after commit. tenant-provisioning-workflow.service.ts lifecycle audits route
   through logStrict likewise.

4. Dedupe the existing local guards: refactor database-management's two `requireAuditLog()` helpers
   to delegate to `logStrict` so there is one SSoT for 'durable-or-throw'.

5. Correct the now-false AUDITTRAIL-CRITICAL-003 comments to describe the real mechanism
   (transaction + logStrict), so the code no longer documents a guarantee it doesn't provide.

6. Make the class detectable going forward (tier 3): add an architecture/unit spec that fails if an
   impersonation/tenant lifecycle path uses the best-effort method, and that proves rollback on
   audit failure.

- **Files to change:**
  - `apps/admin-api-service/src/audit/audit.service.ts`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts`
  - `apps/admin-api-service/src/tenant/handlers/suspend-tenant.handler.ts`
  - `apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts`
  - `apps/admin-api-service/src/tenant/services/tenant-provisioning-workflow.service.ts`
  - `apps/admin-api-service/src/database-management/services/backup-restore.service.ts`
  - `apps/admin-api-service/src/database-management/controllers/explorer.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/__tests__/impersonation.service.lifecycle.spec.ts`
- **Proof of fix:** Add
  apps/admin-api-service/src/impersonation/services/**tests**/impersonation.audit-durability.spec.ts
  and extend impersonation.service.lifecycle.spec.ts: (1) mock the audit persistence
  (repository.save / logStrict) to reject, call startImpersonation, and assert it REJECTS
  (propagates) AND that no ImpersonationSession row remains in ACTIVE state (transaction rolled
  back) — proving atomicity, not just a thrown error after a committed session; (2) assert
  endImpersonation/terminateSession/extendSession/expireSession propagate on audit failure; (3) a
  static assertion that ImpersonationService and the tenant handlers reference `logStrict` (never
  the best-effort `log`/`logBestEffort`) for lifecycle events, while audit.controller.ts /
  audit-trail.controller.ts keep the best-effort variant. Extend a tenant handler spec
  (suspend-tenant.handler.spec.ts / tenant-erasure.handler.spec.ts) to assert the audit write occurs
  inside the committed queryRunner transaction (rollback on audit failure). Unit-test
  AuditLogService.logStrict returns the persisted row on success and throws AuditPersistenceError
  (never null) on save failure.
- **Effort:** L

### APA-310 [HIGH] DB immutability triggers were applied to an operational (mutable-lifecycle) table, not just audit tables — schema policy and service behavior are in direct conflict

- **Status:** CONFIRMED+DESIGNED
- **Symptom:** The Baseline migration applies the same append-only trigger pattern to
  admin.audit_logs (correct — insert-only) AND admin.impersonation_sessions (incorrect — the entity
  has a status/endedAt/expiresAt/actionCount lifecycle mutated by five service paths and a cron). No
  test or invariant catches a trigger that contradicts entity write patterns; the drift validator
  checks columns/schemas, not DML permissions. Any future 'protected-tables-guard' addition can
  silently break a service the same way. An invariant (e.g. e2e asserting UPDATE succeeds on
  lifecycle tables, or a lint tying append-only triggers to a declared insert-only entity list) is
  needed.
- **Evidence:**
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:249-280`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:604-608,650-654,727-745,893-896,1091-1097`
- **Verification:** Confirmed and concretely reachable. Baseline migration lines 265-280 install
  trg_impersonation_sessions_prevent_update as a BEFORE UPDATE OR DELETE FOR EACH ROW trigger whose
  function unconditionally RAISE EXCEPTION, plus REVOKE UPDATE, DELETE FROM PUBLIC. A BEFORE trigger
  fires for every role regardless of the REVOKE (only session_replication_role=replica skips
  triggers; grep found no such setting nor any DISABLE TRIGGER in admin-api). The entity
  impersonation-session.entity.ts declares a fully mutable lifecycle (status, endedAt, endReason,
  actionsPerformed, actionCount, accessedResources, expiresAt, plus @UpdateDateColumn updatedAt).
  Six service paths call sessionRepo.save() on already-persisted rows, each emitting a SQL UPDATE
  the trigger rejects: endImpersonation (604-608), terminateSession (650-654), extendSession
  (727-745), logAction (893-896), logResourceAccess (926-927), and expireSession (1091-1097) driven
  by @Cron(EVERY_MINUTE) expireOldSessions. All are reachable from live controller routes
  (impersonation.controller.ts 373/389/405). Net effect: a session can be created (INSERT allowed)
  but can never be ended, terminated (the operator kill-switch for a rogue SUPER_ADMIN session),
  extended, expired by cron, or action-logged — every such call throws QueryFailedError at the DB.
  No gate catches it: no later migration drops the trigger (it appears only in Baseline); unit tests
  mock sessionRepo so they never hit it; the sole live-DB immutability spec
  (e2e/tests/integration/audit-immutability.spec.ts) targets shared.audit_logs only; the drift
  validator inspects columns/schemas, not DML/trigger semantics. Kept at HIGH: it is a complete
  functional/availability break of a security-sensitive SUPER_ADMIN feature (borders CRITICAL
  because the terminate kill-switch is non-functional) but it is not a data-integrity corruption or
  an auth bypass, and it fails loudly rather than silently granting access.
- **Root cause:** The DB link (Baseline migration) broke. A hand-authored 'protected-tables-guard'
  (Faz 1.4/3.5 addition) blanket-applied the audit-table append-only trigger pattern to
  admin.impersonation_sessions by name/security-resemblance, treating an operational table as an
  audit table. The service's true append-only audit target is admin.audit_logs / shared.audit_logs
  (written via auditLogService.log on every session transition — the migration comment even
  acknowledges the session table is 'operational, not audit'), so freezing impersonation_sessions is
  a category error that directly contradicts six lifecycle-mutating write paths. It drifted because
  nothing classifies which admin tables are genuinely insert-only vs operational: (a) no declared
  insert-only-entity registry ties append-only triggers to an allowed table set, (b) the
  schema-drift validator checks columns/schemas not trigger DML semantics, (c) unit tests mock the
  repo so they never exercise the real trigger, and (d) the only immutability integration test
  covers shared.audit_logs, not admin's tables. Any future protected-tables-guard extension can
  silently freeze another live table the same way.
- **Fix design:** Systemic-class fix (immutability-trigger-on-wrong-table with no invariant),
  applied at both the source and the pattern level. (1) SOURCE fix at the DB: add a NEW forward
  migration (never hand-edit Baseline) that DROP TRIGGER trg_impersonation_sessions_prevent_update,
  DROP FUNCTION admin.impersonation_sessions_prevent_update_or_delete(), and GRANT UPDATE, DELETE ON
  admin.impersonation_sessions back to the service role (reversing the REVOKE). This is blue-green
  safe (drop+grant is additive). The impersonation audit trail is unaffected — it lives in the
  append-only audit_logs tables via auditLogService.log. (2) Make recurrence impossible/detectable
  at the pattern level: introduce a single declarative SSoT of append-only tables per schema — an
  appendOnlyTables field on MODULE_SCHEMAS in schema-manager.service.ts (the same SSoT that already
  owns infrastructureTables), listing exactly the insert-only tables (admin => ['audit_logs'], NOT
  impersonation_sessions). Reachable tier-1 hardening: expose a migration helper
  applyAppendOnlyGuard(schema, table) in backend-common that installs the prevent-update trigger
  ONLY for tables present in that registry, so a non-declared table structurally cannot be frozen;
  future append-only triggers derive from the list instead of hand-written per-table SQL. (3)
  Detection gate (tier 3): add a live-DB integration invariant asserting a two-way match — every
  table in the admin schema carrying a \*\_prevent_update_or_delete trigger MUST be in
  appendOnlyTables['admin'] (catches a trigger on the wrong table, i.e. exactly this bug), AND
  positively assert that admin.impersonation_sessions ACCEPTS an UPDATE of a lifecycle column
  (insert a row, UPDATE status/endedAt -> succeeds), encoding the 'UPDATE succeeds on lifecycle
  tables' invariant the finding requests.
- **Files to change:**
  - `apps/admin-api-service/src/migrations/1801600000000-DropImpersonationSessionsImmutabilityGuard.ts`
  - `libs/backend-common/src/database/schema-manager.service.ts`
  - `libs/backend-common/src/database/append-only-guard.util.ts`
  - `e2e/tests/integration/admin-append-only-invariant.spec.ts`
- **Proof of fix:** New live-DB integration spec
  e2e/tests/integration/admin-append-only-invariant.spec.ts that: (a) INSERTs an
  admin.impersonation_sessions row and asserts UPDATE ... SET status='ended', "endedAt"=now() WHERE
  id=$1 succeeds with rowCount 1 (fails today because the trigger raises) — proves the operational
  lifecycle is writable; (b) queries information_schema.triggers for the admin schema, collects
  every table with a trigger name matching %\_prevent_update% and asserts that set equals
  appendOnlyTables['admin'] (= {audit_logs}) from schema-manager.service.ts — fails if
  impersonation_sessions (or any non-declared table) carries the guard. Plus the existing
  e2e/tests/integration/audit-immutability.spec.ts stays green (audit_logs still frozen). Confirm
  the forward migration's down() restores the trigger for reversibility. Run nx affected
  --target=test for admin-api-service and the e2e integration project, and nx affected
  --target=lint.
- **Effort:** M

### APA-311 [MEDIUM] Hand-written FE types with no codegen have drifted to the point of conceptual inversion

- **Status:** DESIGNED (brief)
- **Symptom:** The admin-panel's services/types are maintained by hand against admin-api. In this
  section that produced: an ImpersonationPermission FE type sharing only
  id/isActive/grantedAt/expiresAt with the backend entity (and modeling per-tenant grants where the
  backend models per-admin grants), a cache list typed as PaginatedResult against a
  {entries,summary} response, and a revoke call whose parameter is named superAdminId while the page
  passes a permission id. Field-level drift here is not cosmetic — it produces render crashes,
  permanent 404s, and permanently-empty tables. A codegen or contract-test layer (OpenAPI from the
  Nest controllers, or response-shape assertions in CI) is the architectural fix.
- **Evidence:**
  - `web/modules/admin-panel/src/services/types/impersonation.ts:25-39 vs apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:192-251`
  - `web/modules/admin-panel/src/services/api/debug.ts:72-73 vs apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:68-77`
- **Root cause:** admin-panel types in services/types/\* are hand-transcribed against the backend
  with no shared source of truth, and the only CI gate
  (apps/admin-api-service/src/**tests**/contract-validation.spec.ts) statically matches URL+method
  only. So field-level drift is invisible: ImpersonationPermission was written against an imagined
  per-tenant grant model while the backend entity (impersonation-session.entity.ts:192-251) is a
  per-admin grant
  (superAdminId/canImpersonate/allowedTenants/maxSessionDurationMinutes/maxConcurrentSessions...);
  getCacheEntries is typed PaginatedResult<CacheEntry> while GET /debug/cache returns {entries,
  summary} (cache-inspector.service.ts:68-77); revokePermission's path param is :superAdminId
  (api/impersonation.ts:49-50) but ImpersonationPage.tsx:312 passes permission.id — route-shape
  matching passes, the call 404s forever.
- **Fix design:** Systemic class: FE-type drift; fix at the pattern level. (Tier 1) Create a
  framework-free shared contract lib libs/admin-contracts (interfaces only — no Nest/ORM imports, so
  the federated FE can import it) exporting per-resource request/response types:
  ImpersonationPermissionView (per-admin grant shape mirroring the entity minus internals),
  SafeImpersonationSession, CacheSnapshotResult {entries: CacheEntrySnapshotView[]; summary:
  {totalKeys; totalSizeBytes; avgTtlSeconds; expiringInHour; storeBreakdown}}, etc. Backend:
  controller/service methods declare explicit return types from the lib
  (Promise<CacheSnapshotResult> on snapshotCache, Promise<ImpersonationPermissionView> on permission
  reads) so entity/contract divergence is a compile error; FE: services/types/impersonation.ts and
  debug.ts become re-exports of the lib types (delete the hand-written duplicates), and api fns
  parameterize apiFetch with them. (Tier 3) Extend the existing AST-based contract spec with a shape
  gate: assert every apiFetch<T> generic in services/api/\* resolves to a type imported from
  @aquaculture/admin-contracts, so a new hand-written response type fails CI. Local application:
  correct ImpersonationPermission to the per-admin shape and update the ImpersonationPage
  permissions table to render real fields; retype getCacheEntries to CacheSnapshotResult and fix the
  cache-inspector table on DebugToolsPage to consume entries+summary; keep
  revokePermission(superAdminId) but drop the dead \_revokedBy/\_reason params and fix
  ImpersonationPage.tsx:312 to pass the row's superAdminId, not permission.id.
- **Files to change:**
  - `libs/admin-contracts/src/index.ts`
  - `libs/admin-contracts/src/impersonation.ts`
  - `libs/admin-contracts/src/debug-tools.ts`
  - `tsconfig.base.json`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts`
  - `web/modules/admin-panel/src/services/types/impersonation.ts`
  - `web/modules/admin-panel/src/services/types/debug.ts`
  - `web/modules/admin-panel/src/services/api/impersonation.ts`
  - `web/modules/admin-panel/src/services/api/debug.ts`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `apps/admin-api-service/src/__tests__/contract-validation.spec.ts`
- **Effort:** L

### APA-312 [MEDIUM] Backend feature availability (env flags, nginx blocks) is invisible to the admin-panel: pages ship for surfaces that are disabled by design

- **Status:** DESIGNED (brief)
- **Symptom:** DebugToolsModule is off unless ENABLE_DEBUG_TOOLS=true and production nginx 404s
  /api/debug outright, yet the admin nav unconditionally renders the Debug Tools page; similarly the
  Impersonation page ships an 'Open Tenant Portal' action for an access mechanism no client
  implements. There is no capability/feature-flag handshake between admin-api and the panel (e.g. a
  /capabilities endpoint or config-service flag the nav consumes), so operators encounter dead tools
  with generic error toasts instead of an honest 'disabled in this environment' state.
- **Evidence:**
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts:53-61`
  - `infrastructure/nginx/droplet.conf:198-200`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx:210-211`
  - `web/shell/src/App.tsx:288-300`
- **Root cause:** Feature availability is decided server-side with no discoverable signal:
  DebugToolsModule.forRoot() registers an empty shell unless ENABLE_DEBUG_TOOLS=true
  (debug-tools.module.ts:53-61) and prod nginx returns 404 for /api/debug (droplet.conf:198-200),
  yet admin-nav-items.tsx:211 is a static array that always renders the Debug Tools entry, and
  ImpersonationPage.tsx:672 ships an 'Open Tenant Portal' action no client implements. There is no
  capabilities endpoint anywhere in admin-panel (grep confirms), so operators hit dead tools with
  generic error toasts.
- **Fix design:** Systemic class: backend availability invisible to FE; fix with a capability
  handshake derived from actual module registration so it can never drift from reality (Tier 2).
  Backend: new CapabilitiesModule in admin-api exposing GET /capabilities (inside the
  PlatformAdminGuard boundary), aggregating a multi-provider ADMIN_CAPABILITY token;
  DebugToolsModule.forRoot() contributes {key:'debugTools', enabled:isEnabled} in BOTH branches
  using the same boolean that gates controller registration — a single decision point, no env
  re-read elsewhere. FE: capabilities type in libs/admin-contracts + services/api/capabilities.ts;
  convert the static nav array into buildAdminNavItems(caps) that filters entries carrying a
  requiredCapability field ('system-debug' -> 'debugTools'), consumed by AdminLayout via a cached
  query; DebugToolsPage renders an explicit 'Debug tools are disabled in this environment' state
  when the capability is false instead of firing requests that 404. Remove the 'Open Tenant Portal'
  button — no client implements portal consumption of the impersonation token, so shipping the
  action is dishonest UI; reintroduce behind a 'tenantPortal' capability only when a consuming
  client exists (tracked finding, owner: admin-panel maintainer). Keep the nginx /api/debug block as
  defense-in-depth — in prod the module is off so the capability is false and the nav never shows
  the page. Verification: apps/admin-api-service/src/**tests**/capabilities.spec.ts boots the app
  with ENABLE_DEBUG_TOOLS on/off and asserts capabilities.debugTools exactly matches whether /debug
  routes are registered; FE component test asserts the nav omits system-debug when the capability is
  false.
- **Files to change:**
  - `apps/admin-api-service/src/capabilities/capabilities.module.ts`
  - `apps/admin-api-service/src/capabilities/capabilities.controller.ts`
  - `apps/admin-api-service/src/app.module.ts`
  - `apps/admin-api-service/src/debug-tools/debug-tools.module.ts`
  - `libs/admin-contracts/src/capabilities.ts`
  - `web/modules/admin-panel/src/services/api/capabilities.ts`
  - `web/modules/admin-panel/src/components/admin-nav-items.tsx`
  - `web/modules/admin-panel/src/components/AdminLayout.tsx`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx`
  - `apps/admin-api-service/src/__tests__/capabilities.spec.ts`
- **Effort:** M

### APA-313 [LOW] NestJS static-segment routes declared after parameterized siblings are shadowed — recurring pattern risk

- **Status:** DESIGNED (brief)
- **Symptom:** DebugToolsController has two instances (feature-overrides/value after
  feature-overrides/:id; cache/tenant/:tenantId after cache/:tenantId/:key). ImpersonationController
  got the ordering right (sessions/validate, sessions/active before sessions/:id), showing the team
  knows the rule but has no lint/test enforcing it. A controller-route-ordering invariant test would
  make this class of bug detectable at build time.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:600-616,662-692`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:426-449`
- **Root cause:** NestJS/Express registers routes in declaration order, so a static segment declared
  after a parameterized sibling is unreachable. Confirmed in DebugToolsController:
  @Get('feature-overrides/:id') (line 662) precedes @Get('feature-overrides/value') (667), so GET
  /debug/feature-overrides/value binds id='value' and does a doomed UUID lookup;
  @Delete('cache/:tenantId/:key') (600) precedes @Delete('cache/tenant/:tenantId') (609), so
  tenant-wide invalidation binds tenantId='tenant', key='<uuid>' into the wrong handler.
  ImpersonationController (sessions/validate, sessions/active, sessions/active/count before
  sessions/:id, lines 426-449) shows the rule is known but enforced only by convention — no
  lint/test gate.
- **Fix design:** Local: reorder DebugToolsController so static-segment routes precede parameterized
  siblings — move @Get('feature-overrides/value') above @Get('feature-overrides/:id'), and
  @Delete('cache/tenant/:tenantId') above @Delete('cache/:tenantId/:key') (the tenant/ prefix then
  also disambiguates the two 3-segment DELETE patterns). Pattern (Tier 3 — Tier 1 is not achievable
  inside Nest's decorator model): new repo-wide invariant
  tests/invariants/controller-route-shadowing.spec.ts that AST-scans every
  apps/_/src/\*\*/_.controller.ts (reuse the typescript-compiler extraction approach already proven
  in apps/admin-api-service/src/**tests**/contract-validation.spec.ts), collects per-controller,
  per-HTTP-method route paths in declaration order, converts :param segments to single-segment
  wildcards, and fails when an earlier route's pattern matches a later route's more-static path —
  making the entire bug class a CI failure with a message naming the two conflicting decorators. No
  allowlist: the two debug-tools instances are fixed in the same commit so the gate lands green.
- **Files to change:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`
  - `tests/invariants/controller-route-shadowing.spec.ts`
- **Effort:** M

## Finding registry anchors

Registry IDs (`docs/reviews/_registry/findings.jsonl`) tracking findings in this document:

- **ADMIN-CRITICAL-013** — APA-288: `admin.impersonation_sessions` reclassified operational; the
  append-only `prevent_update` trigger is dropped (lifecycle restored), classification moved to the
  `APPEND_ONLY_TABLES` / `LIFECYCLE_GUARDED_TABLES` SSoT. See docs/adr/046.
- **ADMIN-CRITICAL-014** — APA-289: impersonation credential has no request-path consumer (RC-11
  split-brain); access-plane binding is tracked with a drift gate + architecture-of-record in
  docs/adr/046.
- **ADMIN-MEDIUM-084** — APA-297: the page's stat cards and session table told the operator things
  that were not true. `GET /impersonation/stats` (all-time, unparameterised) and
  `GET /impersonation/audit/summary` (windowed, no consumer) computed overlapping aggregates over
  different periods, and the panel rendered the first under a hardcoded "(30d)" heading — so the
  headline number on a privileged-access audit surface was wrong by however long the platform had
  been running. The windowed endpoint would not have rescued it: its `totalSessions` counted
  `createdAt < end` and ignored `start`, the only field in the response that did. Now one endpoint
  owns the aggregate; it returns `windowStart`/`windowEnd` and suffixes every field `InWindow` or
  `Now`, so the panel derives its period heading instead of writing one. "Actions Logged" comes from
  a `SUM(actionCount)` over the window rather than a sum across the 20 rows that happened to be
  loaded, the session table is server-paginated with its search and status filter sent to the
  backend (`QuerySessionsDto.search` is new), and the tab is renamed "All Sessions" because that is
  what one unfiltered paginated query returns. Also fixes a rate-limit `setInterval` that never
  called `unref()` — found because it hung the Jest run used to red-prove the window.
