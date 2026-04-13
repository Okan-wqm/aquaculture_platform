# Schema Surface Parity Auditor: `2026-04-13-full-platform-e2e`

Scope checked: `web/**`, `apps/**`, `libs/**`, `database/**`

Prior cycle: `2026-04-11-full-platform-e2e` reported 2 HIGH + 1 MEDIUM. Commit `79ce984f` was cited as fixing 12 findings, but the three findings from the prior report remain open (see re-confirmed findings below). Per operating instructions, repeated findings in the same feature area are escalated by one severity level.

---

## Findings

### CRITICAL-001: Messaging compliance page is a complete mock facade over real compliance entities (ESCALATED from prior MEDIUM-003 area)

The entire `MessagingCompliancePage` renders legal holds, retention distribution, export jobs, audit operations chart, and compliance score from hardcoded `MOCK_*` constants. Every data path is a commented-out `// TODO: Replace with actual admin API calls` stub that unconditionally falls back to empty mock arrays. Meanwhile, the backend has three real, structurally complete compliance entities: `ComplianceAuditLog` (partitioned, immutable), `LegalHold` (with GDPR proportionality fields like `legalMatterId`, `expiresAt`), and `RetentionPolicy`. None of these entities are read or written by this page.

This is a CRITICAL gap because the page presents a "Compliance Score: 100%" widget and an "Active Holds: 0" counter to operators. If a real legal hold were placed via the backend (e.g., by another system or future API), the admin UI would still show zero holds and 100% compliance, creating a regulatory false-assurance surface.

Root cause: The messaging compliance admin pages were scaffolded as mock-first UI with no backend wiring. The backend entities matured (partition keys, immutability triggers, GDPR fields) but the frontend was never connected.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingCompliancePage.tsx:65-86` -- `MOCK_STATS`, `MOCK_LEGAL_HOLDS`, `MOCK_EXPORTS`, `MOCK_RETENTION_BUCKETS`, `MOCK_DAILY_AUDIT` all hardcoded
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingCompliancePage.tsx:237-255` -- `fetchData()` unconditionally sets mock values
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/compliance-audit-log.entity.ts:73-124` -- real partitioned entity with `ComplianceAction` enum
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/legal-hold.entity.ts:25-96` -- real entity with `legalMatterId`, `expiresAt`, `requestedBy`
- `/var/aqua-saas/apps/messaging-service/src/compliance/entities/retention-policy.entity.ts:26-59` -- real entity

Cross-domain dependency:
- `form-write-auditor`
- `data-readback-auditor`
- `access-boundary-auditor`

---

### CRITICAL-002: AI persona admin page is a static mock -- durable `TenantAgentConfig` fields remain invisible and uneditable (ESCALATED from prior HIGH-001)

This finding was reported as HIGH-001 in the prior cycle. It remains completely unfixed. The `MessagingAiPersonasPage` renders a hardcoded `DEFAULT_PERSONAS` array (line 39-85) and flips `enabledForAll` in local React state only (line 189-196). The toggle handler has `// TODO: Persist toggle via admin API mutation`. None of the 16+ durable fields on `TenantAgentConfig` (`baseProfileId`, `additionalToolNames`, `blockedToolNames`, `actuationPolicy`, `customSystemPrompt`, `applicableRoles`, `autonomousActionsEnabled`, `autonomousSafetyLimits`, `monthlyTokenBudget`, `hourlyRequestLimit`, `mcpEnabled`, `mcpAllowedPersonas`, `proactiveMonitoringEnabled`, `isEnabled`) are readable or writable from the product surface.

Escalated to CRITICAL because:
1. This was already reported as HIGH in the prior cycle and remains unfixed.
2. `actuationPolicy` and `autonomousSafetyLimits` are LIFE-SAFETY fields controlling whether AI can autonomously actuate PLC equipment (dosing, temperature). Having no admin surface for these means they can only be changed via direct DB manipulation.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx:39-85` -- hardcoded `DEFAULT_PERSONAS`
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiPersonasPage.tsx:189-196` -- local-only toggle, no API call
- `/var/aqua-saas/apps/ai-service/src/tenant-config/agent-config.entity.ts:13-76` -- 16+ durable fields with no product surface

