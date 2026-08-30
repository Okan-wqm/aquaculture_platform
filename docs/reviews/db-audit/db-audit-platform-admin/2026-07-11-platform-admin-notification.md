# DB Audit — Platform Admin & Notification Partition — 2026-07-11

**Agent:** db-audit-platform-admin (Lane-D, CATCHER)
**Cycle date:** 2026-07-11
**Status:** COMPLETE

## Scope

Backend: `apps/admin-api-service` (schema `admin`, platform-level; REST-only, 42 controllers)

- `apps/notification-service` (schema `notification`). Enumerated **72 persistence-shaped classes**
  in admin-api (69 `@Entity`-decorated + 3 undecorated: `GlobalConfig`, `TenantConfiguration`,
  `SystemSetting`) + 3 notification entities. Cross-tenant infra verified vs `MODULE_SCHEMAS['admin']`
  (`libs/backend-common/src/database/schema-manager.service.ts:674-735`). Frontend: field-by-field
  parity diff (both directions) between admin controller/service response DTOs and the hand-written
  types in `web/modules/admin-panel/src/services/types/*.ts` (no OpenAPI codegen) — the primary
  deliverable.

## Executive summary

The admin↔panel REST boundary is high-drift, as predicted. Most severe class: **entity-shaped REST
responses consumed by hand-written FE types whose field names were never reconciled.** The entire
impersonation session/permission surface returns raw entities (`superAdminId`/`targetTenantId`/
`createdAt`/`actionsPerformed[]`) while the FE type expects `adminId`/`tenantId`/`startedAt`/
`actionsPerformed:number` — every field resolves `undefined` in the panel, and the same responses leak
`originalSessionToken` (stored **plaintext**). The tenant surface persists suspension metadata
(`suspendedAt/reason/by`, `lastActivityAt`) to transient non-`@Column` fields TypeORM silently drops,
and dual-writes `auth.tenants` directly while also invoking the auth-service command (SSoT fork).
`GlobalConfig` is a dead unregistered class; `TenantConfiguration`/`SystemSetting` are legacy adapters
that serve fabricated defaults; 13 admin-schema tables are absent from `MODULE_SCHEMAS`. Positives:
impersonation lifecycle + DB backup/restore write awaited audit rows; destructive schema/migration ops
are disabled at runtime (delegated to `aqua-db-migrate`); notification dispatch covers all channels.
Verdict: **BLOCK** (5 HIGH). Full matrix + incidentals below.

## Findings (by severity)

### CRITICAL

None confirmed. (DB-ADMIN-HIGH-002 token leak escalates to CRITICAL if `originalSessionToken` grants
live session authority — flagged for auth-security-expert.)

### HIGH

#### DB-ADMIN-HIGH-001 — Impersonation REST responses return raw entities; entire FE contract mismatches

**Severity:** HIGH · **Layer:** 2 · **State:** OPEN
**Evidence**

- `impersonation/services/impersonation.service.ts:936-942,895-934,1104-1118,317-356` — `getSession`/`querySessions`/`getActiveSessions`/`getImpersonationStats.recentSessions`/`getAuditSummary.recentSessions` return raw `ImpersonationSession` entities; controller `impersonation/controllers/impersonation.controller.ts:438-455,428-431` passes them through unmapped.
- Entity (`impersonation-session.entity.ts:55-145`): `superAdminId`,`superAdminEmail`,`targetTenantId`,`targetTenantName`,`targetUserId`,`createdAt`,`actionsPerformed: ImpersonationAction[]`,`actionCount`.
- FE (`services/types/impersonation.ts:21-38`): `adminId`,`adminEmail`,`tenantId`,`tenantName`,`originalUserId`,`impersonatedUserId`,`sessionToken`,`startedAt`,`lastActivityAt`,`actionsPerformed: number`.
- Result: `adminId`/`tenantId`/`startedAt`/`sessionToken`/`lastActivityAt` = `undefined`; `actionsPerformed` is an array where the FE types a number. `ImpersonationPermission` drifts identically (`maxSessionDuration`↔`maxSessionDurationMinutes`; `allowedActions[]`↔`defaultPermissions`; `grantedByEmail`↔`superAdminEmail`; FE `tenantId`/`reason`/`revokedAt`/`revokedBy` have no entity source).
  **Rule violated** — Partition invariant "hand-written REST types are guilty until proven synced"; layer-2 contract drift.
  **Proposed fix direction** — One explicit `ImpersonationSessionDto` mapper (single owner), OR rename FE fields to the entity contract; add a controller-response parity spec (Tier-3).
  **Expected closer** — admin-expert WRITER mode.

