/**
 * Admin REST contract manifest — the SSoT for what the admin panel consumes.
 *
 * # Why this exists
 *
 * `web/modules/admin-panel` is a federated remote: its tsconfig resolves only
 * `@/*` and `@aquaculture/shared-ui`, so it cannot import a backend library.
 * The consequence, until now, was that every response shape was RE-DECLARED by
 * hand on the frontend — 113 of the panel's 177 exported types share a name
 * with an admin-api export, plus 12 more under a `Backend*` prefix. Each was a
 * second definition of a contract that has one owner.
 *
 * Nothing bound the two copies. Seven of them were pinned by field-by-field
 * parity specs, which is better than nothing but is still duplication: the
 * contract then exists three times (backend, frontend, and the spec asserting
 * they match). The other ~118 were pinned by nothing at all, which is how
 * `getComplianceChecks` came to declare `requirement` a string against an
 * object, and how six analytics endpoints came to declare fields the backend
 * has never sent.
 *
 * The cure is not a better gate. It is to stop declaring the frontend copy:
 * `generate.ts` reads the backend types named here through the TypeScript
 * compiler and emits them into the panel's own source tree, so the frontend
 * type is DERIVED. Drift stops being something to detect and becomes something
 * that cannot be expressed — the generated file simply changes with the
 * backend, and CI fails if someone forgets to regenerate.
 *
 * # Adding an entry
 *
 * Name the backend type and the module it belongs to. The generator resolves
 * its transitive dependencies itself, so list only the types the panel names
 * directly. Run `npm run codegen:admin-contracts`.
 *
 * # What the generator will refuse
 *
 * A type that cannot cross a JSON boundary — a method, a class instance with
 * behaviour, a framework type. That refusal is a feature: it is the generator
 * telling you a persistence object is about to be serialized onto a response.
 *
 * # What does NOT belong here
 *
 * The paginated envelope. `IStandardPaginatedResult` is what a producer
 * RETURNS; it is not what the panel receives. The `ResponseInterceptor` lifts
 * `items` into the envelope's `data` slot, moves the numerics into `meta`, and
 * drops `hasNextPage`/`hasPreviousPage` (both derivable from the rest), and the
 * http-client then flattens that into `PaginatedResult<T>`. That shape is a
 * property of the transport, owned jointly by the interceptor and the client
 * and pinned by `admin-api-pagination-canonical` — generating it from the
 * producer type would assert a shape the wire does not carry.
 *
 * This manifest is for DOMAIN contracts: the `T` inside the envelope.
 */

export interface ContractSource {
  /**
   * Logical grouping. Becomes a section header in the generated file and
   * matches the panel's own `services/types/*.ts` split so a reader can find
   * the emitted type from the file that re-exports it.
   */
  readonly module: string;
  /** Repo-relative path of the file that EXPORTS the type. */
  readonly file: string;
  /** Exported type names to emit. Transitive dependencies come along automatically. */
  readonly exports: readonly string[];
  /**
   * Emit under a different name.
   *
   * For name collisions between backend modules that the panel flattens into
   * one namespace — analytics owns a `SystemMetrics` (storage/API/error rates)
   * and system-management owns a different one (platform health). Renaming at
   * GENERATION keeps the panel's import sites honest about which is which;
   * aliasing on import would leave two `SystemMetrics` in the codebase and make
   * the collision something each reader has to rediscover.
   */
  readonly rename?: Readonly<Record<string, string>>;
}

/**
 * Ordered by module so the generated file reads like the panel's type layout
 * rather than like the backend's directory tree.
 */
