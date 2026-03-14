# P3: Kontrat Haritaci Raporu

## Yonetici Ozeti

Frontend (adminApi.ts + dogrudan fetch) toplam **~220 API cagrisi** yapar.
Backend 33 controller'da **~300+ endpoint** sunar.

**Kritik bulgular:**
- **3 FIELD_MISMATCH** -- request body field adlari uyusmuyor (query/sql, unpublish/cancel, settings path)
- **~15 ORPHAN_FE** -- Frontend cagiriyor ama backend endpoint yok
- **~25 ORPHAN_BE** -- Backend endpoint var ama frontend hic cagirmiyor
- **1 KRITIK FIELD_MISMATCH** -- QueryEditor `{ schema, query }` gonderiyor, backend `{ sql, params }` bekliyor
- `whitelist: true + forbidNonWhitelisted: true` (main.ts:96-98) nedeniyle FIELD_MISMATCH hatalari 400 Bad Request donecek

---

## Frontend API Cagrilari (adminApi.ts namespace bazinda)

### systemApi
| Fonksiyon | URL | Method | Request Fields |
|-----------|-----|--------|----------------|
| getMetrics | /system/metrics | GET | - |
| getDatabaseMetrics | /system/metrics/database | GET | - |
| getPlatformMetrics | /system/metrics/platform | GET | - |
| getResourceMetrics | /system/metrics/resources | GET | - |
| getServicesHealth | /system/services/health | GET | - |
| getMetricTrends | /system/metrics/trends?metric&interval | GET | - |
| getCircuitBreakers | /health/circuit-breakers | GET | - |
| resetCircuitBreaker | /health/circuit-breakers/:name/reset | POST | - |

### analyticsApi
| Fonksiyon | URL | Method |
|-----------|-----|--------|
| getDashboardSummary | /analytics/dashboard | GET |
| getKpiComparisons | /analytics/kpi-comparisons | GET |
| getTenantMetrics | /analytics/tenants | GET |
| getTenantGrowthTrend | /analytics/tenants/growth | GET |
| getRevenueAnalytics | /analytics/revenue | GET |
| getRevenueByPlan | /analytics/revenue/by-plan | GET |
| getRevenueTrend | /analytics/revenue/trend | GET |
| getUsageAnalytics | /analytics/usage | GET |
| getApiUsageByEndpoint | /analytics/usage/api | GET |
| getEngagementMetrics | /analytics/engagement | GET |
| getFeatureUsage | /analytics/engagement/features | GET |
| getGeographicDistribution | /analytics/geographic | GET |
| getTenantChurn | /analytics/tenants/churn | GET |
| getUserMetrics | /analytics/users | GET |
| getUserActivity | /analytics/users/activity | GET |
| getUserHeatmap | /analytics/users/heatmap | GET |
| getModuleUsageAnalytics | /analytics/usage/modules | GET |
| getFeatureAdoption | /analytics/usage/features | GET |
| getFinancialMetrics | /analytics/financial | GET |
| getFinancialRevenue | /analytics/financial/revenue | GET |
| getFinancialByPlan | /analytics/financial/by-plan | GET |
| getSystemAnalytics | /analytics/system | GET |
| getSystemApiCallsTrend | /analytics/system/api-calls | GET |
| getSystemErrorsTrend | /analytics/system/errors | GET |
| getAnalyticsSnapshots | /analytics/snapshots | GET |