#### DB-ADMIN-HIGH-002 — Impersonation GET endpoints leak session tokens

**Severity:** HIGH · **Layer:** 2 (security) · **State:** OPEN
**Evidence** — `impersonation.service.ts:503` stores `originalSessionToken` **plaintext**; `:504` stores `impersonationToken` as SHA-256. `getSession`/`querySessions`/`getActiveSessions`/`getImpersonationStats`/`getAuditSummary` return the full entity → responses include both token columns. No field projection / `@Exclude`.
**Rule violated** — Secret-in-response (layer-2 defect catalog); ADR-008.
**Proposed fix direction** — Exclude token columns from every read projection (`select` allowlist or `@Exclude()` + `ClassSerializerInterceptor`); never return `originalSessionToken`.
**Expected closer** — auth-security-expert / admin-expert.

#### DB-ADMIN-HIGH-003 — Tenant suspension metadata + lastActivityAt written to transient (non-persisted) fields

**Severity:** HIGH · **Layer:** 1 · **State:** OPEN
**Evidence** — `tenant/entities/tenant.entity.ts:132-140` declares `suspendedAt/suspendedReason/suspendedBy/lastActivityAt` as plain fields commented "NOT in the database" (no `@Column`). `tenant/handlers/suspend-tenant.handler.ts:85-88,102` assigns them then `save(Tenant)` — TypeORM drops unmapped props. `activate-tenant.handler.ts:205-208` sets `lastActivityAt` (dropped). `tenant/services/tenant-detail.service.ts:77-78,121` surfaces them into `TenantDetailDto` → always `undefined` on a fresh read.
**Rule violated** — Persistence correctness; WRITE-ONLY-to-nowhere.
**Proposed fix direction** — Add real columns on `auth.tenants` (blue-green) routed through auth-service (owner), or hydrate `suspendedAt/reason` from the latest `tenant_activities` row. Remove the transient-field illusion.
**Expected closer** — admin-expert + auth owner.

#### DB-ADMIN-HIGH-004 — admin-api dual-writes `auth.tenants` directly alongside the auth-service command (SSoT fork)

**Severity:** HIGH · **Layer:** 3 (ADR-011 ownership) · **State:** OPEN
**Evidence** — `tenant/handlers/suspend-tenant.handler.ts:76-102` calls `authProvisioningClient.suspendTenant(...)` (auth owns `auth.tenants`) AND `queryRunner.manager.save(Tenant, tenant)` where `Tenant` = `@Entity('tenants', { schema:'auth', synchronize:false })`. Same dual-write in activate/deactivate/archive handlers.
**Rule violated** — Partition invariant "admin mirrors are read models, not owners"; cross-service schema write.
**Proposed fix direction** — Make admin's `Tenant` strictly read-only; let auth-service own the mutation and project state back via `TenantStatusChanged` events. Remove the direct `save(Tenant)`.
**Expected closer** — admin-expert + auth-security-expert.

#### DB-ADMIN-HIGH-005 — Tenant list/getById/search omit FE-required `tier`, `farmCount`, `sensorCount`

**Severity:** HIGH · **Layer:** 2 · **State:** OPEN
**Evidence** — `tenant/query-handlers/tenant-query.handlers.ts:86-146,30-42,343-355` return raw `Tenant` entities (no hydrate, no DTO). `tenant/entities/tenant.entity.ts:146-191` — `tier`/`limits` are prototype getters (not serialized by `JSON.stringify`); `farm_count`/`sensor_count` columns dropped (`:86-88`), counts only computed in `/detail`. FE `services/types/tenant.ts:64-94` marks `tier`,`farmCount`,`sensorCount` **required**.
**Rule violated** — Contract drift; getter-not-serialized trap.
**Proposed fix direction** — Map list rows to the existing `TenantListItemDto` (`tenant-detail.dto.ts:164-178`) materializing `tier` + counts.
**Expected closer** — admin-expert WRITER mode.

### MEDIUM

#### DB-ADMIN-MEDIUM-001 — `GlobalConfig` is a dead, unregistered entity class

