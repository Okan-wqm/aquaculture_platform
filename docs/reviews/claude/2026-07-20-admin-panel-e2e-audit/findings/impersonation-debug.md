# Impersonation & Debug Tools — findings

> Part of [Admin Panel E2E Audit](../README.md). IDs `APA-xxx` are stable; severity shown is the verified severity where status is CONFIRMED, else the auditor's grade pending verification.


## ImpersonationPage — `/admin/system/impersonation` — verdict: **BROKEN**

**Chain:** FE (services/api/impersonation.ts) -> nginx '/api/' catch-all rewrites /api/X to /api/v1/X (infrastructure/nginx/droplet.conf:377-383) -> admin-api-service global prefix 'api/v1' + VERSION_NEUTRAL versioning (libs/backend-common/src/bootstrap/create-service-app.ts:610,799-810; apps/admin-api-service/src/main.ts:17-19) -> ImpersonationController guarded by PlatformAdminGuard (SUPER_ADMIN only, RS256 JWT: impersonation.controller.ts:281 plus global APP_GUARD app.module.ts:283-286) -> ImpersonationService -> admin.impersonation_sessions / admin.impersonation_permissions (created in 1800000000000-Baseline.ts) + admin.audit_logs. The {success,data,meta} envelope from ResponseInterceptor is correctly unwrapped by http-client for all three list shapes. READ chains verified real-to-DB (sessions, permissions, stats). Security positives verified: token stored SHA-256-hashed, SafeImpersonationSession strips token columns on every read path, ThrottleSensitive on start/end/terminate/extend, Redis rate-limit on start, IP binding on validate, audit rows written for start/end/terminate/extend/expire. HOWEVER: (1) the Baseline migration installs a BEFORE UPDATE OR DELETE trigger on admin.impersonation_sessions that raises on ANY update while the service ends/terminates/extends/expires/log-actions via repo.save() UPDATEs — all session-lifecycle mutations 500; (2) the raw impersonation token returned at start is discarded by the FE and consumed by no client anywhere, so actual impersonated tenant access is impossible; (3) the Permissions tab renders a hand-written FE type that shares almost no fields with the backend entity and crashes on real data.

**Endpoints exercised:** `GET /api/impersonation/sessions (matches @Get('sessions'), default limit 20)`; `GET /api/impersonation/permissions (matches @Get('permissions'); tenantId filter param is latently broken)`; `GET /api/impersonation/stats (matches @Get('stats'))`; `GET /api/admin/tenants/search?q=&limit=100 (tenant.controller.ts:136,176 — tenant dropdown)`; `POST /api/impersonation/sessions/start (StartImpersonationDto — works only until DB trigger side-effects lock the admin out)`; `POST /api/impersonation/sessions/:id/end (500s at DB trigger)`; `POST /api/impersonation/sessions/:id/extend (500s at DB trigger)`; `POST /api/impersonation/sessions/:id/terminate (500s at DB trigger; also unreachable from UI — no button sets confirmAction type 'revoke')`; `POST /api/impersonation/permissions (GrantPermissionDto)`; `POST /api/impersonation/permissions/:superAdminId/revoke (FE passes wrong identifier — always 404)`; `getSessionActions: client-side stub that throws — no backend GET for session actions`

**DB tables:** `admin.impersonation_sessions (Baseline.ts:165-170; append-only trigger Baseline.ts:266-280)`, `admin.impersonation_permissions (Baseline.ts:171-172)`, `admin.audit_logs (Baseline.ts:8; append-only trigger Baseline.ts:249-264)`

### APA-288 [CRITICAL] DB append-only trigger on impersonation_sessions makes every session-lifecycle mutation fail (end/terminate/extend/expire/log-action all 500; live sessions unrevocable; starts eventually hard-blocked)