### databaseApi
| Fonksiyon | URL | Method |
|-----------|-----|--------|
| getSchemas | /database/schemas | GET |
| getSchema | /database/schemas/:tenantId | GET |
| createSchema | /database/schemas | POST |
| deleteSchema | /database/schemas/:tenantId | DELETE |
| resetSchema | /database/schemas/:tenantId/reset | POST |
| optimizeSchema | /database/schemas/:tenantId/optimize | POST |
| analyzeSchema | /database/schemas/:tenantId/analyze | GET |
| getMigrations | /database/migrations | GET |
| getMigration | /database/migrations/:id | GET |
| createMigration | /database/migrations | POST |
| runMigration | /database/migrations/:id/run | POST |
| rollbackMigration | /database/migrations/:id/rollback | POST |
| getPendingMigrations | /database/migrations/pending | GET |
| getBackups | /database/backups | GET |
| getBackup | /database/backups/:id | GET |
| createBackup | /database/backups | POST |
| restoreBackup | /database/backups/:id/restore | POST |
| deleteBackup | /database/backups/:id | DELETE |
| scheduleBackup | /database/backups/schedule | POST |
| getDatabaseStats | /database/monitoring/stats | GET |
| getSlowQueries | /database/monitoring/slow-queries | GET |
| getConnectionStats | /database/monitoring/connections | GET |
| getTableStats | /database/monitoring/tables | GET |
| runVacuum | /database/monitoring/vacuum | POST |
| runAnalyze | /database/monitoring/analyze | POST |

### settingsApi
| Fonksiyon | URL | Method |
|-----------|-----|--------|
| getAll | /settings | GET |
| getByCategory | /settings/category/:cat | GET |
| get | /settings/:key | GET |
| update | /settings/:key | PUT |
| bulkUpdate | /settings/bulk | PUT |
| getEmailConfig | /settings/config/email | GET |
| updateEmailConfig | /settings/config/email | PUT |
| testEmailConfig | /settings/config/email/test | POST |
| getSecurityConfig | /settings/config/security | GET |
| updateSecurityConfig | /settings/config/security | PUT |
| getBillingConfig | /settings/config/billing | GET |
| updateBillingConfig | /settings/config/billing | PUT |
| getRateLimits | /settings/config/rate-limits | GET |
| updateRateLimits | /settings/config/rate-limits | PUT |
| getSystemInfo | /settings/system/info | GET |

### Dogrudan fetch cagrilari (adminApi.ts disinda)

| Dosya | URL | Method | Body Fields |
|-------|-----|--------|-------------|
| QueryEditor.tsx | /api/database/explorer/schemas | GET | - |
| QueryEditor.tsx | /api/database/explorer/query | POST | `{ schema, query }` |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas | GET | - |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables | GET | - |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables/:t/data | GET | - |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables/:t/rows | POST | `{ data }` |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables/:t/rows/:id | PUT | `{ data }` |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables/:t/rows/:id | DELETE | - |
| DatabaseExplorerPage.tsx | /api/database/explorer/schemas/:s/tables/:t/export | GET | - |
| SchemaSelector.tsx | /api/database/explorer/schemas/categorized | GET | - |
| SchemaStatistics.tsx | /api/database/explorer/schemas/:s/statistics | GET | - |
| RowEditor.tsx | /api/database/explorer/schemas/:s/tables/:t/columns/:c/values | GET | - |
| DataGrid.tsx | /api/database/explorer/schemas/:s/tables/:t/data | GET | - |
| TableList.tsx | /api/database/explorer/schemas/:s/tables | GET | - |
| useUserPermissions.ts | /api/users/permission-categories | GET | - |
| useUserPermissions.ts | /api/users/tenant/users-with-permissions | GET | - |
| useUserPermissions.ts | /api/users/tenant/invite | POST | `{ email, firstName, lastName, permissions, sendInvitationEmail }` |
| useUserPermissions.ts | /api/users/:id/permissions | PUT | `{ permissions }` |
| useUserPermissions.ts | /api/users/:id/permissions | GET | - |
| AnnouncementsPage.tsx | /api/support/announcements/stats | GET | - |
| AnnouncementsPage.tsx | /api/support/announcements/:id/acknowledgments | GET | - |
| ActivityLogPage.tsx | /api/security/activities/stats/overview | GET | - |
| AuditTrailPage.tsx | /api/security/audit/summary | GET | - |
| AuditTrailPage.tsx | /api/security/audit/alert-rules | GET | - |
| CompliancePage.tsx | /api/security/compliance/checks/:framework | GET | - |
| BillingDashboardPage.tsx | /api/billing/invoices?limit=5 | GET | - |

