# Admin API Service - Input Validation Discovery Log

## Date: 2026-03-22

## Summary

Full audit of all `@Body()` usages across 20+ controllers in admin-api-service.
Every untyped, inline-typed, Partial<>, and raw field-extraction `@Body('field')` pattern
was replaced with proper class-validator DTO classes.

## CRIT Findings (Fixed)

### 1. Tenant Controller
- **CRIT**: `@Body('reason')` raw string extraction on deactivate endpoint -> `DeactivateTenantDto`
- **CRIT**: `@Body() body: { createAdmin?; adminEmail?; modules? }` inline type on provision -> `ProvisionTenantDto`

### 2. Impersonation Controller
- **CRIT**: `@Body() dto: { reason?: string }` inline on end-session -> `EndImpersonationDto`
- **CRIT**: `@Body() dto: { reason: string }` inline on terminate -> `TerminateSessionDto`
- **CRIT**: `@Body() dto: { resourceType; resourceId; action }` inline on log-resource -> `LogResourceAccessDto`

### 3. Activity Log Controller
- **CRIT**: `@Body() body: { reason: 'logout'|'forced'|'security'; terminatedBy? }` inline -> `TerminateUserSessionsDto`

### 4. Job Queue Controller
- **HIGH**: `@Body() dto: Partial<CreateQueueDto>` no validation -> `UpdateQueueDto`
- **CRIT**: `@Body() dto: CreateJobDto & { scheduledAt }` intersection type -> `ScheduleJobDto`
- **CRIT**: `@Body() dto: CreateJobDto & { cronExpression }` intersection type -> `RecurringJobDto`
- **CRIT**: `@Body() dto: { queueName? }` inline -> `RetryFailedJobsDto`
- **CRIT**: `@Body() dto: { olderThanDays? }` inline -> `PurgeCompletedJobsDto`

### 5. Tenant Configuration Controller (11 endpoints)
- **HIGH**: 11 endpoints using `Partial<ConfigInterface>` or inline `{ field }` types
- All replaced with dedicated DTOs: `UpdateUserLimitsDto`, `UpdateStorageConfigDto`,
  `CheckStorageLimitDto`, `UpdateApiConfigDto`, `ValidateApiKeyDto`, `UpdateWebhookDto`,
  `UpdateTenantSecurityDto`, `IpAddressDto`, `UpdateNotificationConfigDto`,
  `UpdateFeatureFlagsDto`, `UpdateDataRetentionDto`

### 6. Email Template Controller (3 endpoints)
- **CRIT**: `@Body() body: { tenantId; overrides }` -> `CreateTenantOverrideDto`
- **CRIT**: `@Body() body: { bodyHtml; variables }` -> `ValidateTemplateDto`
- **CRIT**: `@Body() body: { recipientEmail; variables }` -> `SendTestEmailDto`

### 7. Settings Controller (5 endpoints)
- **CRIT**: `@Body() body: { updates: [...] }` -> `BulkUpdateSettingsDto`
- **CRIT**: `@Body() body: { smtpHost?; smtpPort?; ... }` inline -> `UpdateEmailConfigDto`
- **CRIT**: `@Body() body: { enabled; message?; allowedIps? }` -> `SetMaintenanceModeDto`
- **CRIT**: `@Body() body: { stripeEnabled?; ... }` -> `UpdateBillingConfigDto`
- **CRIT**: `@Body() body: { data }` -> `ImportSettingsDto`

### 8. Error Tracking Controller (4 endpoints)
- **CRIT**: `@Body() dto: { userId?; notes? }` -> `ResolveErrorGroupDto`
- **CRIT**: `@Body() dto: { assigneeId }` -> `AssignErrorGroupDto`
- **CRIT**: `@Body() dto: { targetId; sourceIds }` -> `MergeErrorGroupsDto`
- **HIGH**: `@Body() dto: Partial<CreateAlertRuleDto> & { isActive? }` -> `UpdateErrorAlertRuleDto`

### 9. Global Settings Controller (7 endpoints)
- **HIGH**: `@Body() dto: Partial<CreateMaintenanceDto>` -> `UpdateMaintenanceDto`
- **CRIT**: `@Body() dto: { additionalMinutes }` -> `ExtendMaintenanceDto`
- **CRIT**: `@Body() dto: { deployedBy }` -> `DeployVersionDto`
- **CRIT**: `@Body() dto: { reason; rolledBackBy }` -> `RollbackVersionDto`
- **CRIT**: `@Body() dto: { updates: Array<...> }` -> `BulkUpdateConfigsDto`
- **CRIT**: `@Req() req: any` -> fixed to `Request` with safe cast

### 10. Performance Controller
- **CRIT**: `@Body() dto: { service; endpoint; method; durationMs; isError }` -> `RecordRequestMetricDto`

### 11. IP Access Controller
- **CRIT**: `@Body() body: { ip; tenantId? }` -> `CheckIpAccessDto`

### 12. Audit Trail Controller
- **HIGH**: `@Body() dto: Partial<CreateAlertRuleDto>` -> `UpdateAuditAlertRuleDto`

### 13. Billing Controller (15+ endpoints)
- **CRIT**: 15+ `@Body('field')` raw extractions replaced with proper DTOs:
  `ComparePlansDto`, `ValidateDiscountCodeDto`, `ApplyDiscountCodeDto`,
  `GenerateDiscountCodeDto`, `BulkCreateDiscountCodesDto`, `CancelSubscriptionDto`,
  `ExtendTrialDto`, `QuickEstimateDto`, `ComparePricingDto`, `RejectCustomPlanDto`,
  `CloneCustomPlanDto`, `MarkInvoicePaidDto`, `VoidInvoiceDto`
- **HIGH**: `@Body() dto: Partial<SetModulePricingDto>` -> `UpdateModulePricingDto`
- **CRIT**: `@Body('moduleIdMap')` raw extraction -> `SeedModulePricingDto`

### 14. Users Controller
- **CRIT**: `@Body('newPassword')` raw extraction -> `ResetPasswordByAdminDto`

## Zero `any` Policy
- All `(req as any).user?.id` patterns across ALL controllers replaced with
  `(req as unknown as { user?: { id?: string } }).user?.id`
- Created `shared/authenticated-request.ts` with type-safe helpers for future use

## MED/LOW - Remaining Items (Not Fixed, Monitoring)
- `global-settings.controller.ts` provisioning-config endpoint uses `Record<string, string>`
  as body type (dynamic key-value store, has runtime validation in handler)
- Pre-existing test failures (15 suites) are NOT caused by these changes -- verified
  by comparing against main branch

## Files Created
- `tenant/dto/provision-tenant.dto.ts`
- `tenant/dto/deactivate-tenant.dto.ts`
- `settings/dto/tenant-configuration.dto.ts` (12 DTO classes)
- `settings/dto/email-template.dto.ts` (3 DTO classes)
- `settings/dto/settings.dto.ts` (5 DTO classes)
- `billing/dto/billing.dto.ts` (15 DTO classes)
- `users/dto/reset-password.dto.ts`
- `shared/authenticated-request.ts` (type-safe auth helpers)

## Files Modified
- 17 controller files
- Zero new test failures introduced