- **Status:** PENDING
- **Symptom:** The active Baseline migration creates trigger trg_impersonation_sessions_prevent_update which RAISEs an exception on any UPDATE or DELETE of admin.impersonation_sessions ('append-only ... UPDATE/DELETE refused'), and no later migration drops it (grep over apps/admin-api-service/src/migrations found only the Baseline create and its down()). But ImpersonationService mutates existing rows via sessionRepo.save() in endImpersonation, terminateSession, extendSession, logAction, logResourceAccess and the every-minute expireOldSessions cron. Consequences: (a) End Session / Extend / Terminate buttons always 500 — an in-flight impersonation credential CANNOT be revoked or killed (security hole: the kill-switch documented as AUDITTRAIL/H26/H21 fixes is dead); (b) the expiry cron throws every minute forever, and rows stay status='active' in the DB permanently; (c) canImpersonate counts ACTIVE rows against maxConcurrentSessions (default 3), so after 3 starts an admin is permanently locked out with 'Maximum concurrent sessions reached'; (d) validateSession on an expired session calls expireSession -> save -> throws -> 500; (e) revokeImpersonationPermission calls endAllSessionsForAdmin -> endImpersonation -> 500 whenever the admin has active sessions; (f) the in-session action log (logAction) can never persist, so the per-session audit array is permanently empty. The DB immutability guard and the mutable session lifecycle are architecturally contradictory.
- **Evidence:**
  - `apps/admin-api-service/src/migrations/1800000000000-Baseline.ts:266-280 (trigger + REVOKE UPDATE,DELETE)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:604-608 (endImpersonation save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:650-654 (terminateSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:727-745 (extendSession save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:893-896 (logAction save)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:1091-1097 (expireSession save, called by EVERY_MINUTE cron at :1072-1089)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:416-424 (ACTIVE count vs maxConcurrentSessions)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

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

- **Status:** PENDING
- **Symptom:** handleEndSession and handleExtendSession catch errors with console.error only (no setPageError), then close the modal and refetch — on the backend's owner-only checks (H26: only the session owner may end/extend), a second admin trying to stop a colleague's session gets a silent no-op: modal closes, session still active, zero feedback. The only sanctioned path for stopping someone else's session is POST /sessions/:id/terminate, and the FE has handleRevokeSession + a confirm branch for type 'revoke', but no button anywhere sets confirmAction.type='revoke' — the override is dead code. Net: from this page, one admin cannot stop another admin's active impersonation at all (independent of the DB-trigger issue).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:247-256 (end: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:258-267 (extend: console.error only)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:269-282,1318-1319 (revoke handler + branch never triggered; grep shows no setConfirmAction type 'revoke')`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:599-602,700-703 (owner-only 403s)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-296 [MEDIUM] Grant form drift: duration input allows 15-480 min vs backend @Max(60), and 'Allowed Actions' checkboxes are never sent

- **Status:** PENDING
- **Symptom:** The Max Session Duration input permits up to 480 minutes but GrantPermissionDto caps maxSessionDurationMinutes at IMPERSONATION_MAX_SESSION_MINUTES=60 (forbidNonWhitelisted global pipe) — any value 61-480 the UI accepts produces a 400. The read/write/admin 'Allowed Actions' checkboxes are collected in state but omitted from the grant payload, and the backend has no such field (capabilities live in defaultPermissions, which the FE never sets) — so every grant's session capabilities fall back to view-only defaults regardless of what the operator checks. Fails safe, but the security UI misrepresents what was granted.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:1086-1093 (min 15 max 480)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:77-83 (@Max(IMPERSONATION_MAX_SESSION_MINUTES))`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:19 (cap = 60)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:287-294 (payload omits allowedActions)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:501-514 (grantedPerms fallback = view-only defaults)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-297 [MEDIUM] Stats mislabeled and aggregates truncated to first 20 sessions (no pagination)

- **Status:** PENDING
- **Symptom:** The 'Total Sessions (30d)' card renders getImpersonationStats().totalSessions which is sessionRepo.count() over ALL time, not 30 days. The 'Actions Logged' card sums actionCount over the sessions state, which is one unpaginated getSessions() call — backend default limit 20 — so both this card and the History tab silently cap at the 20 most recent sessions with no pagination controls. A dedicated backend audit endpoint (GET /impersonation/audit/summary with real 30d windowing, top tenants, reason breakdown) exists but is never called by the page.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:469-470 ('Total Sessions (30d)' label)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:346-349 (count() all-time)`
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:497-499 (sum over sessions state)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:967-969 (default limit 20)`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:499-508 (unused audit/summary endpoint)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-298 [MEDIUM] GET /impersonation/permissions?tenantId=... 500s: ANY() applied to a jsonb column

- **Status:** PENDING
- **Symptom:** queryPermissions filters with ':tenantId = ANY(p.allowedTenants)' but allowedTenants is a jsonb column — Postgres rejects ANY/ALL on jsonb ('op ANY/ALL (array) requires array on right side'). The page calls getPermissions() without tenantId so it is latent here, but the documented API param is broken and any future caller (or the FE checkPermission flow) filtering by tenant gets a 500.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:320-324`
  - `apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:210-211 (jsonb allowedTenants)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-299 [LOW] targetTenantName is client-supplied and stored unverified into the session/audit record

- **Status:** PENDING
- **Symptom:** The FE sends the display name it happens to have cached; the backend persists it without cross-checking auth.tenants. The audit trail's human-readable tenant identity is therefore spoofable by the request author (mitigated by targetTenantId being the real key).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:233`
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:117-120`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:517-521`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-300 [LOW] Top-admins emails render 'Unknown' going forward (H-08 removed email from JWT)