Cross-domain dependency:
- `form-write-auditor`
- `contract-parity-auditor`
- `access-boundary-auditor`

---

### HIGH-001: Config-service `Configuration` + `ConfigurationHistory` have no product-facing CRUD or history viewer (prior HIGH-002 re-confirmed)

This was HIGH-002 in the prior cycle. It remains unfixed. `ConfigurationResolver` exposes a full GraphQL CRUD and history API over `Configuration` (57+ fields including `validationRules`, `tags`, `category`, `isSecret`, `environment`, `version`) and `ConfigurationHistory` (with `previousValue`, `newValue`, `changedBy`, `changeReason`). The admin panel has no page consuming this resolver. The only admin settings surface is `SystemSettingsPage`, which uses a completely separate REST-backed `settingsApi` (`/settings/config/email`, `/settings/config/security`, etc.).

Root cause: Two disconnected configuration models exist in the platform. The config-service GraphQL resolver and its history read model have zero product-facing entry points.

Evidence:
- `/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts:57-171` -- rich entity with `ConfigValueType`, `ConfigEnvironment`, `validationRules`, `tags`
- `/var/aqua-saas/apps/config-service/src/configuration/entities/configuration.entity.ts:177-222` -- `ConfigurationHistory` audit entity
- `/var/aqua-saas/web/modules/admin-panel/src/pages/SystemSettingsPage.tsx:1-100` -- uses REST `settingsApi`, not config-service GraphQL

Cross-domain dependency:
- `data-readback-auditor`
- `contract-parity-auditor`
- `form-write-auditor`

---

### HIGH-002: All six messaging admin sub-pages are mock facades with no backend wiring

Beyond `MessagingCompliancePage` (CRITICAL-001), five additional messaging admin pages all follow the identical mock-data pattern: hardcoded `MOCK_*` constants, `useState(MOCK_*)` initialization, and commented-out API calls with `// TODO: Replace with actual admin API calls`.

Affected pages:
1. **MessagingRetentionPage** -- renders per-tenant retention policies, channel overrides, and cleanup history from `MOCK_TENANTS = []` and `MOCK_CLEANUP_HISTORY = []`. Edit and override modals write to local state only.
2. **MessagingMonitoringPage** -- renders messaging stats, per-tenant breakdown, WebSocket connections, outbox health, and hourly chart from `MOCK_STATS`, `MOCK_TENANT_STATS`, `MOCK_OUTBOX`, `MOCK_ALERTS`, `MOCK_HOURLY`.
3. **MessagingAiDashboardPage** -- renders sentiment overview, knowledge entries, embedding status, model info, and AI channel usage from `MOCK_SENTIMENTS`, `MOCK_KNOWLEDGE`, `MOCK_EMBEDDING`, `MOCK_MODEL`, `MOCK_USAGE`.
4. **MessagingAuditPage** -- renders messaging-domain audit entries from `MOCK_ENTRIES = []`.
5. **MessagingTenantsPage** -- renders per-tenant messaging enablement and stats from `MOCK_TENANTS = []`. Enable/disable toggles are local-only.

Root cause: The entire messaging admin section was scaffolded as mock-first UI. The backend services (messaging-service, ai-service) have real entities and resolvers for all of these domains, but no admin API gateway or admin-panel API client connects them.

Evidence:
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingRetentionPage.tsx:75-79` -- mock constants
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingMonitoringPage.tsx:53-68` -- mock constants
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAiDashboardPage.tsx:54-73` -- mock constants
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAuditPage.tsx:70-73` -- mock constants
- `/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx:39-42` -- mock constants

Cross-domain dependency:
- `form-write-auditor`
- `data-readback-auditor`

---

### HIGH-003: AI tool execution audit entity has no product surface (prior MEDIUM-003, escalated)

`ToolExecutionAudit` stores tenant, user, tool name, persona, input/output, success, error, duration, correlation ID, and conversation ID. `AuditService.getRecentExecutions()` can fetch them by tenant. The admin audit page (`AuditLogPage`) filters by generic action/severity/entityType and has no concept of tool executions, personas, or conversations. There is no dedicated tool-execution audit page anywhere in the web tier.