**Evidence** — `system-management/entities/global-config.entity.ts:58` `class GlobalConfig` has `@Column`/`@Index` but no `@Entity()`; `system-management.module.ts:34-50` `forFeature` omits it; `services/global-settings.service.ts:15,76-81` imports enums only, never injects its repo. No table/repo/read path.
**Fix** — Delete (config-service owns global config) or complete+register.

#### DB-ADMIN-MEDIUM-002 — 13 admin-schema tables absent from `MODULE_SCHEMAS['admin']`

**Evidence** — `schema-manager.service.ts:677-734`. Entities `schema:'admin'` in neither list: `discount_codes`, `module_pricing`, `plan_definitions`, `plan_module_assignments`, `threat_intelligence`, `retention_policies`, `retired_schema_backups`, `database_metrics`, `slow_query_logs`, `ingest_backend_policy_state`, `announcements`, `job_queues`, `system_versions`. Drift validator + orphan-drop presence checks do not cover them.
**Fix** — Add to registry (verify vs live dump); add an entity-table↔registry parity invariant for platform-level services.

#### DB-ADMIN-MEDIUM-003 — Impersonation per-action logging bypasses the durable audit ledger

**Evidence** — `impersonation.service.ts:826-889` `logAction`/`logResourceAccess` append only to session `actionsPerformed`/`accessedResources` jsonb; no `audit.audit_logs` write. Lifecycle events (START/END/TERMINATE/EXTEND/EXPIRE) DO write awaited audit rows (`:531,587,629,717,1063`).
**Fix** — Mirror each logged action into `audit_logs`, or document lifecycle rows as the audit SSoT.

#### DB-ADMIN-MEDIUM-004 — Security-domain FE↔entity field mismatches

**Evidence** — Entity `security.entity.ts:422 affectedUsersCount`,`:458 relatedSecurityEvents` vs FE `security.ts:248-249 affectedUsers`,`relatedEvents`; `security-monitoring.service.ts:806` writes the entity name. `ComplianceReport` entity has no `status`/`tenantId` column vs FE `security.ts:160,163`. `RetentionPolicyEntity` (`security.entity.ts:792-841`) has no `entityType`/`lastRunAt`/`nextRunAt` vs FE `security.ts:313-332` (UI-WITHOUT-DB). SUSPECT for incident/report pending controller-mapper confirmation.
**Fix** — Reconcile FE names to entity or add explicit mappers; drop or persist phantom retention fields.

#### DB-ADMIN-MEDIUM-005 — `tenant_billing_info` mirror is never written → `TenantDetail.billing` always undefined

**Evidence** — Only writer is `tenant/services/tenant-activity.service.ts:195-205 updateBillingInfo`, which has **zero callers** (grep). `tenant-detail.service.ts:373 getBillingSummary` reads it → always empty → FE `TenantDetail.billing` (`services/types/tenant.ts:157-166`) always undefined. Dead billing mirror (not a DUPLICATE-write since never written).
**Fix** — Either populate the mirror from a `billing.*` event projection, or read live from billing-service and drop the table.

#### DB-ADMIN-MEDIUM-006 — REST parity naming drifts (JobQueue, ReportDefinition, MessageThread, Onboarding, AuditLog)

**Evidence**

- FE `settings.ts:227-235 JobQueue.activeCount` vs entity `job-queue.entity.ts:256 runningCount`.
- FE `reports.ts:16-29 ReportDefinition.filters/isActive/columns/nextRunAt` vs entity `analytics-snapshot.entity.ts:226-274 defaultFilters/status/(none)/(none)`.
- FE `support.ts:139-155 MessageThread.unreadCountAdmin/unreadCountTenant/status/lastMessage/createdBy` vs entity `support.entity.ts:38-80 unreadAdminCount/unreadTenantCount/(isArchived+isClosed)/lastMessageId(uuid)/(none)`.
- FE `support.ts:208-220 TenantOnboarding.progress/assignedTo` vs entity `support.entity.ts:383-440 completionPercent/assignedGuide`.
- FE `audit.ts:5-19 AuditLog.metadata` + `severity:'low'|'medium'|'high'|'critical'` vs entity `audit/audit.entity.ts:122,131-136 details` + `AuditSeverity:'info'|'warning'|'critical'`. (`security.ts::BackendAuditLog` uses the correct `details`/severity — two divergent FE audit types.)
  **Fix** — Reconcile each FE type to the entity/DTO (or add mappers); the `[key:string]:unknown` index signatures on FE `AuditLog`/`User` mask this drift and should be removed.