---

## Uyumsuzluklar

### FIELD_MISMATCH (Kritik)

| # | Frontend | Backend | Sorun | Etki |
|---|----------|---------|-------|------|
| 1 | QueryEditor.tsx: `POST /database/explorer/query` body: `{ schema, query }` | explorer.controller.ts: ExecuteQueryDto expects `{ sql, params }` | Frontend `query` field gonderiyor, backend `sql` field bekliyor | **400 Bad Request** -- `forbidNonWhitelisted: true` nedeniyle `query` field'i reddedilir, `sql` zorunlu ama eksik. Sorgu motoru tamamen calismiyor. |
| 2 | supportApi.unpublishAnnouncement: `POST /:id/unpublish` | announcement.controller.ts: `POST /:id/cancel` | Endpoint adi farkli | **404 Not Found** -- `/unpublish` backend'de yok, `/cancel` var |
| 3 | settingsApi.get(key): `GET /settings/${key}` | settings.controller.ts: `GET /settings/key/:key` | Path segment farkli -- FE `/settings/myKey`, BE `/settings/key/myKey` | **Potansiyel 404** -- Eger key bir route ile cakismazsa (ornegin `category`, `config`, `bulk` degillerse) NestJS catch-all ile eslesmeyecek. `system/info`, `config/*`, `category/*` gibi sabit path'lerle cakisma olabilir. |

### ORPHAN_FE (Frontend cagiriyor, backend endpoint yok)

