import type { AdminSchemalessJsonReason } from '@platform/admin-http-contracts';

export interface AdminSchemalessBoundaryPolicy {
  readonly owner: string;
  readonly rationale: string;
  readonly reason: AdminSchemalessJsonReason;
  readonly schemaPolicy:
    | 'bounded-json-value'
    | 'database-adapter-value'
    | 'provider-owned-extension';
}

/**
 * Closed governance authority for the small set of request fields whose shape
 * is intentionally not owned by the admin API. Every key is derived from the
 * declaring source symbol, not a route or line number. Unknown keys fail codegen.
 */
export const ADMIN_SCHEMALESS_BOUNDARY_CATALOG: Readonly<
  Record<string, AdminSchemalessBoundaryPolicy>
> = Object.freeze({
  'request:apps/admin-api-service/src/analytics/controllers/reports.controller.ts#CreateDefinitionDto.defaultFilters':
    {
      owner: 'admin-analytics',
      rationale:
        'Report filters are keyed by the selected report definition and validated by that report executor.',
      reason: 'report-dataset',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/analytics/controllers/reports.controller.ts#UpdateDefinitionDto.defaultFilters':
    {
      owner: 'admin-analytics',
      rationale:
        'Report filters are keyed by the selected report definition and validated by that report executor.',
      reason: 'report-dataset',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/analytics/controllers/reports.controller.ts#ExecuteReportDto.filters':
    {
      owner: 'admin-analytics',
      rationale:
        'Execution filters are selected by report type and consumed by the owning report executor.',
      reason: 'report-dataset',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/billing/services/discount-code.service.ts#CreateDiscountCodeDto.metadata':
    {
      owner: 'admin-billing',
      rationale:
        'Discount metadata is an explicitly bounded extension bag owned by the billing discount domain.',
      reason: 'extension-metadata',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/billing/services/discount-code.service.ts#UpdateDiscountCodeDto.metadata':
    {
      owner: 'admin-billing',
      rationale:
        'Discount metadata is an explicitly bounded extension bag owned by the billing discount domain.',
      reason: 'extension-metadata',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/database-management/controllers/explorer.controller.ts#InsertRowDto.data':
    {
      owner: 'admin-database',
      rationale:
        'Explorer row values are determined by the selected database table schema at runtime.',
      reason: 'database-record',
      schemaPolicy: 'database-adapter-value',
    },
  'request:apps/admin-api-service/src/database-management/controllers/explorer.controller.ts#UpdateRowDto.data':
    {
      owner: 'admin-database',
      rationale:
        'Explorer row values are determined by the selected database table schema at runtime.',
      reason: 'database-record',
      schemaPolicy: 'database-adapter-value',
    },
  'request:apps/admin-api-service/src/database-management/controllers/explorer.controller.ts#ExecuteQueryDto.params':
    {
      owner: 'admin-database',
      rationale:
        'Parameterized query values are interpreted by the database adapter against the SQL placeholders.',
      reason: 'database-record',
      schemaPolicy: 'database-adapter-value',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#StartDebugSessionDto.configuration':
    {
      owner: 'admin-debug',
      rationale:
        'Debug-session configuration is a bounded observation policy interpreted by the selected debug tool.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CaptureQueryDto.explainPlan':
    {
      owner: 'admin-debug',
      rationale:
        'Explain-plan structure is emitted by the active database engine and retained as an observation.',
      reason: 'debug-observation',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CaptureQueryDto.parameters':
    {
      owner: 'admin-debug',
      rationale:
        'Captured SQL parameter values mirror the database observation and preserve placeholder order.',
      reason: 'debug-observation',
      schemaPolicy: 'database-adapter-value',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CaptureApiCallDto.requestBody':
    {
      owner: 'admin-debug',
      rationale:
        'Captured request bodies mirror the observed API payload and are not a mutation instruction.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CaptureApiCallDto.responseBody':
    {
      owner: 'admin-debug',
      rationale:
        'Captured response bodies mirror the observed API payload and are retained only for diagnosis.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CreateFeatureFlagOverrideDto.originalValue':
    {
      owner: 'admin-debug',
      rationale:
        'The original flag value preserves the governed flag provider value for rollback evidence.',
      reason: 'debug-observation',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts#CreateFeatureFlagOverrideDto.overrideValue':
    {
      owner: 'admin-debug',
      rationale:
        'Override values are constrained by the referenced feature definition and retained with rollback evidence.',
      reason: 'operator-configuration',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/modules/modules.controller.ts#AssignModuleDto.configuration':
    {
      owner: 'admin-modules',
      rationale:
        'Module assignment configuration is owned and validated by the selected module provider.',
      reason: 'operator-configuration',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/security/controllers/security-monitoring.controller.ts#CreateSecurityEventDto.rawData':
    {
      owner: 'admin-security',
      rationale:
        'Raw security-event data preserves the provider-owned detection payload for investigation.',
      reason: 'external-system-record',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/settings/dto/settings.dto.ts#ImportSettingsDto.data': {
    owner: 'admin-settings',
    rationale:
      'Imported settings are keyed by the setting registry and decoded by each owning setting definition.',
    reason: 'operator-configuration',
    schemaPolicy: 'bounded-json-value',
  },
  'request:apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts#ErrorContext.breadcrumbs.data':
    {
      owner: 'admin-error-tracking',
      rationale: 'Breadcrumb data preserves the observed client event context for diagnosis.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts#ErrorContext.extra':
    {
      owner: 'admin-error-tracking',
      rationale:
        'Extra error context preserves bounded client diagnostics that have no domain mutation semantics.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts#ErrorContext.request.body':
    {
      owner: 'admin-error-tracking',
      rationale:
        'Captured request bodies preserve bounded diagnostic context and have no mutation semantics.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/entities/error-tracking.entity.ts#ErrorContext.response.body':
    {
      owner: 'admin-error-tracking',
      rationale:
        'Captured response bodies preserve bounded diagnostic context and have no mutation semantics.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts#CreateAlertRuleDto.actions.config':
    {
      owner: 'admin-error-tracking',
      rationale: 'Alert action configuration is owned by the selected action adapter.',
      reason: 'operator-configuration',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts#UpdateErrorAlertRuleDto.actions.config':
    {
      owner: 'admin-error-tracking',
      rationale: 'Alert action configuration is owned by the selected action adapter.',
      reason: 'operator-configuration',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/error-tracking.controller.ts#ReportErrorDto.metadata':
    {
      owner: 'admin-error-tracking',
      rationale:
        'Error metadata preserves bounded diagnostic context supplied by the reporting SDK.',
      reason: 'debug-observation',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#CreateFeatureToggleDto.defaultValue':
    {
      owner: 'admin-settings',
      rationale:
        'Feature-toggle values are constrained by the toggle definition selected in the same request.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#UpdateFeatureToggleDto.defaultValue':
    {
      owner: 'admin-settings',
      rationale: 'Feature-toggle values are constrained by the existing toggle definition.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#CreateFeatureToggleDto.variants.value':
    {
      owner: 'admin-settings',
      rationale:
        'Variant values are constrained by the feature-toggle definition and selected variant key.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#UpdateFeatureToggleDto.variants.value':
    {
      owner: 'admin-settings',
      rationale:
        'Variant values are constrained by the existing feature-toggle definition and variant key.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#CreateConfigDto.defaultValue':
    {
      owner: 'admin-settings',
      rationale:
        'Configuration values are constrained by the type and validation rule declared with the key.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#CreateConfigDto.value':
    {
      owner: 'admin-settings',
      rationale:
        'Configuration values are constrained by the type and validation rule declared with the key.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#CreateConfigDto.validation.allowedValues':
    {
      owner: 'admin-settings',
      rationale:
        'Allowed values are bounded JSON scalars compared by the owning configuration definition.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#UpdateConfigDto.value':
    {
      owner: 'admin-settings',
      rationale:
        'Configuration values are constrained by the existing registry definition for the key.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/global-settings.controller.ts#BulkConfigUpdateItem.value':
    {
      owner: 'admin-settings',
      rationale:
        'Bulk configuration values are constrained independently by each registry key definition.',
      reason: 'operator-configuration',
      schemaPolicy: 'bounded-json-value',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#CreateJobDto.metadata':
    {
      owner: 'admin-jobs',
      rationale:
        'Job metadata is interpreted by the selected job handler and retained with the job envelope.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#CreateJobDto.payload':
    {
      owner: 'admin-jobs',
      rationale: 'Job payload shape is selected by jobType and decoded by its registered handler.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#ScheduleJobDto.metadata':
    {
      owner: 'admin-jobs',
      rationale:
        'Job metadata is interpreted by the selected job handler and retained with the job envelope.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#ScheduleJobDto.payload':
    {
      owner: 'admin-jobs',
      rationale:
        'Scheduled-job payload shape is selected by jobType and decoded by its registered handler.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#RecurringJobDto.metadata':
    {
      owner: 'admin-jobs',
      rationale:
        'Recurring-job metadata is interpreted by the selected job handler at each occurrence.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#RecurringJobDto.payload':
    {
      owner: 'admin-jobs',
      rationale:
        'Recurring-job payload shape is selected by jobType and decoded by its registered handler.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
  'request:apps/admin-api-service/src/system-management/controllers/job-queue.controller.ts#UpdateJobProgressDto.checkpoint':
    {
      owner: 'admin-jobs',
      rationale:
        'Checkpoint shape is owned by the selected job handler and used only for that job resume path.',
      reason: 'job-payload',
      schemaPolicy: 'provider-owned-extension',
    },
});
