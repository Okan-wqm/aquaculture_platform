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
    file: 'apps/admin-api-service/src/impersonation/services/impersonation.service.ts',
    exports: ['ImpersonationAuditSummary'],
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