Escalated from MEDIUM to HIGH because this was reported in the prior cycle and remains unfixed.

Evidence:
- `/var/aqua-saas/apps/ai-service/src/audit/tool-execution-audit.entity.ts:9-51` -- 11 meaningful columns
- `/var/aqua-saas/web/modules/admin-panel/src/pages/AuditLogPage.tsx:20-67` -- filter options have no tool/persona/conversation concept

Cross-domain dependency:
- `data-readback-auditor`

---

### HIGH-004: `ScheduledPlanChange` entity has no admin or tenant-facing visibility

`ScheduledPlanChange` stores deferred subscription modifications with `currentPlanId`, `newPlanId`, `effectiveDate`, `status` (PENDING/APPLIED/CANCELLED), `reason`, `cancellationReason`. This entity exists in `billing-service` but no web page in the admin panel or tenant-admin module shows pending schedule changes. The `SubscriptionManagementPage` shows current subscriptions but has no "Scheduled Changes" column, tab, or detail. The `TenantBillingPage` similarly has no visibility into pending downgrades.

Root cause: The billing cron job applies scheduled changes silently. Operators and tenant admins cannot see, cancel, or verify pending plan changes through the product.

Evidence:
- `/var/aqua-saas/apps/billing-service/src/billing/entities/scheduled-plan-change.entity.ts:35-120` -- full entity with lifecycle fields
- `/var/aqua-saas/web/modules/admin-panel/src/pages/SubscriptionManagementPage.tsx` -- no reference to scheduled changes
- Grep for `ScheduledPlanChange` in `web/**` returns zero matches

Cross-domain dependency:
- `data-readback-auditor`
- `form-write-auditor`

---

### HIGH-005: `GdprDataRequest` entity has no dedicated product surface for request lifecycle management

`GdprDataRequest` stores user requests for data export, deletion, rectification, restriction, and portability with full lifecycle tracking (`status`, `processedAt`, `processedBy`, `recordsAffected`, `downloadUrl`, `downloadExpiresAt`, `errorMessage`). The `CompliancePage` in the admin security section fetches data requests via `securityApi`, but its `DataRequest` interface re-declares the type locally and the backend uses a separate `GdprDataRequest` entity in `libs/backend-common`. This means the admin page may surface requests, but the `GdprDataRequest` entity's `downloadUrl`, `downloadExpiresAt`, `recordsAffected`, `processingDetails`, and `errorMessage` fields have no guaranteed surface in the admin UI detail view.

Additionally, `UserConsent` (`user_consents` table) stores consent records with `version`, `ipAddress`, `expiresAt`, `withdrawalReason`, and `metadata`, but no admin page provides a consent-record browser (the `CompliancePage` shows compliance reports and data requests, not a per-user consent audit trail).

Evidence:
- `/var/aqua-saas/libs/backend-common/src/security/gdpr/entities/data-request.entity.ts:38-121` -- full entity
- `/var/aqua-saas/libs/backend-common/src/security/gdpr/entities/consent.entity.ts:17-67` -- consent entity with `withdrawalReason`, `metadata`
- `/var/aqua-saas/web/modules/admin-panel/src/pages/security/CompliancePage.tsx:40-66` -- local `DataRequest` type does not include `downloadUrl`, `recordsAffected`, etc.

Cross-domain dependency:
- `data-readback-auditor`
- `access-boundary-auditor`

---

### MEDIUM-001: `TenantAiSetting` and `UserAiConsent` messaging entities have no admin surface

`TenantAiSetting` (per-tenant AI feature toggle: `aiEnabled`) and `UserAiConsent` (per-user GDPR-compliant AI consent: `consented`, `consentedAt`) exist in `messaging-service` but have no admin-panel page. The `MessagingTenantsPage` (which is mock-only per HIGH-002) does not show `aiEnabled` status. The `MessagingAiDashboardPage` (also mock-only) does not show consent metrics. There is no admin-visible path to see which tenants have AI enabled or which users have consented.