#### DB-ADMIN-MEDIUM-007 — Parallel RBAC model: admin `shared.user_permissions` vs auth-service tenant RBAC

**Evidence** — `users/entities/user-permissions.entity.ts:97-125` stores a `PanelPermissions` boolean matrix (dashboard/farms/batches/…) keyed by userId+tenantId in `shared.user_permissions`, while auth-service owns the tenant RBAC SSoT (tenant_roles/tenant_role_permissions/user_role_assignments, per MEMORY "Tenant RBAC SSoT"/#884). Two overlapping authorization models. DUPLICATE-STRUCTURE.
**Fix** — Adjudicate the single RBAC owner (architectural-arbiter); if the panel matrix is a projection, derive it from auth permissions rather than a parallel writable store.

### LOW

Rolled into Appendix B.

## Cross-domain dependencies flagged

- DB-ADMIN-HIGH-002/-003/-004: recommend **auth-security-expert** (token exposure + auth.tenants ownership/persistence).
- DB-ADMIN-MEDIUM-007: recommend **architectural-arbiter** (RBAC ownership adjudication) + **multi-tenant-saas-expert**.
- DB-ADMIN-MEDIUM-005: recommend **billing-expert** (billing projection ownership).

## Verdict

BLOCK — 5 HIGH findings (impersonation contract + token leak, tenant persistence + ownership + list parity).

---

## Appendix A — Provenance matrix (per table)

Legend `| columns | writer | read | fe | class |`. OK rows batched; deep evidence in Findings.

### auth.tenants (`Tenant` read-replica, sync=false)

| columns                                                                                                                                                                                                       | writer                              | read               | fe                  | class                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------ | ------------------- | ------------------------------------- |
| id,name,slug,status,plan,maxUsers,maxStorage,userCount,trialEndsAt,subscriptionEndsAt,settings,logoUrl,contactEmail,contactPhone,address,taxId,customDomain,description,createdBy,createdAt,updatedAt,version | FE-FORM(admin, cross-schema) + auth | REST               | admin-panel/Tenants | OK-with-HIGH-004 (cross-schema write) |
| tier,limits (getters)                                                                                                                                                                                         | derived                             | REST(/detail only) | admin-panel         | HIGH-005                              |
| suspendedAt,suspendedReason,suspendedBy,lastActivityAt,domain,country,region,billingEmail,primaryContact,billingContact (transient)                                                                           | SYSTEM(assigned not persisted)      | REST(/detail)      | admin-panel         | WRITE-ONLY-to-nowhere (HIGH-003)      |

### auth.tenant_invitations (`TenantInvitation`, sync=false)

`id,tenantId,email,token,role,invitedBy,expiresAt,accepted,acceptedAt,createdAt` — writer auth · read BE-INTERNAL · fe NONE · **BE-ONLY** (no admin invitation controller found).

### admin.tenant_activities / tenant_notes — writer FE-FORM/SYSTEM · REST · admin-panel/TenantDetail · **OK**.

### admin.tenant_billing_info (`TenantBillingInfo`) — writer NONE-reachable (updateBillingInfo uncalled) · read REST(/detail) · admin-panel · **MEDIUM-005 dead mirror**.

### admin.impersonation_sessions / impersonation_permissions — writer FE-FORM+SYSTEM · REST · admin-panel/Impersonation · **DRIFT (HIGH-001)** + token leak (HIGH-002).

### admin.debug_sessions,captured_queries,captured_api_calls,cache_entries_snapshot,feature_flag_overrides — writer SYSTEM(debug tools) · REST · admin-panel/Debug · **SUSPECT** (FE `debug.ts` types read; entity bodies not opened — FE `DebugSession.adminId`/`sessionType` vs entity naming needs mapper check).

### admin.activity_logs,security_events,threat_intelligence,data_requests — writer SYSTEM/EVENT · REST · admin-panel/Security · **OK** (many entity fields BE-ONLY; good FE parity on surfaced subset).

### admin.security_incidents,compliance_reports,retention_policies — **DRIFT (MEDIUM-004)**.

### admin.login_attempts,api_usage_logs — writer EVENT/SYSTEM · BE-INTERNAL (brute-force/rate analytics) · fe NONE · **BE-ONLY (legit)**.

### admin.user_sessions — writer SYSTEM · read REST · admin-panel/Security sessions · **SUSPECT** (FE surface unconfirmed).

### admin.tenant_schemas,schema_migrations,schema_backups,retired_schema_backups,schema_restores,database_metrics,slow_query_logs — writer SYSTEM/`aqua-db-migrate` (runtime mutation disabled: `schema-management.service.ts:140-188`) · read REST · admin-panel/Database · **OK** (FE `database.ts` names differ → mapper-mediated; backup/restore audited; unregistered → MEDIUM-002).

### admin.ingest_backend_policy_state (`IngestBackendPolicyStateEntity`) — writer FE-FORM(admin) · read BE-INTERNAL(NATS snapshot) + audit_logs · fe NONE(admin panel) · **OK** (singleton, optimistic lock; unregistered → MEDIUM-002).

### admin.message_threads,messages — **DRIFT (MEDIUM-006 threads)**; messages OK.

### admin.announcements,announcement_acknowledgments — writer FE-FORM · REST · admin-panel/Support · **OK** (announcements unregistered → MEDIUM-002).

### admin.support_tickets,ticket_comments — writer FE-FORM · REST · admin-panel/Support · **OK** (good parity).

### admin.onboarding_progress — **DRIFT (MEDIUM-006)**.

### admin.background_jobs,job_execution_logs — writer SYSTEM · REST · admin-panel/Settings jobs · **OK**.

### admin.job_queues — writer SYSTEM · REST · admin-panel · **DRIFT (MEDIUM-006 activeCount)** + unregistered (MEDIUM-002).

### admin.performance_metrics,performance_snapshots,error_occurrences,error_groups,error_alert_rules — writer SYSTEM · REST · admin-panel/Settings perf+errors · **SUSPECT** (FE `settings.ts` ErrorGroup/PerformanceMetrics read; entity bodies not opened — likely OK/mapper).

### admin.feature_toggles — writer FE-FORM · REST · admin-panel/Settings · **OK** (good parity).

### admin.maintenance_modes — writer FE-FORM · REST · admin-panel/Settings · **SUSPECT** (FE `MaintenanceWindow` vs entity naming — mapper likely).

### admin.system_versions — writer FE-FORM · read REST · admin-panel · **SUSPECT** + unregistered (MEDIUM-002).

### admin.discount_codes,discount_redemptions — writer FE-FORM · REST · admin-panel/Billing · **OK** (good parity; discount_codes unregistered → MEDIUM-002).

### admin.module_pricing — writer FE-FORM · REST · admin-panel/Billing · **OK** (good parity; sync=false; unregistered → MEDIUM-002).

### admin.plan*definitions,plan_module_assignments,custom_plans — writer FE-FORM · REST · admin-panel/Billing · **SUSPECT/OK** (FE `billing.ts` PlanDefinition/CustomPlan read; entity bodies not opened; plan*\* unregistered → MEDIUM-002).

### admin.analytics_snapshots,report_definitions,report_executions — writer SYSTEM(cron) · REST · admin-panel/Analytics+Reports · **OK** (report_definitions DRIFT → MEDIUM-006).

### admin.audit_logs (`AuditLog`) — writer SYSTEM(all lifecycle) · REST · admin-panel/Audit+Security · **OK backend** (legalHold + DB trigger); FE `audit.ts` type DRIFT (MEDIUM-006).

### admin.admin_outbox (`AdminOutbox`, sync=false) — writer SYSTEM(outbox) · read BE-INTERNAL · fe NONE · **BE-ONLY (infra, registered)**.

### admin.tenant_erasure_operations (`TenantErasureOperation`, sync=false) — writer SYSTEM(GDPR erasure) · read REST(accepted-response) · admin-panel/Tenant erasure · **OK (infra, registered)**.

### shared.user_permissions (`UserPermissions`) — writer FE-FORM(tenant-admin) · read BE-INTERNAL/REST · fe tenant-admin(out of partition) · **DUPLICATE-STRUCTURE (MEDIUM-007)**.

### billing (external mirrors, sync=false): subscriptions,invoices,usage_aggregations,tenant_usage_metrics

Read-only projections for analytics/billing dashboards · writer NONE(admin) · read REST(SubscriptionOverview/InvoiceOverview/Usage\*) · admin-panel/Billing · **OK read-model** (authoritative in billing-service; matches admin invariant "mirrors are read models").

### auth (external mirrors, sync=false): tenants,users (analytics/external) — read-only projections · **OK read-model**.

### notification.notification_logs (`NotificationLog`)

`id,tenantId,channel(email|sms|push|webhook|in_app|system),recipient,subject,content,status,externalId,metadata,errorMessage,retryCount,nextRetryAt,sentAt,deliveredAt,createdAt` — writer SYSTEM(dispatcher) · read BE-INTERNAL/REST · fe NONE(admin)/AQUAMOBIL(in_app) · **OK** — dispatch record covers all channels; idempotency via `notification.command_receipts` (migration `1800200000000`). Satisfies the notification-idempotency invariant.

### notification.device_tokens (`DeviceToken`) — `id,userId,tenantId,token,platform,createdAt,lastSeenAt` — writer FE-FORM(register) · read BE-INTERNAL(push send) · fe AQUAMOBIL · **OK**.

### notification.notification_outbox (`NotificationOutbox`, sync=false) — writer SYSTEM · BE-INTERNAL · **BE-ONLY (infra, registered)**.

## Appendix B — Incidental findings

- **INC-1** `TenantConfiguration` (`settings/services/tenant-configuration.service.ts:125-347`) and
  `SystemSetting` (`settings/services/system-setting.service.ts:67-70`) are legacy adapters: writes
  throw `GoneException`, reads return hardcoded defaults (config-service owns real state). Admin-panel
  tenant-config + system-settings views render fabricated defaults, not durable state. Both classes are
  intentionally undecorated (no `@Entity()`), unlike the dead `GlobalConfig`.
- **INC-2** `GlobalConfig` dead class → DB-ADMIN-MEDIUM-001.
- **INC-3** 13 admin tables unregistered in MODULE_SCHEMAS → DB-ADMIN-MEDIUM-002.
- **INC-4** `GetTenantsApproachingLimitsHandler` unconditionally throws `NotImplementedException` (501)
  (`tenant/query-handlers/tenant-query.handlers.ts:299-305`) though the endpoint is live
  (`tenant.controller.ts:187-195`) — wired-but-dead admin endpoint.
- **INC-5** `TenantDetailService.getResourceUsage` hardcodes `storage.usedGb=0`/`percentage=0`
  (`tenant-detail.service.ts:337-341`) — the panel storage-usage bar is always empty (stub as data).
- **INC-6** Impersonation `originalSessionToken` stored plaintext (`impersonation.service.ts:503`)
  → DB-ADMIN-HIGH-002.
- **INC-7** Impersonation rate-limit falls back to an in-memory `Map` when Redis is absent
  (`impersonation.service.ts:85-109,178-194`) — multi-instance deployments bypass the 5/5min cap
  (contradicts layer-1 "rate limiters fail closed"). In-code acknowledged but unresolved.
- **INC-8** FE `impersonationApi.startSession` posts `{tenantId,adminId,impersonatedUserId,reason}`
  (`services/api/impersonation.ts:50-51`) but backend `StartImpersonationDto` requires `targetTenantId`
  - `reason` (enum) and forbids unknown fields (`impersonation.controller.ts:110-150`) → the panel's
    start-session call 400s (adminId is JWT-derived server-side).
- **INC-9** FE `impersonationApi` has `throw new Error('Not implemented')` stubs (`updatePermission`,
  `getSessionActions`, `services/api/impersonation.ts:36-38,61-63`) — FE ahead of backend.
- **INC-10** FE `audit.ts::AuditLog` and `users.ts::User` carry `[key: string]: unknown` index
  signatures (`services/types/audit.ts:18`, `users.ts:25`) that suppress all field-drift type errors —
  a type-erosion smell that hides MEDIUM-006-class mismatches from the compiler.
- **INC-11** `tenant.entity.ts` exposes a writable `tier` getter/setter aliasing `plan`
  (`:146-152`); combined with the getter-not-serialized trap (HIGH-005) this is a fragile compat shim.
- **INC-12** Admin `Tenant` compatibility fields require an explicit `hydrateCompatibilityFields()`
  call that only `/detail` performs — every other read path returns an unhydrated entity (domain/
  billingEmail/country/region silently absent). Design invites the HIGH-005 class of bug repo-wide.
