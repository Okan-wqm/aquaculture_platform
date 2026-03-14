# P2: Backend Haritaci Raporu

## Yonetici Ozeti

Admin API Service, NestJS tabanli 16 modulu, 33 controller'i, 60+ service'i ve 31 entity'si olan kapsamli bir platform yonetim backend'idir. Yetkilendirme JWT tabanli `PlatformAdminGuard` ile global APP_GUARD olarak uygulanmakta, varsayilan olarak SUPER_ADMIN/PLATFORM_ADMIN rolleri gerekmektedir. CQRS patterni **yalnizca tenant modulu** tarafindan kullanilmakta (CommandBus+QueryBus), diger tum moduller klasik service pattern kullanmaktadir. ThrottlerGuard global olarak **kaldirilmistir** (comment'te 429 flood sorunu belirtiliyor); yalnizca password-reset endpoint'lerinde per-route throttle bulunmaktadir.

## Controller Haritasi

### 1. TenantController
- **Dosya:** `src/tenant/tenant.controller.ts`
- **Prefix:** `tenants`
- **Guard:** Global PlatformAdminGuard (controller-level yok)
- **Identity:** `@CurrentUser() user: AdminUser` (JWT'den req.user)
- **CQRS:** Evet (CommandBus + QueryBus)

| Method | Path | Guard/Decorator |
|--------|------|-----------------|
| POST | /tenants | Global |
| GET | /tenants | Global |
| GET | /tenants/stats | Global |
| GET | /tenants/search | Global |
| GET | /tenants/approaching-limits | Global |
| GET | /tenants/expiring-trials | Global |
| GET | /tenants/slug/:slug | Global |
| POST | /tenants/bulk/suspend | Global |
| POST | /tenants/bulk/activate | Global |
| GET | /tenants/:id | Global |
| GET | /tenants/:id/detail | Global |
| GET | /tenants/:id/usage | Global |
| GET | /tenants/:id/activities | Global |
| GET | /tenants/:id/notes | Global |
| POST | /tenants/:id/notes | Global |
| PATCH | /tenants/:id/notes/:noteId | Global |
| DELETE | /tenants/:id/notes/:noteId | Global |
| PUT | /tenants/:id | Global |
| PATCH | /tenants/:id/suspend | Global |
| PATCH | /tenants/:id/activate | Global |
| PATCH | /tenants/:id/deactivate | Global |
| POST | /tenants/:id/provision | Global |
| GET | /tenants/:id/provision/status | Global |
| DELETE | /tenants/:id | Global |

### 2. UsersController
- **Dosya:** `src/users/users.controller.ts`
- **Prefix:** `users`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** `@Req() req.user` (JWT) veya `@CurrentUser()` yok -- cogu endpoint identity kullanmiyor

| Method | Path | Guard/Decorator |
|--------|------|-----------------|
| GET | /users | Controller guard |
| GET | /users/stats | Controller guard |
| GET | /users/by-tenant/:tenantId | Controller guard |
| GET | /users/recent-activity | Controller guard |
| GET | /users/:id | Controller guard |
| GET | /users/:id/activity | Controller guard |
| GET | /users/:id/sessions | Controller guard |
| POST | /users | Controller guard |
| PUT | /users/:id | Controller guard |
| PATCH | /users/:id/activate | Controller guard |
| PATCH | /users/:id/deactivate | Controller guard |
| PATCH | /users/:id/reset-password | Controller guard |
| PATCH | /users/:id/force-logout | Controller guard |
| DELETE | /users/:id | Controller guard |
| GET | /users/tenant/:tenantId/limit | Controller guard |
| POST | /users/invite | Controller guard, identity: `req.user.id` |
| GET | /users/roles/templates | Controller guard |
| GET | /users/roles/assignable/:roleCode | Controller guard |
| GET | /users/roles/permissions | Controller guard |
| GET | /users/roles/permissions/grouped | Controller guard |
| GET | /users/roles/hierarchy | Controller guard |
| GET | /users/roles/can-assign | Controller guard |
| GET | /users/roles/:roleCode/permissions | Controller guard |
| POST | /users/tenant/invite | `@AllowTenantAdmin()`, identity: `req.user` |
| GET | /users/permission-categories | `@AllowTenantAdmin()` |
| GET | /users/:id/permissions | `@AllowTenantAdmin()`, identity: `req.user.tenantId` |
| PUT | /users/:id/permissions | `@AllowTenantAdmin()`, identity: `req.user` |
| GET | /users/tenant/users-with-permissions | `@AllowTenantAdmin()`, identity: `req.user.tenantId` |

### 3. BillingController
- **Dosya:** `src/billing/billing.controller.ts`
- **Prefix:** `billing`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Bircok endpoint identity kullanmiyor; `updatedBy`, `createdBy`, `cancelledBy` gibi alanlar **@Body()** ile client-supplied

| Method | Path | Guard/Decorator |
|--------|------|-----------------|
| GET | /billing/plans | Controller guard |
| GET | /billing/plans/public | Controller guard |
| GET | /billing/plans/:id | Controller guard |
| GET | /billing/plans/code/:code | Controller guard |
| GET | /billing/plans/tier/:tier | Controller guard |
| POST | /billing/plans | Controller guard |
| PUT | /billing/plans/:id | Controller guard |
| POST | /billing/plans/:id/deprecate | Controller guard, `updatedBy` client-supplied |
| POST | /billing/plans/compare | Controller guard |
| GET | /billing/plans/defaults/:tier | Controller guard |
| POST | /billing/plans/seed | Controller guard, `createdBy` client-supplied |
| GET | /billing/discounts | Controller guard |
| GET | /billing/discounts/stats | Controller guard |
| GET | /billing/discounts/:id | Controller guard |
| GET | /billing/discounts/code/:code | Controller guard |
| POST | /billing/discounts | Controller guard |
| PUT | /billing/discounts/:id | Controller guard |
| POST | /billing/discounts/:id/deactivate | Controller guard, `updatedBy` client-supplied |
| POST | /billing/discounts/validate | Controller guard |
| POST | /billing/discounts/apply | Controller guard, `redeemedBy` client-supplied |
| GET | /billing/discounts/:id/redemptions | Controller guard |
| POST | /billing/discounts/generate-code | Controller guard |
| POST | /billing/discounts/bulk-create | Controller guard |
| POST | /billing/subscriptions | Controller guard |
| GET | /billing/subscriptions | Controller guard |
| GET | /billing/subscriptions/stats | Controller guard |
| GET | /billing/subscriptions/reminders | Controller guard |
| GET | /billing/subscriptions/tenant/:tenantId | Controller guard |
| POST | /billing/subscriptions/change-plan | Controller guard |
| POST | /billing/subscriptions/tenant/:tenantId/cancel | Controller guard, `cancelledBy` client-supplied |
| POST | /billing/subscriptions/tenant/:tenantId/reactivate | Controller guard, `reactivatedBy` client-supplied |
| POST | /billing/subscriptions/tenant/:tenantId/extend-trial | Controller guard, `extendedBy` client-supplied |
| POST | /billing/subscriptions/process-renewals | Controller guard |
| GET | /billing/tenant/:tenantId/redemptions | Controller guard |
| GET | /billing/module-pricing (+ 7 sub-endpoints) | Controller guard |
| POST | /billing/pricing/calculate (+ 2) | Controller guard |
| GET | /billing/custom-plans (+ 9 sub-endpoints) | Controller guard, `approverId`/`rejectedBy` client-supplied |
| GET | /billing/invoices (+ 7 sub-endpoints) | Controller guard, `markedBy`/`voidedBy` client-supplied |

### 4. AnalyticsController
- **Dosya:** `src/analytics/controllers/analytics.controller.ts`
- **Prefix:** `analytics`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Kullanilmiyor

| Method | Path | Endpoints |
|--------|------|-----------|
| GET | /analytics/dashboard, /kpi-comparisons | 2 |
| GET | /analytics/tenants, /tenants/growth, /tenants/churn | 3 |
| GET | /analytics/users, /users/activity, /users/heatmap | 3 |
| GET | /analytics/financial, /financial/revenue, /financial/by-plan | 3 |
| GET | /analytics/revenue, /revenue/by-plan, /revenue/trend | 3 |
| GET | /analytics/system, /system/api-calls, /system/errors | 3 |
| GET | /analytics/usage, /usage/modules, /usage/features | 3 |
| GET | /analytics/snapshots | 1 |

### 5. ReportsController
- **Dosya:** `src/analytics/controllers/reports.controller.ts`
- **Prefix:** `reports`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Kullanilmiyor

Toplam 19 endpoint (definitions CRUD, executions, quick reports, generate, download, export)

### 6. HealthController
- **Dosya:** `src/health/health.controller.ts`
- **Prefix:** `health`
- **Guard:** `@SkipThrottle()` (class-level)
- **Identity:** Kullanilmiyor

| Method | Path | Guard/Decorator |
|--------|------|-----------------|
| GET | /health | `@Public()` - guard bypass |
| GET | /health/live | `@Public()` |
| GET | /health/ready | `@Public()` |
| GET | /health/startup | `@Public()` |
| GET | /health/metrics | Global (auth required) |
| GET | /health/circuit-breakers | Global (auth required) |
| POST | /health/circuit-breakers/:name/reset | Global (auth required) |

### 7. PasswordResetController
- **Dosya:** `src/auth/password-reset.controller.ts`
- **Prefix:** `auth`
- **Guard:** Her iki endpoint `@Public()` ile bypass
- **Throttle:** `@ThrottlePasswordReset()` per-route
- **Identity:** Kullanilmiyor (token-based)

| Method | Path | Guard/Decorator |
|--------|------|-----------------|
| POST | /auth/forgot-password | `@Public()`, `@ThrottlePasswordReset()` |
| POST | /auth/reset-password | `@Public()`, `@ThrottlePasswordReset()` |

### 8. SettingsController
- **Dosya:** `src/settings/settings.controller.ts`
- **Prefix:** `settings`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** `updatedBy` client-supplied via @Body()

25 endpoint (settings CRUD, config/email, config/security, config/rate-limits, config/maintenance, config/billing, features, import/export, system/info)

### 9. ModulesController
- **Dosya:** `src/modules/modules.controller.ts`
- **Prefix:** `modules`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Kullanilmiyor

13 endpoint (modules CRUD, assignments, tenants)

### 10. SystemMetricsController
- **Dosya:** `src/metrics/system-metrics.controller.ts`
- **Prefix:** `system`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Kullanilmiyor

6 endpoint (metrics, database, platform, resources, services/health, trends)

### 11. AuditLogController
- **Dosya:** `src/audit/audit.controller.ts`
- **Prefix:** `audit-logs`
- **Guard:** `@UseGuards(PlatformAdminGuard)` (controller-level)
- **Identity:** Kullanilmiyor

5 endpoint (query, entity/:entityType/:entityId, user/:userId, security, statistics)

### 12. Database Management Controllers (5 controller)

**MonitoringController** (`src/database-management/controllers/monitoring.controller.ts`)
- Prefix: `database/monitoring`, Guard: `@UseGuards(PlatformAdminGuard)`, 10 endpoint

**BackupController** (`src/database-management/controllers/backup.controller.ts`)
- Prefix: `database/backups`, Guard: `@UseGuards(PlatformAdminGuard)`, 11 endpoint

**MigrationController** (`src/database-management/controllers/migration.controller.ts`)
- Prefix: `database/migrations`, Guard: `@UseGuards(PlatformAdminGuard)`, 8 endpoint

**SchemaController** (`src/database-management/controllers/schema.controller.ts`)
- Prefix: `database/schemas`, Guard: `@UseGuards(PlatformAdminGuard)`, 12 endpoint

**DatabaseExplorerController** (`src/database-management/controllers/explorer.controller.ts`)
- Prefix: `database/explorer`, Guard: `@UseGuards(PlatformAdminGuard)`, 13 endpoint
- **KRITIK:** Raw SQL endpoint (`POST /database/explorer/query`) -- production'da bloke ediliyor
- CRUD (INSERT/UPDATE/DELETE) islemleri acik

### 13. Impersonation Controllers (2 controller)

**ImpersonationController** (`src/impersonation/controllers/impersonation.controller.ts`)
- Prefix: `impersonation`, Guard: `@UseGuards(PlatformAdminGuard)`, 16 endpoint
- **Identity:** `req.user` JWT'den (SECURITY FIX uygulanmis)

**DebugToolsController** (`src/impersonation/controllers/debug-tools.controller.ts`)
- Prefix: `debug`, **Guard: YOK (global APP_GUARD devrede)**
- **Identity:** `@Query('adminId')` **CLIENT-SUPPLIED** -- guvenlik riski
- 30+ endpoint (sessions, queries, api-calls, cache, feature-overrides)

### 14. Security Controllers (4 controller)

**AuditTrailController** (`src/security/controllers/audit-trail.controller.ts`)
- Prefix: `security/audit`, **Guard: YOK (global APP_GUARD devrede)**, 13 endpoint
- Identity: `createdBy: 'admin'` hardcoded

**ActivityLogController** (`src/security/controllers/activity-log.controller.ts`)
- Prefix: `security/activities`, **Guard: YOK (global APP_GUARD devrede)**, 8 endpoint

**SecurityMonitoringController** (`src/security/controllers/security-monitoring.controller.ts`)
- Prefix: `security/monitoring`, **Guard: YOK (global APP_GUARD devrede)**, 17 endpoint
- Identity: `'admin'` hardcoded (updateIncident)

**ComplianceController** (`src/security/controllers/compliance.controller.ts`)
- Prefix: `security/compliance`, **Guard: YOK (global APP_GUARD devrede)**, 13 endpoint
- Identity: `'admin'` hardcoded, `generatedBy` client-supplied

### 15. Settings Sub-Controllers (3 controller)

**IpAccessController** (`src/settings/controllers/ip-access.controller.ts`)
- Prefix: `settings/ip-access`, **Guard: YOK (global APP_GUARD devrede)**, 11 endpoint
- Identity: `createdBy` client-supplied

**EmailTemplateController** (`src/settings/controllers/email-template.controller.ts`)
- Prefix: `settings/email-templates`, **Guard: YOK (global APP_GUARD devrede)**, 12 endpoint

**TenantConfigurationController** (`src/settings/controllers/tenant-configuration.controller.ts`)
- Prefix: `settings/tenant`, **Guard: YOK (global APP_GUARD devrede)**, 30+ endpoint
- Identity: `updatedBy` client-supplied via @Query()

### 16. Support Controllers (4 controller)

**TicketController** (`src/support/controllers/ticket.controller.ts`)
- Prefix: `support/tickets`, **Guard: YOK (global APP_GUARD devrede)**, 19 endpoint
- Bazi endpoint'ler `@AllowTenantAdmin()`, Identity: `@CurrentUser()` (JWT)

**MessagingController** (`src/support/controllers/messaging.controller.ts`)
- Prefix: `support/messages`, **Guard: YOK (global APP_GUARD devrede)**, 13 endpoint
- Bazi endpoint'ler `@AllowTenantAdmin()`, Identity: `@CurrentUser()` (JWT)

**AnnouncementController** (`src/support/controllers/announcement.controller.ts`)
- Prefix: `support/announcements`, **Guard: YOK (global APP_GUARD devrede)**, 13 endpoint
- Bazi endpoint'ler `@AllowTenantAdmin()`, Identity: `@CurrentUser()` (JWT)

**OnboardingController** (`src/support/controllers/onboarding.controller.ts`)
- Prefix: `support/onboarding`, **Guard: YOK (global APP_GUARD devrede)**, 14 endpoint

### 17. System Management Controllers (4 controller)

**GlobalSettingsController** (`src/system-management/controllers/global-settings.controller.ts`)
- Prefix: `system/settings`, **Guard: YOK (global APP_GUARD devrede)**, 25+ endpoint
- `GET /system/settings/provisioning-config` -- `@Public()` (auth bypass)
- `PUT /system/settings/provisioning-config` -- `@UseGuards(PlatformAdminGuard)` explicit

**PerformanceController** (`src/system-management/controllers/performance.controller.ts`)
- Prefix: `system/performance`, **Guard: YOK (global APP_GUARD devrede)**, 14 endpoint

**ErrorTrackingController** (`src/system-management/controllers/error-tracking.controller.ts`)
- Prefix: `system/errors`, **Guard: YOK (global APP_GUARD devrede)**, 18 endpoint

**JobQueueController** (`src/system-management/controllers/job-queue.controller.ts`)
- Prefix: `system/jobs`, **Guard: YOK (global APP_GUARD devrede)**, 18 endpoint

## Service Haritasi

| Service | Dosya | Inject Ettigi Dependency'ler | Onemli Public Method'lar |
|---------|-------|-----------------------------|-----------------------|
| UsersService | `src/users/users.service.ts` | DataSource | listUsers, getUserById, createUser, updateUser, setUserStatus, resetPassword, forceLogout, deleteUser, getUserStats |
| UserProvisioningService | `src/users/services/user-provisioning.service.ts` | DataSource | inviteUser, checkUserLimit |
| RoleTemplateService | `src/users/services/role-template.service.ts` | (none) | getAllRoleTemplates, getAssignableRoles, getAllPermissions, getRoleHierarchy, canAssignRole |
| UserPermissionsService | `src/users/services/user-permissions.service.ts` | Repository | getUserPermissions, updatePermissions, createDefaultPermissions, getTenantUsersPermissions |
| UserRoleAssignmentService | `src/users/services/user-role-assignment.service.ts` | Repository | (tenant role assignments) |
| TenantRoleService | `src/users/services/tenant-role.service.ts` | Repository | (tenant role management) |
| TenantDetailService | `src/tenant/services/tenant-detail.service.ts` | Repository, DataSource | getTenantDetail, bulkSuspend, bulkActivate, getActivitiesTimeline |
| TenantActivityService | `src/tenant/services/tenant-activity.service.ts` | Repository | getNotes, createNote, updateNote, deleteNote |
| TenantProvisioningService | `src/tenant/services/tenant-provisioning.service.ts` | DataSource | provisionTenant, getProvisioningStatus |
| AnalyticsService | `src/analytics/services/analytics.service.ts` | DataSource | getDashboardSummary, getTenantMetrics, getUserMetrics, getFinancialMetrics, getRevenueTrend |
| ReportsService | `src/analytics/services/reports.service.ts` | DataSource | generateReport, getDefinitions, getExecutions, generatePdfBuffer |
| AuditLogService | `src/audit/audit.service.ts` | Repository | query, getEntityHistory, getUserActivity, getSecurityLogs, getStatistics |
| SystemMetricsService | `src/metrics/system-metrics.service.ts` | DataSource | getSystemMetrics, getDatabaseMetrics, checkServicesHealth |
| ModulesService | `src/modules/modules.service.ts` | DataSource | listModules, getModuleStats, assignModuleToTenant, removeModuleFromTenant |
| PlanDefinitionService | `src/billing/services/plan-definition.service.ts` | Repository | findAll, create, update, comparePlans, seedDefaultPlans |
| DiscountCodeService | `src/billing/services/discount-code.service.ts` | Repository | findAll, create, validateCode, applyDiscount, bulkCreate |
| SubscriptionManagementService | `src/billing/services/subscription-management.service.ts` | Repository, DataSource | createSubscription, changePlan, cancelSubscription, processRenewals |
| SubscriptionCoreService | `src/billing/services/subscription-core.service.ts` | Repository | (core subscription logic) |
| SubscriptionPlanChangeService | `src/billing/services/subscription-plan-change.service.ts` | Repository | (plan change logic) |
| SubscriptionRenewalService | `src/billing/services/subscription-renewal.service.ts` | Repository | (renewal logic) |
| SubscriptionAnalyticsService | `src/billing/services/subscription-analytics.service.ts` | Repository | (analytics queries) |
| InvoiceManagementService | `src/billing/services/invoice-management.service.ts` | DataSource | getInvoices, markAsPaid, voidInvoice |
| ModulePricingService | `src/billing/services/module-pricing.service.ts` | Repository | getAllModulePricings, setModulePricing |
| PricingCalculatorService | `src/billing/services/pricing-calculator.service.ts` | ModulePricingService | calculatePricing, getQuickEstimate |
| CustomPlanService | `src/billing/services/custom-plan.service.ts` | Repository | listCustomPlans, createCustomPlan, approvePlan |
| SystemSettingService | `src/settings/services/system-setting.service.ts` | Repository | getAllSettings, updateSetting, getEmailConfig, getMaintenanceStatus |
| EmailTemplateService | `src/settings/services/email-template.service.ts` | Repository | getAllTemplates, createTemplate, renderTemplate |
| EmailSenderService | `src/settings/services/email-sender.service.ts` | ConfigService | sendEmail, sendInvitationEmail |
| IpAccessService | `src/settings/services/ip-access.service.ts` | Repository | getAllRules, createRule, checkIpAccess |
| TenantConfigurationService | `src/settings/services/tenant-configuration.service.ts` | Repository | getConfigurationByTenantId, updateConfiguration, createApiKey |
| DatabaseMonitoringService | `src/database-management/services/database-monitoring.service.ts` | DataSource | getDatabaseHealthStatus, getSlowQueries, getConnectionStats |
| BackupRestoreService | `src/database-management/services/backup-restore.service.ts` | Repository, DataSource | createBackup, restoreFromBackup, pointInTimeRecovery |
| MigrationManagementService | `src/database-management/services/migration-management.service.ts` | DataSource | runMigration, rollbackMigration, runBatchMigration |
| SchemaManagementService | `src/database-management/services/schema-management.service.ts` | DataSource | createTenantSchema, syncExistingTenantSchemas, deleteSchema |
| ImpersonationService | `src/impersonation/services/impersonation.service.ts` | Repository | startImpersonation, endImpersonation, validateSession |
| DebugToolsService | `src/impersonation/services/debug-tools.service.ts` | Multiple sub-services | startDebugSession, inspectQueries, inspectApiCalls, snapshotCache |
| SecurityMonitoringService | `src/security/services/security-monitoring.service.ts` | Repository | createSecurityEvent, querySecurityEvents, getSecurityDashboardStats |
| ActivityLoggingService | `src/security/services/activity-logging.service.ts` | Repository | queryActivities, logActivityImmediate |
| AuditTrailService | `src/security/services/audit-trail.service.ts` | Repository | getAuditTrail, exportAuditTrail, createRetentionPolicy |
| ComplianceService | `src/security/services/compliance.service.ts` | Repository | createDataRequest, generateComplianceReport, runComplianceChecks |
| TicketService | `src/support/services/ticket.service.ts` | Repository | getAllTickets, createTicket, assignTicket, addComment |
| MessagingService | `src/support/services/messaging.service.ts` | Repository | createThread, addMessage, sendBulkMessage |
| AnnouncementService | `src/support/services/announcement.service.ts` | Repository | createAnnouncement, publishAnnouncement |
| OnboardingService | `src/support/services/onboarding.service.ts` | Repository | initializeOnboarding, completeStep |
| GlobalSettingsService | `src/system-management/services/global-settings.service.ts` | Repository | createFeatureToggle, createMaintenanceMode, createSystemVersion |
| PerformanceMonitoringService | `src/system-management/services/performance-monitoring.service.ts` | Repository | getPerformanceDashboard, recordMetric |
| ErrorTrackingService | `src/system-management/services/error-tracking.service.ts` | Repository | reportError, queryErrorGroups |
| JobQueueService | `src/system-management/services/job-queue.service.ts` | Repository | createJob, scheduleJob, cancelJob, retryJob |
| HealthService | `src/health/health.service.ts` | DataSource | checkDatabase, isDraining, getMetrics |
| GracefulShutdownService | `src/lifecycle/graceful-shutdown.service.ts` | (NestJS hooks) | (shutdown logic) |
| StructuredLoggerService | `src/shared/structured-logger.service.ts` | (none) | (logging) |

## Entity Haritasi

| Entity | Dosya | Tablo Adi | Schema | Iliskiler |
|--------|-------|-----------|--------|-----------|
| AuditLog | `src/audit/audit.entity.ts` | admin.audit_logs | admin | - |
| Tenant | `src/tenant/entities/tenant.entity.ts` | admin.tenants | admin | - |
| TenantActivity | `src/tenant/entities/tenant-activity.entity.ts` | admin.tenant_activities | admin | ManyToOne(Tenant) |
| AnalyticsSnapshot | `src/analytics/entities/analytics-snapshot.entity.ts` | admin.analytics_snapshots | admin | - |
| UserEntity (external) | `src/analytics/entities/external/user.entity.ts` | auth.users | auth | read-only |
| TenantEntity (external) | `src/analytics/entities/external/tenant.entity.ts` | auth.tenants | auth | read-only |
| InvoiceEntity (external) | `src/analytics/entities/external/invoice.entity.ts` | billing.invoices | billing | read-only |
| SubscriptionEntity (external) | `src/analytics/entities/external/subscription.entity.ts` | billing.subscriptions | billing | read-only |
| PlanDefinition | `src/billing/entities/plan-definition.entity.ts` | admin.plan_definitions | admin | OneToMany(PlanModuleAssignment) |
| PlanModuleAssignment | `src/billing/entities/plan-module-assignment.entity.ts` | admin.plan_module_assignments | admin | ManyToOne(PlanDefinition) |
| ModulePricing | `src/billing/entities/module-pricing.entity.ts` | admin.module_pricing | admin | - |
| DiscountCode | `src/billing/entities/discount-code.entity.ts` | admin.discount_codes | admin | - |
| CustomPlan | `src/billing/entities/custom-plan.entity.ts` | admin.custom_plans | admin | - |
| DatabaseManagement entities | `src/database-management/entities/database-management.entity.ts` | admin.schema_registry, admin.backups, admin.restores, admin.migrations | admin | - |
| ImpersonationSession | `src/impersonation/entities/impersonation-session.entity.ts` | admin.impersonation_sessions | admin | - |
| DebugSession | `src/impersonation/entities/debug-session.entity.ts` | admin.debug_sessions | admin | - |
| Security entities | `src/security/entities/security.entity.ts` | admin.activity_logs, admin.security_events, admin.security_incidents, admin.threat_intelligence, admin.data_requests, admin.compliance_reports, admin.retention_policies | admin | SecurityIncident hasMany SecurityEvent |
| SystemSetting | `src/settings/entities/system-setting.entity.ts` | admin.system_settings | admin | - |
| TenantConfiguration | `src/settings/entities/tenant-configuration.entity.ts` | admin.tenant_configurations | admin | - |
| Support entities | `src/support/entities/support.entity.ts` | admin.support_tickets, admin.message_threads, admin.announcements, admin.onboarding_progress | admin | Ticket hasMany comments inline |
| GlobalConfig | `src/system-management/entities/global-config.entity.ts` | admin.global_configs | admin | - |
| FeatureToggle | `src/system-management/entities/feature-toggle.entity.ts` | admin.feature_toggles | admin | - |
| MaintenanceMode | `src/system-management/entities/maintenance-mode.entity.ts` | admin.maintenance_modes | admin | - |
| SystemVersion | `src/system-management/entities/system-version.entity.ts` | admin.system_versions | admin | - |
| ErrorTracking | `src/system-management/entities/error-tracking.entity.ts` | admin.error_groups, admin.error_occurrences | admin | ErrorOccurrence ManyToOne ErrorGroup |
| PerformanceMetric | `src/system-management/entities/performance-metric.entity.ts` | admin.performance_metrics | admin | - |
| JobQueue entities | `src/system-management/entities/job-queue.entity.ts` | admin.job_queues, admin.jobs, admin.job_execution_logs | admin | Job ManyToOne JobQueue |
| UserPermissions | `src/users/entities/user-permissions.entity.ts` | admin.user_permissions | admin | - |
| TenantRole | `src/users/entities/tenant-role.entity.ts` | admin.tenant_roles | admin | - |
| TenantRolePermissions | `src/users/entities/tenant-role-permissions.entity.ts` | admin.tenant_role_permissions | admin | ManyToOne(TenantRole) |
| UserRoleAssignment | `src/users/entities/user-role-assignment.entity.ts` | admin.user_role_assignments | admin | ManyToOne(TenantRole) |

## CQRS Durum Haritasi

| Modul | Pattern | Detay |
|-------|---------|-------|
| **tenant** | **CQRS** | CommandBus: CreateTenantCommand, UpdateTenantCommand, SuspendTenantCommand, ActivateTenantCommand, DeactivateTenantCommand, ArchiveTenantCommand. QueryBus: GetTenantByIdQuery, ListTenantsQuery, GetTenantStatsQuery, SearchTenantsQuery ve 4 daha. Handler'lar: `src/tenant/handlers/` ve `src/tenant/query-handlers/` |
| users | Klasik | Service pattern |
| billing | Klasik | Service pattern |
| analytics | Klasik | Service pattern |
| audit | Klasik | Service pattern |
| settings | Klasik | Service pattern |
| modules | Klasik | Service pattern |
| database-management | Klasik | Service pattern |
| impersonation | Klasik | Service pattern |
| security | Klasik | Service pattern |
| support | Klasik | Service pattern |
| system-management | Klasik | Service pattern |
| health | Klasik | Service pattern |
| metrics | Klasik | Service pattern |
| auth | Klasik | Direct DataSource injection |

**CqrsModule** app.module.ts'de import edilmistir ancak yalnizca tenant modulu tarafindan aktif olarak kullanilmaktadir.

## Guard Analizi

### Global Guard
- **PlatformAdminGuard** `APP_GUARD` olarak kayitli (`app.module.ts:127`)
- JWT dogrulamasi yapar, varsayilan olarak `SUPER_ADMIN` veya `PLATFORM_ADMIN` rollerinden birini arar
- `@Public()` decorator ile bypass edilebilir
- `@Roles()` decorator ile gerekli roller override edilebilir
- `@AllowTenantAdmin()` = `@Roles('TENANT_ADMIN', 'SUPER_ADMIN', 'PLATFORM_ADMIN')`

### Controller-Level Guard
Asagidaki controller'lar **ek olarak** `@UseGuards(PlatformAdminGuard)` kullanir (gereksiz cunku global guard zaten aktif):
- AuditLogController, BillingController, UsersController, SettingsController, ModulesController, SystemMetricsController, AnalyticsController, ReportsController
- Tum database-management controller'lari
- ImpersonationController

### Guard'siz Controller'lar (yalnizca global APP_GUARD'a guveniyorlar)
- DebugToolsController, AuditTrailController, ActivityLogController, SecurityMonitoringController, ComplianceController
- IpAccessController, EmailTemplateController, TenantConfigurationController
- TicketController, MessagingController, AnnouncementController, OnboardingController
- GlobalSettingsController, PerformanceController, ErrorTrackingController, JobQueueController

### @Public() Endpoint'leri (guard bypass)
- `GET /health` , `GET /health/live`, `GET /health/ready`, `GET /health/startup`
- `POST /auth/forgot-password`, `POST /auth/reset-password`
- `GET /system/settings/provisioning-config`

### ThrottlerGuard Durumu
- **Global ThrottlerGuard KALDIRILMIS** (app.module.ts:128-131 comment)
- `ThrottlerModule` import ediliyor ama APP_GUARD olarak register edilmiyor
- **Per-route throttle:** Yalnizca `@ThrottlePasswordReset()` (password-reset controller, 2 endpoint)
- **@SkipThrottle():** HealthController (class-level)

## Bulgular + Spawn Talepleri

### Kritik Bulgular

1. **CLIENT-SUPPLIED IDENTITY (YUKSEK RISK):** DebugToolsController'da `@Query('adminId') adminId: string` ile admin kimligi client'tan aliniyor (`POST /debug/sessions`, `POST /debug/feature-overrides`, `POST /debug/feature-overrides/:id/revert`). Bu, herhangi bir authenticated admin'in baska bir admin gibi islem yapmasina izin verir.

2. **CLIENT-SUPPLIED ACTOR IDs (ORTA RISK):** Billing, Settings, Security controller'larinda `updatedBy`, `createdBy`, `cancelledBy`, `approverId`, `rejectedBy`, `markedBy`, `voidedBy` gibi alanlar `@Body()` ile client'tan aliniyor. JWT'deki admin kimligi yerine kullanici-saglanan degerler kullaniliyor. Bu audit trail'in guvenilirligini zedeler.

3. **HARDCODED IDENTITY (DUSUK RISK):** Security controller'larinda (AuditTrailController, SecurityMonitoringController, ComplianceController) `createdBy: 'admin'` hardcoded. Gercek admin kimligi kayit altina alinmiyor.

4. **THROTTLE EKSIKLIGI:** Global ThrottlerGuard kaldirilmis, yalnizca password-reset'te per-route throttle var. Dashboard endpoint'leri (5 paralel DB sorgusu) ve billing islemleri throttle olmadan acik.

5. **RAW SQL ENDPOINT:** `POST /database/explorer/query` production'da bloke ediliyor ama dev/staging'de acik. Ayrica `POST/PUT/DELETE` satirlari (INSERT/UPDATE/DELETE) her ortamda acik.

6. **PUBLIC PROVISIONING CONFIG:** `GET /system/settings/provisioning-config` auth gerektirmiyor (`@Public()`). Bu endpoint'in hangi verileri dondurdugu incelenmeli.

7. **GLOBAL GUARD vs EXPLICIT GUARD TUTARSIZLIGI:** 33 controller'dan ~15'i ek `@UseGuards(PlatformAdminGuard)` kullaniyor, ~18'i global guard'a guveniyor. Davranis ayni ama niyet ve kod tutarliligi acisindan karisiklik yaratabilir.

### Spawn Talepleri (P3/P4 Icin)

- **P3-AUTH-001:** DebugToolsController `adminId` parametresinin `req.user` ile degistirilmesi
- **P3-AUTH-002:** Billing/Settings/Security controller'larinda client-supplied actor ID'lerin `req.user` ile degistirilmesi
- **P3-AUTH-003:** Security controller'larinda hardcoded `'admin'` yerine `@CurrentUser()` kullanimi
- **P3-THROTTLE-001:** Kritik endpoint'lere (billing islemleri, database operations) per-route throttle eklenmesi
- **P3-SECURITY-001:** Database Explorer CRUD endpoint'lerine environment check eklenmesi
- **P3-PUBLIC-001:** `GET /system/settings/provisioning-config` icin @Public() gerekcesinin dogrulanmasi