| # | Frontend Cagrisi | Beklenen BE Path | Durum |
|---|------------------|------------------|-------|
| 1 | `analyticsApi.getApiUsageByEndpoint` | `/analytics/usage/api` | BE'de `/analytics/usage/api` endpoint yok |
| 2 | `analyticsApi.getEngagementMetrics` | `/analytics/engagement` | BE'de `/analytics/engagement` endpoint yok |
| 3 | `analyticsApi.getFeatureUsage` | `/analytics/engagement/features` | BE'de yok |
| 4 | `analyticsApi.getGeographicDistribution` | `/analytics/geographic` | BE'de yok |
| 5 | `databaseApi.resetSchema` | `/database/schemas/:id/reset` | BE'de yok (suspend/activate var) |
| 6 | `databaseApi.optimizeSchema` | `/database/schemas/:id/optimize` | BE'de yok |
| 7 | `databaseApi.analyzeSchema` | `/database/schemas/:id/analyze` | BE'de yok |
| 8 | `databaseApi.getDatabaseStats` | `/database/monitoring/stats` | BE'de `/database/monitoring/health` var, `stats` yok |
| 9 | `databaseApi.getTableStats` | `/database/monitoring/tables` | BE'de yok |
| 10 | `databaseApi.runVacuum` | `/database/monitoring/vacuum` | BE'de yok |
| 11 | `databaseApi.runAnalyze` | `/database/monitoring/analyze` | BE'de yok |
| 12 | `databaseApi.scheduleBackup` | `/database/backups/schedule` | BE'de `backups/schedule` GET var (status), POST yok |
| 13 | `databaseApi.getMigrations` (list) | `/database/migrations` | BE'de `/database/migrations` list yok, `history` var |
| 14 | `databaseApi.createMigration` | `POST /database/migrations` | BE'de dogrudan create yok; `tenant/:id/run` ve `batch/run` var |
| 15 | `databaseApi.runMigration` | `POST /database/migrations/:id/run` | BE path farkli: `tenant/:tenantId/run` |
| 16 | `databaseApi.rollbackMigration` | `POST /database/migrations/:id/rollback` | BE path farkli: `tenant/:tenantId/rollback` |
| 17 | `databaseApi.getPendingMigrations` | `/database/migrations/pending` | BE: `tenant/:tenantId/pending` |
| 18 | `databaseApi.restoreBackup` | `POST /database/backups/:id/restore` | BE: `POST /database/backups/restore` (body icinde backupId) |
| 19 | `settingsApi.testEmailConfig` | `POST /settings/config/email/test` | BE'de yok |
| 20 | `settingsApi.updateSecurityConfig` | `PUT /settings/config/security` | BE'de sadece GET var, PUT yok |
| 21 | `settingsApi.updateRateLimits` | `PUT /settings/config/rate-limits` | BE'de sadece GET var, PUT yok |
| 22 | `settingsApi.update(key)` | `PUT /settings/${key}` | BE: `PUT /settings/key/:key` |
| 23 | SchemaSelector.tsx | `GET /database/explorer/schemas/categorized` | BE'de yok |
| 24 | SchemaStatistics.tsx | `GET /database/explorer/schemas/:s/statistics` | BE'de yok |
| 25 | RowEditor.tsx | `GET /database/explorer/schemas/:s/tables/:t/columns/:c/values` | BE'de yok |
| 26 | `supportApi.closeTicket` | `POST /support/tickets/:id/close` | BE'de yok (status endpoint ile kapatilabilir) |
| 27 | `impersonationApi.checkPermission` | `GET /impersonation/permissions/check?tenantId&adminId` | BE path farkli: `GET /impersonation/permissions/:superAdminId/check/:tenantId` |
| 28 | `impersonationApi.extendSession` | `POST /impersonation/sessions/:id/extend` | BE'de yok |
| 29 | `impersonationApi.revokeSession` | `POST /impersonation/sessions/:id/revoke` | BE: `sessions/:id/terminate` |
| 30 | `systemSettingsApi.drainQueue` | `POST /system/jobs/queues/:name/drain` | BE'de yok |
| 31 | `systemSettingsApi.getScheduledJobs` | `GET /system/jobs/scheduled` | BE'de yok (genel list ile filtrelenir) |
| 32 | `systemSettingsApi.getFailedJobs` | `GET /system/jobs/failed` | BE'de yok |
| 33 | `systemSettingsApi.cleanupJobs` | `POST /system/jobs/cleanup` | BE: `POST /system/jobs/purge-completed` (farkli path ve anlam) |

### ORPHAN_BE (Backend endpoint var, frontend cagirmiyor)