- **Status:** PENDING
- **Symptom:** superAdminEmail is populated from the JWT (user.email), which post H-08 is absent, so new session rows store null and the stats topAdmins fallback shows 'Unknown' — the Audit Summary tab degrades to opaque UUID-keyed rows with no email backfill from auth-service.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts:352-361 (user.email may be undefined)`
  - `apps/admin-api-service/src/impersonation/services/impersonation.service.ts:371-375 (email || 'Unknown')`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


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

- **Status:** PENDING
- **Symptom:** CacheInspectorService.invalidateCacheByKey/invalidateCacheKey are empty placeholders that only log; invalidateCachePattern logs and returns 0 ('In production, this would use SCAN and DEL on Redis'). No RedisService is even injected. So 'Clear All Cache' (pattern '*') and per-entry 'Invalidate' touch no real cache anywhere and the endpoint truthfully reports {invalidated:0} — which the FE never checks. Worse, both FE handlers' catch blocks are labeled 'Mock success for demo': on error they close the confirm modal / optimistically remove the row from local state, so a failing destructive control is presented as having succeeded. MOCK_ONLY behavior on a SUPER_ADMIN operational control.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/services/cache-inspector.service.ts:118-138 (no-op invalidation, return 0)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:589-598 (returns {invalidated: count})`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:203-214 ('Mock success for demo' on clear)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:216-227 (optimistic local removal on error)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

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

- **Status:** PENDING
- **Symptom:** loadLogs and loadConfig set an empty list and an error string ('Log viewer API not yet implemented' / 'Config viewer API not yet implemented') without any network call — two of the page's four tabs are pure chrome. The Config tab even ships a 'Show Secrets' toggle and a secret-redaction column for an API that does not exist (no secret exposure occurs, but the control implies backend secret access is one flag away).
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:128-142 (loadLogs TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:166-180 (loadConfig TODO)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:748-759 (Show Secrets toggle)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-306 [MEDIUM] SQL Query Executor is a facade: warns about executing on the production database, then always throws client-side

- **Status:** PENDING
- **Symptom:** handleExecuteQuery unconditionally throws 'Query execution API endpoint not yet implemented' — no request is made and no arbitrary-SQL endpoint exists in admin-api (verified: no such route in DebugToolsController; the analyze-query monitoring endpoint is EXPLAIN-only). Security-positive: no remote SQL execution surface exists. Product-negative: the UI presents a full editor, 10k-char textarea, results grid, and a 'Warning: This will execute queries on the production database' banner for a capability that does not exist. Note the adjacent /database/explorer row-CRUD endpoints (out of this section's scope) provide a real generic table read/write surface, so any future wiring of this textarea must not route there without parameterization review.
- **Evidence:**
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:229-244 (unconditional throw)`
  - `web/modules/admin-panel/src/pages/system/DebugToolsPage.tsx:598-611 (production warning banner)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts (no SQL-execution route present)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-307 [MEDIUM] Route-declaration-order shadowing in DebugToolsController makes two endpoints unreachable

- **Status:** PENDING
- **Symptom:** @Get('feature-overrides/:id') is declared before @Get('feature-overrides/value'), so GET /debug/feature-overrides/value resolves :id='value' and hits getFeatureOverride with a non-UUID (Postgres uuid cast error -> 500) — the feature-flag value endpoint is dead. Likewise DELETE 'cache/:tenantId/:key' (declared first) captures DELETE /debug/cache/tenant/<id>, shadowing DELETE 'cache/tenant/:tenantId' with tenantId='tenant'. Neither is called by this page, but both are part of the published debug API surface.
- **Evidence:**
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:662-665 (':id' before 'value')`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:667-692 (shadowed 'value' route)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:600-616 (cache/:tenantId/:key before cache/tenant/:tenantId)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).

### APA-308 [LOW] Cache key is URL-decoded twice (FE encode -> Express decode -> controller decodeURIComponent)

- **Status:** PENDING
- **Symptom:** Express already decodes route params; the controller decodes again in getCacheEntry/invalidateCacheByKey, so any key containing a literal %-sequence (e.g. 'rate%20limit') is corrupted before lookup/deletion.
- **Evidence:**
  - `web/modules/admin-panel/src/services/api/debug.ts:74-76 (encodeURIComponent)`
  - `apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts:578-587 (second decodeURIComponent)`
- **Root cause & fix design:** PENDING — queued in the staged remediation-design continuation (see README §Status).


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
