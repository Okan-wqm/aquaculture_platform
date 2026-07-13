/**
 * Config vocabulary enums for the admin system-management surface.
 *
 * The former `GlobalConfig` TypeORM entity + its `global_configs` table are
 * RETIRED: admin-api no longer persists global configuration directly —
 * config-service's effective-configuration APIs own that, and
 * `GlobalSettingsService.createConfig` / `updateConfig` / `bulkUpdateConfigs` /
 * `updateProvisioningConfig` now return 410 Gone. The entity class had already
 * lost its `@Entity()` decorator (it mapped to no table, was in no repository,
 * and no migration created it), so it was dead weight; it is removed here.
 *
 * These two enums remain because the retired-but-present config DTO/query surface
 * (`GlobalSettingsController`) still types its `category` / `valueType` fields
 * against them. NOTHING in this file carries `@Entity` — it maps to no table.
 * (Filename kept as-is to avoid churning four import sites; see ORPHAN-LOW-354
 * for the optional rename to a non-`.entity` name.)
 */
export enum ConfigCategory {
  API = 'api',
  DATABASE = 'database',
  CACHE = 'cache',
  SECURITY = 'security',
  EMAIL = 'email',
  STORAGE = 'storage',
  INTEGRATION = 'integration',
  NOTIFICATION = 'notification',
  PERFORMANCE = 'performance',
  FEATURE = 'feature',
  SYSTEM = 'system',
  PROVISIONING = 'provisioning',
}

export enum ConfigValueType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  JSON = 'json',
  ARRAY = 'array',
  SECRET = 'secret',
  URL = 'url',
  EMAIL = 'email',
  DURATION = 'duration',
}