Evidence:
- `/var/aqua-saas/apps/messaging-service/src/ai/entities/tenant-ai-setting.entity.ts:14-29`
- `/var/aqua-saas/apps/messaging-service/src/ai/entities/user-ai-consent.entity.ts:14-32`
- Grep for `TenantAiSetting` or `UserAiConsent` in `web/**/*.tsx` returns zero matches

Cross-domain dependency:
- `data-readback-auditor`
- `access-boundary-auditor`

---

### MEDIUM-002: `NotificationLog` entity has no admin or operator surface

`NotificationLog` stores every sent notification (email, SMS, push, webhook, in-app, system) with `status`, `channel`, `errorMessage`, `retryCount`, `nextRetryAt`, `deliveredAt`. There is no admin-panel page for notification delivery history, failure inspection, or retry management. Operators cannot see whether critical alert notifications were actually delivered or are stuck in retry/dead-letter state.

Evidence:
- `/var/aqua-saas/apps/notification-service/src/notification/entities/notification-log.entity.ts:37-92` -- full entity
- Grep for `notification.*log` or `notification.*history` in `web/modules/admin-panel` returns zero matches

Cross-domain dependency:
- `data-readback-auditor`

---

### MEDIUM-003: `FeatureToggle` entity fields `conditions`, `variants`, `rolloutSchedule`, `enabledTenants`, `disabledTenants`, `defaultValue`, `requiresRestart`, `deprecatedAt`, `deprecationMessage` are not editable in the UI

The `FeatureTogglesPage` has real API integration (good) but the create/edit form only exposes `key`, `name`, `description`, `scope`, `category`, `rolloutPercentage`, and `isExperimental`. The entity has 9 additional fields (`conditions` array with typed operators, `variants` with weights, `rolloutSchedule` with start/end/increment, `enabledTenants`, `disabledTenants`, `defaultValue`, `requiresRestart`, `deprecatedAt`, `deprecationMessage`) that are stored but cannot be created or edited through the product. This makes the UI a partial view of the feature-toggle model, and any toggle using these advanced fields can only be managed via direct database access.

Evidence:
- `/var/aqua-saas/apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts:38-116` -- entity has `conditions`, `variants`, `rolloutSchedule`, `enabledTenants`, `disabledTenants`, `defaultValue`, `requiresRestart`, `deprecatedAt`, `deprecationMessage`
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx:17-35` -- `FeatureToggleForm` only has `key`, `name`, `description`, `scope`, `category`, `rolloutPercentage`, `isExperimental`

Cross-domain dependency:
- `form-write-auditor`

---

### MEDIUM-004: `MaintenanceMode` entity fields `whitelistedIPs`, `whitelistedUsers`, `internalNotes`, `bannerColor`, `bannerIcon`, `affectedRegions`, `notifications`, `metadata` are not exposed in the create/edit form

The `MaintenancePage` has real API integration but the form only exposes `title`, `description`, `scope`, `type`, `scheduledStart`, `estimatedDurationMinutes`, `userMessage`, `allowReadOnlyAccess`, `bypassForSuperAdmins`. The entity has 8 additional fields that cannot be set through the product surface.

Evidence:
- `/var/aqua-saas/apps/admin-api-service/src/system-management/entities/maintenance-mode.entity.ts:46-137` -- entity with `whitelistedIPs`, `whitelistedUsers`, `internalNotes`, `bannerColor`, `bannerIcon`, `affectedRegions`, `notifications`, `metadata`
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/MaintenancePage.tsx:38-60` -- `MaintenanceForm` omits 8 fields

Cross-domain dependency:
- `form-write-auditor`

---

### MEDIUM-005: `CompanyPage` only surfaces 3 of 10+ `RegulatorySettings` fields; remaining fields require report-settings modal

