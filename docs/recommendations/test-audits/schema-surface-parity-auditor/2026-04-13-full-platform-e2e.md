# Recommendations: Schema Surface Parity Auditor `2026-04-13-full-platform-e2e`

## Priority 1: Wire messaging admin pages to real backend (CRITICAL-001, HIGH-002)

**Direction:** Create an admin-api gateway module (`apps/admin-api-service/src/messaging-admin/`) that proxies the messaging-service GraphQL resolvers for compliance, retention, monitoring, AI dashboard, audit, and tenant-enablement. Each of the 7 mock messaging admin pages should be converted from `useState(MOCK_*)` to `useQuery`/`useMutation` hooks backed by this gateway.

**Architectural approach:**
1. The admin-api-service already has modules for billing, tenant, user management. Add a `messaging-admin` module following the same pattern.
2. The messaging-service already exposes GraphQL resolvers for `ComplianceAuditLog`, `LegalHold`, `RetentionPolicy`. The admin gateway should call these resolvers via inter-service GraphQL or NATS request-reply.
3. Each frontend page needs a `useMessagingAdmin*` hook family replacing the `MOCK_*` + `useState` pattern.
4. The compliance page's "Compliance Score" widget must derive from real data (active hold count, retention policy coverage, audit log completeness), not a hardcoded `100`.

**Closes:** CRITICAL-001, HIGH-002

---

## Priority 2: Build admin CRUD surface for TenantAgentConfig (CRITICAL-002)

**Direction:** Replace `MessagingAiPersonasPage` with a real CRUD page bound to `TenantAgentConfig`. The page should:
1. Fetch all `TenantAgentConfig` records via admin-api gateway.
2. Surface ALL 16+ fields in an edit form, with clear section grouping: Profile, Tools, Safety Limits, Cost Control, MCP.
3. `actuationPolicy` and `autonomousSafetyLimits` must have prominent LIFE-SAFETY warnings in the UI.
4. `monthlyTokenBudget` and `hourlyRequestLimit` should have validation against minimum safe values.
5. Remove the hardcoded `DEFAULT_PERSONAS` array entirely.

**Closes:** CRITICAL-002

---

## Priority 3: Surface ScheduledPlanChange in subscription management (HIGH-004)

**Direction:** Add a "Scheduled Changes" tab or column to `SubscriptionManagementPage` that shows PENDING `ScheduledPlanChange` records with `effectiveDate`, `newPlanName`, `reason`. Add a "Cancel Scheduled Change" action. In `TenantBillingPage`, show a warning banner when a scheduled downgrade is pending for the current tenant.

**Closes:** HIGH-004

---

## Priority 4: Build tool-execution audit page or integrate into existing audit surface (HIGH-003)

**Direction:** Either (a) add a "Tool Executions" tab to `AuditLogPage` that queries `ToolExecutionAudit` with filters for `toolName`, `persona`, `success`, `conversationId`, or (b) create a dedicated `AiToolAuditPage` in the admin messaging section. The page must surface `input`, `output`, `errorMessage`, `durationMs`, and `correlationId`.

**Closes:** HIGH-003

---

## Priority 5: Surface GDPR data request lifecycle and consent audit trail (HIGH-005)

**Direction:** Enrich the `CompliancePage` data-request detail view to include `downloadUrl`, `downloadExpiresAt`, `recordsAffected`, `processingDetails`, and `errorMessage` from the `GdprDataRequest` entity. Add a "User Consents" tab showing `UserConsent` records with `consentType`, `version`, `granted`, `withdrawalReason`, `expiresAt`.

**Closes:** HIGH-005

---

## Priority 6: Build config-service product surface (HIGH-001)

**Direction:** Create an admin-panel page for `Configuration` CRUD and `ConfigurationHistory` viewer, consuming the existing `ConfigurationResolver` GraphQL API. Alternatively, migrate `SystemSettingsPage` to use the config-service as its backing store (single source of truth) and add a history viewer tab.

**Closes:** HIGH-001

---

## Priority 7: Complete feature toggle and maintenance mode edit forms (MEDIUM-003, MEDIUM-004)

**Direction:** Extend `FeatureToggleForm` to include `conditions`, `variants`, `rolloutSchedule`, `enabledTenants`, `disabledTenants`, `defaultValue`, `requiresRestart`, `deprecatedAt`, `deprecationMessage`. Extend `MaintenanceForm` to include `whitelistedIPs`, `whitelistedUsers`, `internalNotes`, `bannerColor`, `bannerIcon`, `affectedRegions`, `notifications`.

**Closes:** MEDIUM-003, MEDIUM-004

---

## Priority 8: Add notification delivery log surface (MEDIUM-002)

**Direction:** Add a "Notification Log" page to the admin panel showing delivery status, channel, retry count, and error messages from `NotificationLog`. This is essential for operators to verify that alert notifications are actually being delivered.

**Closes:** MEDIUM-002

---

## Priority 9: Surface TenantAiSetting + UserAiConsent in admin (MEDIUM-001)

**Direction:** Once the messaging admin pages are wired (Priority 1), ensure `MessagingTenantsPage` shows per-tenant `aiEnabled` status from `TenantAiSetting`, and `MessagingAiDashboardPage` shows consent metrics aggregated from `UserAiConsent`.

**Closes:** MEDIUM-001

---

## Priority 10: Consolidate regulatory settings surfaces (MEDIUM-005)

**Direction:** Either (a) merge the `CompanyPage` fields into the `ReportSettingsModal` (single surface), or (b) add cross-navigation links between the two surfaces with a shared "Regulatory Settings" breadcrumb. Both surfaces edit the same `RegulatorySettings` entity and should show a "Last updated" timestamp to prevent conflicting edits.

**Closes:** MEDIUM-005