| # | Backend Endpoint | Controller |
|---|------------------|------------|
| 1 | `GET /database/monitoring/health` | monitoring.controller |
| 2 | `GET /database/monitoring/query-performance` | monitoring.controller |
| 3 | `POST /database/monitoring/analyze-query` | monitoring.controller |
| 4 | `GET /database/monitoring/storage` | monitoring.controller |
| 5 | `GET /database/monitoring/storage/by-tenant` | monitoring.controller |
| 6 | `GET /database/monitoring/index-recommendations` | monitoring.controller |
| 7 | `GET /database/monitoring/metrics` | monitoring.controller |
| 8 | `GET /database/schemas/summary` | schema.controller |
| 9 | `GET /database/schemas/:id/info` | schema.controller |
| 10 | `POST /database/schemas/sync` | schema.controller |
| 11 | `POST /database/schemas/:id/suspend` | schema.controller |
| 12 | `POST /database/schemas/:id/activate` | schema.controller |
| 13 | `GET /database/schemas/:id/validate` | schema.controller |
| 14 | `POST /database/schemas/:id/refresh-stats` | schema.controller |
| 15 | `GET /database/schemas/connections/pool` | schema.controller |
| 16 | `GET /database/schemas/connections/by-tenant` | schema.controller |
| 17 | `GET /database/backups/summary` | backup.controller |
| 18 | `GET /database/backups/tenant/:tenantId` | backup.controller |
| 19 | `POST /database/backups/restore/point-in-time` | backup.controller |
| 20 | `GET /database/migrations/available` | migration.controller |
| 21 | `GET /database/migrations/summary` | migration.controller |
| 22 | `POST /database/migrations/batch/run` | migration.controller |
| 23 | `GET /database/migrations/batch/:version/status` | migration.controller |
| 24 | `GET /database/explorer/tables` (public shortcut) | explorer.controller |
| 25 | `GET /database/explorer/tables/:table/data` | explorer.controller |
| 26 | `GET /database/explorer/schemas/:s/tables/:t/structure` | explorer.controller |
| 27 | `POST /tenants/:id/provision` | tenant.controller |
| 28 | `GET /tenants/:id/provision/status` | tenant.controller |
| 29 | `GET /health/metrics` | health.controller |
| 30 | `GET /health/live` | health.controller |
| 31 | `GET /health/ready` | health.controller |
| 32 | `GET /health/startup` | health.controller |
| 33 | `POST /security/activities` (log creation) | activity-log.controller |
| 34 | `GET /security/activities/login-attempts/:ip` | activity-log.controller |
| 35 | `GET /security/activities/sessions/user/:userId` | activity-log.controller |
| 36 | `POST /security/activities/sessions/user/:userId/terminate` | activity-log.controller |
| 37 | `POST /security/audit/export` | audit-trail.controller |
| 38 | `GET /security/audit/retention-stats` | audit-trail.controller |
| 39 | `POST /security/audit/retention-policies/apply` | audit-trail.controller |
| 40 | Cok sayida system-management version/config/threshold endpointleri | global-settings.controller |
| 41 | Cok sayida tenant-configuration alt-endpointleri (domain, branding, security, notifications, features, data-retention) | tenant-configuration.controller |

### TYPE_MISMATCH

| # | Endpoint | Sorun |
|---|----------|-------|
| 1 | `POST /database/explorer/query` | FE: response `{ rows, rowCount, columns }` bekliyor. BE: columns donmuyor, sadece `{ rows, rowCount }` donuyor |
| 2 | `GET /database/backups` | FE: `PaginatedResult<DatabaseBackup>` bekliyor (type, status, sizeBytes...). BE: CreateBackupDto farkli field adlari (`backupType` vs `type`) |
| 3 | `GET /database/schemas` | FE: `PaginatedResult<TenantSchema>` (currentVersion, lastMigrationAt...). BE: SchemaManagement entity farkli field seti |
| 4 | `settingsApi.update` | FE: `PUT /settings/${key}` body `{ value, updatedBy }`. BE: `PUT /settings/key/:key` body farkli DTO (UpdateSystemSettingDto) |
| 5 | `billingApi.getInvoices` | FE: `{ invoices, total }` bekliyor. BE: paginated format farkli olabilir |

---

## Eslestirme Ozeti (Namespace Bazinda)

| Namespace | FE Fonksiyon | BE Eslesen | ORPHAN_FE | ORPHAN_BE | MISMATCH |
|-----------|-------------|-----------|-----------|-----------|----------|
| systemApi | 8 | 8 | 0 | 4 (health alt) | 0 |
| analyticsApi | 25 | 21 | 4 | 0 | 0 |
| reportsApi | 12 | 12 | 0 | ~8 | 0 |
| databaseApi | 24 | ~8 | ~16 | ~16 | 2 |
| supportApi | ~40 | ~38 | 2 | ~5 | 1 |
| securityApi | ~25 | ~23 | 0 | ~6 | 0 |
| systemSettingsApi | ~35 | ~30 | ~5 | ~15 | 0 |
| impersonationApi | ~15 | ~12 | 3 | ~3 | 0 |
| debugApi | ~20 | ~20 | 0 | ~3 | 0 |
| settingsApi | ~22 | ~15 | ~5 | ~10 | 2 |
| tenantsApi | ~18 | ~18 | 0 | 2 | 0 |
| usersApi | ~20 | ~20 | 0 | 0 | 0 |
| modulesApi | ~12 | ~12 | 0 | 0 | 0 |
| auditApi | 5 | 5 | 0 | 0 | 0 |
| billingApi | ~40 | ~38 | 0 | ~3 | 1 |
| Dogrudan fetch | ~17 | ~10 | ~7 | - | 1 |