export const ADMIN_CONTRACT_SOURCES: readonly ContractSource[] = [
  {
    module: 'analytics',
    file: 'apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts',
    exports: [
      'TenantMetrics',
      'UserMetrics',
      'FinancialMetrics',
      'SystemMetrics',
      'UsageMetrics',
      'ModuleUsageStats',
      'ChartData',
      'TimeSeriesPoint',
      'TimeSeriesData',
      'TimeSeriesResponse',
      'DashboardSummary',
      'ReportType',
      'ReportFormat',
      'ReportExecutionStatus',
    ],
    rename: { SystemMetrics: 'AnalyticsSystemMetrics' },
  },
  {
    module: 'analytics',
    file: 'apps/admin-api-service/src/analytics/services/analytics.service.ts',
    exports: ['ComparisonDto'],
  },
  {
    module: 'impersonation',
    // Every impersonation route declares a named return type now, so the panel
    // derives the whole surface instead of the two shapes it happened to pin.
    // `SafeImpersonationSession` is `Omit<ImpersonationSession, secrets>` — the
    // entity carries the session token, which must never reach the panel, so
    // generating the ENTITY here would publish it.
    file: 'apps/admin-api-service/src/impersonation/services/impersonation.service.ts',
    exports: [
      'ImpersonationAuditSummary',
      'StartedImpersonationSession',
      'ImpersonationEligibility',
      'ImpersonationValidation',
      'ActiveSessionCount',
      'ImpersonationContext',
    ],
  },
  {
    module: 'impersonation',
    // The WRITE contracts — the DTOs the ValidationPipe whitelists, not the
    // service inputs beside them. `StartImpersonationRequest` on the service
    // carries `superAdminId`, `ipAddress` and `userAgent`, which the controller
    // takes from the verified JWT and the socket; a panel that sent them would
    // be rejected by `forbidNonWhitelisted`. Generating the DTO instead means
    // the panel's request type IS what the endpoint accepts.
    //
    // These were declared but not exported, which is a contract with a name
    // nobody outside can use — and is why the panel's hand-written copy had
    // dropped `permissions`, so a super-admin could not scope a session's
    // access at start time.
    file: 'apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts',
    exports: ['StartImpersonationDto', 'GrantPermissionDto'],
    rename: { StartImpersonationDto: 'StartImpersonationRequest' },
  },
  {
    module: 'security',
    file: 'apps/admin-api-service/src/security/services/compliance.service.ts',
    exports: ['ComplianceRequirement', 'ComplianceCheckResult'],
  },
  {
    module: 'database',
    file: 'apps/admin-api-service/src/database-management/entities/database-management.entity.ts',
    exports: [
      'BackupStatus',
      'BackupType',
      'MigrationStatus',
      'SchemaStatus',
      'SchemaMigration',
      'TenantSchema',
      'SchemaBackup',
    ],
    // The panel has always called this `DatabaseBackup`. Renaming at generation
    // keeps that name at every call site while making the entity its single
    // author.
    rename: { SchemaBackup: 'DatabaseBackup' },
  },
  {
    module: 'debug',
    file: 'apps/admin-api-service/src/impersonation/entities/debug-session.entity.ts',
    exports: [
      'DebugSessionType',
      'DebugSession',
      'CapturedQuery',
      'CapturedApiCall',
      'FeatureFlagOverride',
    ],
  },
  {
    module: 'tenant',
    file: 'apps/admin-api-service/src/tenant/entities/tenant-activity.entity.ts',
    exports: ['TenantActivity', 'TenantNote'],
  },
  {
    module: 'tenant',
    // The ENTITLEMENT vocabulary — what `auth.tenants.plan` stores, what
    // `Tenant.tier` reads back (it is a getter over `plan`), and what the
    // create/update/query tenant DTOs validate with `@IsEnum(TenantPlan)`. It
    // has `trial` and NO `custom`.
    //
    // Distinct from the SELLABLE `BillingPlanTier`, emitted above as `PlanTier`,
    // which has `custom` and no `trial`. Both are canonical; they describe
    // different things. The panel used to declare ONE hand-written `TenantTier`
    // pinned to the SELLABLE set and hand it to the tenant endpoints, which
    // validate the ENTITLEMENT one — so the panel believed it could send
    // `custom` (a 400) and believed `trial` impossible (the endpoint takes it).
    // Generating both under their real names makes the two sets impossible to
    // confuse at a call site.
    file: 'libs/event-contracts/src/enums/tenant-plan.enum.ts',
    exports: ['TenantPlan'],
  },
  {
    module: 'tenant',
    // The tenant lifecycle vocabulary. The panel's hand-written copy was missing
    // CANCELLED and PURGED, two states auth.tenants' CHECK constraint allows —
    // so a tenant in either rendered with no matching filter option.
    file: 'libs/event-contracts/src/enums/tenant-status.enum.ts',
    exports: ['TenantStatus'],
  },
  {
    module: 'tenant',
    // The tenant READ contract. Every tenant read route returns one of these
    // two; `toTenantSummary` is their only producer. Before that existed, five
    // routes returned the `Tenant` ENTITY, whose `tier` and `limits` are getters
    // and therefore absent from the JSON.
    file: 'apps/admin-api-service/src/tenant/dto/tenant-summary.dto.ts',
    exports: ['TenantSummaryDto', 'TenantListItemDto'],
  },
  {
    module: 'tenant',
    file: 'apps/admin-api-service/src/tenant/dto/tenant-detail.dto.ts',
    exports: ['TenantDetailDto', 'TenantAvailableAction'],
  },
  {
    module: 'support',
    file: 'apps/admin-api-service/src/support/entities/support.entity.ts',
    exports: ['OnboardingStep'],
  },
  {
    module: 'audit',
    file: 'apps/admin-api-service/src/audit/audit.entity.ts',
    exports: ['AuditLog', 'AuditSeverity'],
  },
  {
    module: 'security',
    file: 'apps/admin-api-service/src/security/entities/security.entity.ts',
    exports: [
      'ComplianceType',
      'DataRequestStatus',
      'DataRequestType',
      'SecurityEventStatus',
      'SecurityEventType',
    ],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/entities/job-queue.entity.ts',
    exports: ['JobStatus', 'BackgroundJob'],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts',
    exports: ['ErrorGroup', 'ErrorOccurrence'],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/entities/feature-toggle.entity.ts',
    exports: ['FeatureToggleScope', 'FeatureToggleStatus', 'FeatureToggle'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/plan-definition.entity.ts',
    exports: ['PlanFeatures', 'PlanLimits', 'PlanDefinition'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/module-pricing.entity.ts',
    exports: ['PricingMetric', 'TierMultipliers', 'ModulePricing'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/custom-plan.entity.ts',
    exports: ['CustomPlanModule', 'CustomPlanLineItem', 'CustomPlan'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/discount-code.entity.ts',
    exports: ['DiscountType', 'DiscountAppliesTo', 'DiscountDuration', 'DiscountCode'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/pricing-metric.enum.ts',
    exports: ['PricingMetricType'],
  },
  {
    module: 'billing',
    file: 'libs/event-contracts/src/billing/billing-plan-tier.ts',
    // The admin-billing surface has always called this `PlanTier`; the backend
    // re-exports `BillingPlanTier` under that name for the same reason.
    exports: ['BillingPlanTier'],
    rename: { BillingPlanTier: 'PlanTier' },
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/entities/usage-aggregation-readonly.entity.ts',
    exports: ['MeterType'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/subscription-types.ts',
    exports: [
      'SubscriptionStatus',
      'ModuleQuantities',
      'ModuleLineItem',
      'SubscriptionModuleConfig',
      'SubscriptionOverview',
      'SubscriptionStats',
    ],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/pricing-calculator.service.ts',
    exports: [
      'ModuleSelection',
      'ModulePriceBreakdown',
      'PricingLineItem',
      'PricingCalculation',
      'QuoteRequest',
    ],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/invoice-management.service.ts',
    exports: ['InvoiceOverview', 'InvoiceStats'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/payment-management.service.ts',
    exports: ['PaymentOverview'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/usage-metering-management.service.ts',
    exports: ['TenantUsageOverview', 'TopTenantUsage', 'UsageSummaryStats', 'UsageTrendPoint'],
  },
  {
    module: 'billing',
    file: 'apps/admin-api-service/src/billing/services/discount-code.service.ts',
    exports: ['DiscountStats'],
  },
  {
    module: 'modules',
    file: 'apps/admin-api-service/src/modules/modules.service.ts',
    exports: ['ModuleStats', 'TenantModuleAssignment'],
  },
  {
    module: 'users',
    file: 'apps/admin-api-service/src/users/users.service.ts',
    exports: ['UserStats'],
  },
  {
    module: 'security',
    // The security-monitoring read contracts. Six of these were anonymous
    // `Promise<{ … }>` return types until they were named — which is why the
    // panel carried `BackendSecurityHealthScore` and friends: with nothing to
    // import, a hand copy was the only option.
    file: 'apps/admin-api-service/src/security/services/security-monitoring.service.ts',
    exports: [
      'SecurityDashboardStats',
      'SecurityEventStats',
      'IncidentStats',
      'ThreatIntelStats',
      'ThreatCheckResult',
      'SecurityHealthScore',
      'SecurityHealthFactor',
      'SecurityTelemetryStatus',
    ],
  },
  {
    module: 'security',
    // The security entities these routes return, plus the vocabularies their
    // histograms are keyed by. Returning entities is tracked separately
    // (ADMIN-MEDIUM-090); generating from them states the truth of what the
    // wire carries TODAY rather than leaving the panel to guess it.
    file: 'apps/admin-api-service/src/security/entities/security.entity.ts',
    exports: [
      'SecurityEvent',
      'SecurityIncident',
      'ThreatIntelligence',
      'ActivityLog',
      'ThreatLevel',
      'ThreatIndicatorType',
      'SecurityEventStatus',
      'SecurityEventType',
      'IncidentStatus',
      'IncidentSeverity',
      'ActivityCategory',
      'ActivitySeverity',
    ],
  },
  {
    module: 'settings',
    // Job-queue observability. Every route on the job-queue controller declares
    // a named return type now, so the panel derives the whole surface.
    file: 'apps/admin-api-service/src/system-management/services/job-queue.service.ts',
    exports: ['JobQueueStats', 'RetriedJobsResult', 'PurgedJobsResult'],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/entities/job-queue.entity.ts',
    exports: ['JobQueue', 'BackgroundJob', 'JobExecutionLog'],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/dto/job-dashboard.dto.ts',
    exports: ['JobDashboardDto'],
  },
  {
    module: 'settings',
    // Performance monitoring. Four of these were anonymous ARRAY ELEMENTS
    // (`Promise<Array<{ … }>>`) — the same defect as an anonymous object return,
    // one layer down, and the form the first version of the named-return-type
    // gate did not catch.
    file: 'apps/admin-api-service/src/system-management/services/performance-monitoring.service.ts',
    exports: [
      'PerformanceDashboard',
      'ApplicationMetrics',
      'DatabasePerformanceMetrics',
      'InfrastructureMetrics',
      'MetricThreshold',
      'SlowQueryAggregate',
      'ServiceBreakdown',
      'ThresholdBreach',
      'MetricHistoryPoint',
      'ApdexScoreResult',
    ],
  },
  {
    module: 'system',
    // Platform health. NOT the analytics `SystemMetrics` emitted above as
    // `AnalyticsSystemMetrics` — two backend modules own a type by that name,
    // and the panel flattens both into one namespace.
    file: 'apps/admin-api-service/src/metrics/system-metrics.service.ts',
    exports: ['SystemMetrics', 'ServiceHealth'],
  },
  {
    module: 'system',
    file: 'apps/admin-api-service/src/health/health.service.ts',
    exports: ['CircuitBreakerStatus'],
  },
  {
    module: 'users',
    // The canonical role vocabulary, declared as `as const` arrays rather than
    // enums (a backend enum here would have created a second canonical
    // declaration and an import cycle — see the module docblock). The panel
    // mirrored both by hand, held in lockstep by a parity spec; generating them
    // removes the copy the spec existed to police.
    file: 'libs/event-contracts/src/roles.ts',
    exports: ['PLATFORM_ROLE_CODES', 'INVITABLE_ROLE_CODES'],
  },
  {
    module: 'users',
    // The user READ contract. `role` is the canonical vocabulary rather than a
    // bare string, so a page cannot compare it against a code that is not one.
    file: 'apps/admin-api-service/src/users/users.service.ts',
    exports: ['UserDto'],
  },
  {
    module: 'users',
    file: 'apps/admin-api-service/src/users/services/role-template.service.ts',
    exports: ['Permission', 'RoleTemplate'],
  },
  {
    module: 'security',
    // NOT `security/services/audit-trail.service.ts`'s `AuditSummary` — that is
    // a different shape that merely shares the name. The route returns what
    // `AuditLogService.getStatistics` returns.
    file: 'apps/admin-api-service/src/audit/audit.service.ts',
    exports: ['AuditStatistics'],
    rename: { AuditStatistics: 'AuditSummary' },
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/settings/entities/system-setting.entity.ts',
    exports: ['EmailTemplateVariable', 'EmailTemplate', 'IpAccessRule'],
  },
  {
    module: 'settings',
    file: 'apps/admin-api-service/src/system-management/entities/maintenance-mode.entity.ts',
    exports: ['MaintenanceStatus'],
  },
];