The `CompanyPage` reads and writes only `companyName`, `organisationNumber`, and `companyAddress` from `RegulatorySettings`. The remaining 7+ fields (`maskinportenClientId`, `maskinportenPrivateKeyEncrypted`, `maskinportenKeyId`, `maskinportenEnvironment`, `defaultContactName`, `defaultContactEmail`, `defaultContactPhone`, `siteLocalityMappings`, `slaughterApprovalNumber`) are surfaced in a separate `ReportSettingsModal` inside the Reports page. This split means operators must navigate to Reports > Settings to manage regulatory credentials and contacts, while company identity is on a separate top-level page. The two surfaces edit the same underlying entity without cross-referencing each other, creating a risk of confusing roundtrip edits where an operator editing company info may not realize Maskinporten credentials exist on a different page.

Evidence:
- `/var/aqua-saas/web/modules/farm-module/src/pages/company/CompanyPage.tsx:12-37` -- queries only `companyName`, `organisationNumber`, `companyAddress`
- `/var/aqua-saas/web/modules/farm-module/src/pages/reports/components/ReportSettingsModal.tsx:15-35` -- queries `maskinportenConfigured`, `defaultContactName`, `siteLocalityMappings`, `slaughterApprovalNumber`
- `/var/aqua-saas/apps/farm-service/src/regulatory/entities/regulatory-settings.entity.ts:43-136` -- single entity with all fields

Cross-domain dependency:
- `form-write-auditor`

---

### LOW-001: `ImpersonationPermission` entity field `requireTicketReference` has no UI enforcement

The `ImpersonationPermission` entity has `requireTicketReference` (boolean) and the `ImpersonationSession` entity has `ticketReference` (text). The `ImpersonationPage` has a start-session form, but the ticket reference field's mandatory status is not derived from the `ImpersonationPermission.requireTicketReference` setting. If `requireTicketReference` is set to `true` via direct DB access, the UI may still allow session creation without a ticket reference.

Evidence:
- `/var/aqua-saas/apps/admin-api-service/src/impersonation/entities/impersonation-session.entity.ts:148-207` -- `ImpersonationPermission` with `requireTicketReference`
- `/var/aqua-saas/web/modules/admin-panel/src/pages/system/ImpersonationPage.tsx:48-80` -- page loads but form validation not tied to permission settings

Cross-domain dependency:
- `form-write-auditor`

---

## Gap Taxonomy Summary

| ID | Severity | Direction | Gap Type |
|---|---|---|---|
| CRITICAL-001 | CRITICAL | UI-without-DB | Complete mock facade over real compliance entities |
| CRITICAL-002 | CRITICAL | DB-without-UI | 16+ AI agent config fields have no product surface |
| HIGH-001 | HIGH | DB-without-UI | Config-service model + history orphaned from product |
| HIGH-002 | HIGH | UI-without-DB | 6 messaging admin pages are mock facades |
| HIGH-003 | HIGH | DB-without-UI | Tool execution audit entity has no product surface |
| HIGH-004 | HIGH | DB-without-UI | Scheduled plan change entity invisible to operators |
| HIGH-005 | HIGH | DB-without-UI | GDPR data request lifecycle + consent records partially orphaned |
| MEDIUM-001 | MEDIUM | DB-without-UI | AI settings + consent entities have no admin surface |
| MEDIUM-002 | MEDIUM | DB-without-UI | Notification delivery log invisible to operators |
| MEDIUM-003 | MEDIUM | Partial parity | Feature toggle advanced fields not in edit form |
| MEDIUM-004 | MEDIUM | Partial parity | Maintenance mode advanced fields not in create/edit form |
| MEDIUM-005 | MEDIUM | Partial parity | Regulatory settings split across two disconnected surfaces |
| LOW-001 | LOW | Partial parity | Impersonation permission enforcement gap |

---

## Result

Confirmed: **2 CRITICAL**, **5 HIGH**, **5 MEDIUM**, **1 LOW** schema-surface parity gaps.

The three findings from the prior cycle (2026-04-11) remain entirely open and have been escalated per operating instructions. The largest systemic gap is the entire messaging admin section (7 pages), which is a pure mock facade with no backend wiring despite the messaging-service having mature, production-grade entities with GDPR-compliant partitioning and immutability triggers. The second critical gap is AI agent configuration fields controlling autonomous equipment actuation having no product surface at all.