---

## Bulgular + Spawn Talepleri

### Kritik (Hemen duzeltilmeli)

1. **[FIELD_MISMATCH] QueryEditor `query` vs `sql`**: `QueryEditor.tsx` satir 82: `body: JSON.stringify({ schema, query })` gonderiyor. Backend `ExecuteQueryDto` (explorer.controller.ts satir 182-188) `sql` field'i bekliyor. `forbidNonWhitelisted: true` nedeniyle `query` field reddedilir ve `sql` zorunlu oldugu icin **400 Bad Request** doner. SQL sorgu motoru tamamen kirik.
   - **Duzeltme**: QueryEditor.tsx'te `query` -> `sql` yap, veya backend DTO'ya `query` alias ekle.

2. **[FIELD_MISMATCH] Announcement unpublish vs cancel**: `supportApi.unpublishAnnouncement` `POST /:id/unpublish` cagiriyor. Backend'de bu endpoint yok; `POST /:id/cancel` var. **404 doner**.
   - **Duzeltme**: Frontend'te `unpublishAnnouncement` -> `cancelAnnouncement` yap ve path'i `/cancel` olarak guncelle.

3. **[ORPHAN_FE] 3 DB Explorer bileseninde eksik endpoint**: `schemas/categorized`, `schemas/:s/statistics`, `schemas/:s/tables/:t/columns/:c/values` -- bu 3 endpoint backend'de yok. SchemaSelector, SchemaStatistics ve RowEditor FK lookup bozuk.

### Yuksek

4. **[FIELD_MISMATCH] Settings path kaymasi**: Frontend `/settings/${key}` cagiriyor, backend `/settings/key/:key` bekliyor. `get`, `update` fonksiyonlari etkileniyor.

5. **[ORPHAN_FE] Database Monitoring**: `stats`, `tables`, `vacuum`, `analyze` -- 4 endpoint frontend'in beklediginden farkli path/isimle var veya hic yok.

6. **[ORPHAN_FE] Database Migration path farki**: Frontend `migrations/:id/run`, backend `migrations/tenant/:tenantId/run` -- tamamen farkli parametrizasyon.

7. **[ORPHAN_FE] Impersonation path farklari**: `checkPermission` query param vs path param, `extendSession` yok, `revokeSession` vs `terminate`.

8. **[TYPE_MISMATCH] Query response**: Frontend `columns` array bekliyor, backend dondurmuyor.

### Orta

9. **[ORPHAN_FE] Ticket close endpoint yok**: Frontend `POST /support/tickets/:id/close` cagiriyor, backend'de bu yok. `POST /:id/status` ile status degisikligini yapmak gerekir.

10. **[ORPHAN_FE] Settings config PUT'lari**: `updateSecurityConfig`, `updateRateLimits`, `testEmailConfig` -- backend'de sadece GET var.

### Spawn Talepleri

- **P4 (Fixer)**: `QueryEditor.tsx` satir 82'de `query` -> `sql` duzeltmesi
- **P4 (Fixer)**: `adminApi.ts` `unpublishAnnouncement` path'ini `/cancel` olarak guncelle
- **P4 (Fixer)**: `settingsApi.get` ve `settingsApi.update` path'lerini `/settings/key/${key}` olarak duzelt
- **P5 (Backend)**: `schemas/categorized`, `schemas/:s/statistics`, `columns/:c/values` endpointlerini explorer.controller'a ekle
- **P5 (Backend)**: Database monitoring/migration endpoint'lerini frontend'in bekledigiyle uyumlastir
- **P5 (Backend)**: Impersonation endpoint path'lerini uyumlastir
