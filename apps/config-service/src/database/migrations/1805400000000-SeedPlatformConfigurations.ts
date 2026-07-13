import { RLS_TENANT_GUC } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { SYSTEM_TENANT_ID } from '../../configuration/configuration.constants';

/**
 * ORPHAN-HIGH-373 — seed the platform-scope configuration vocabulary.
 *
 * WHY: admin-api's three legacy config stores were retired to config-service
 * (their write paths return 410 Gone and `admin.system_settings` was dropped by
 * admin-api migration 1801400000000), but the replacement store shipped EMPTY —
 * config-service had a complete engine and zero rows, so the platform settings
 * surface had no data to serve. This migration moves the surviving code-side
 * seed vocabulary (`DEFAULT_SYSTEM_SETTINGS` in
 * apps/admin-api-service/src/settings/entities/system-setting.entity.ts) into
 * `config.configurations` as SYSTEM-tenant rows under the `platform` service
 * namespace, which the admin-panel reads via the federated
 * `effectiveConfigurationsByService(service: "platform")` query.
 *
 * Column mapping (vocabulary field -> configurations column):
 *   key/value/description  -> key/value/description verbatim
 *   valueType              -> value_type ('encrypted' maps to 'secret' + is_secret)
 *   category               -> category (SettingCategory string values verbatim)
 *   isPublic / isReadOnly / requiresRestart
 *                          -> tags ('public' / 'read-only' / 'requires-restart')
 *   displayName            -> intentionally NOT persisted: it is presentation-layer
 *                             metadata and the admin-panel owns its field labels.
 *
 * Idempotent: ON CONFLICT on the (tenant_id, service, key, environment) unique
 * constraint DOES NOTHING, so replays never clobber operator-edited values.
 */

export const PLATFORM_CONFIGURATION_SERVICE = 'platform';

export type PlatformSeedValueType = 'string' | 'number' | 'boolean' | 'json' | 'secret';

export interface PlatformConfigurationSeedRow {
  readonly key: string;
  readonly value: string;
  readonly valueType: PlatformSeedValueType;
  readonly category: string;
  readonly description: string;
  readonly tags: readonly string[] | null;
}

/**
 * Faithful derivation of DEFAULT_SYSTEM_SETTINGS (35 entries) — validated by
 * apps/config-service/src/database/__tests__/platform-configuration-seed.spec.ts.
 */
export const PLATFORM_CONFIGURATION_SEED: readonly PlatformConfigurationSeedRow[] = [
  // ── General ──
  {
    key: 'platform.name',
    value: 'Aquaculture Platform',
    valueType: 'string',
    category: 'general',
    description: 'Platform display name',
    tags: ['public'],
  },
  {
    key: 'platform.version',
    value: '1.0.0',
    valueType: 'string',
    category: 'general',
    description: 'Current platform version',
    tags: ['public', 'read-only'],
  },
  {
    key: 'platform.environment',
    value: 'production',
    valueType: 'string',
    category: 'general',
    description: 'Deployment environment',
    tags: ['read-only'],
  },
  {
    key: 'platform.timezone',
    value: 'UTC',
    valueType: 'string',
    category: 'general',
    description: 'Default timezone',
    tags: null,
  },
  {
    key: 'platform.locale',
    value: 'en-US',
    valueType: 'string',
    category: 'general',
    description: 'Default locale',
    tags: null,
  },

  // ── Security ──
  {
    key: 'security.session_timeout_minutes',
    value: '480',
    valueType: 'number',
    category: 'security',
    description: 'Session timeout in minutes',
    tags: null,
  },
  {
    key: 'security.max_login_attempts',
    value: '5',
    valueType: 'number',
    category: 'security',
    description: 'Maximum login attempts before lockout',
    tags: null,
  },
  {
    key: 'security.lockout_duration_minutes',
    value: '30',
    valueType: 'number',
    category: 'security',
    description: 'Account lockout duration in minutes',
    tags: null,
  },
  {
    key: 'security.password_min_length',
    value: '8',
    valueType: 'number',
    category: 'security',
    description: 'Minimum password length',
    tags: null,
  },
  {
    key: 'security.mfa_enabled',
    value: 'true',
    valueType: 'boolean',
    category: 'security',
    description: 'Enable MFA support platform-wide',
    tags: null,
  },
  {
    key: 'security.enforce_https',
    value: 'true',
    valueType: 'boolean',
    category: 'security',
    description: 'Force HTTPS connections',
    tags: null,
  },

  // ── Email ──
  {
    key: 'email.smtp_host',
    value: '',
    valueType: 'string',
    category: 'email',
    description: 'SMTP server hostname',
    tags: null,
  },
  {
    key: 'email.smtp_port',
    value: '587',
    valueType: 'number',
    category: 'email',
    description: 'SMTP server port',
    tags: null,
  },
  {
    key: 'email.smtp_secure',
    value: 'false',
    valueType: 'boolean',
    category: 'email',
    description: 'Use TLS for SMTP (false for port 587 STARTTLS, true for port 465 SSL)',
    tags: null,
  },
  {
    key: 'email.smtp_username',
    value: '',
    valueType: 'string',
    category: 'email',
    description: 'SMTP username',
    tags: null,
  },
  {
    key: 'email.smtp_password',
    value: '',
    valueType: 'secret',
    category: 'email',
    description: 'SMTP password (encrypted)',
    tags: null,
  },
  {
    key: 'email.from_address',
    value: 'noreply@aquaculture.io',
    valueType: 'string',
    category: 'email',
    description: 'Default from email address',
    tags: null,
  },
  {
    key: 'email.from_name',
    value: 'Aquaculture Platform',
    valueType: 'string',
    category: 'email',
    description: 'Default from name',
    tags: null,
  },

  // ── Rate limits ──
  {
    key: 'rate_limit.global_rpm',
    value: '1000',
    valueType: 'number',
    category: 'rate_limit',
    description: 'Global requests per minute',
    tags: null,
  },
  {
    key: 'rate_limit.per_user_rpm',
    value: '100',
    valueType: 'number',
    category: 'rate_limit',
    description: 'Per-user requests per minute',
    tags: null,
  },
  {
    key: 'rate_limit.per_tenant_rpm',
    value: '500',
    valueType: 'number',
    category: 'rate_limit',
    description: 'Per-tenant requests per minute',
    tags: null,
  },
  {
    key: 'rate_limit.api_key_rpm',
    value: '60',
    valueType: 'number',
    category: 'rate_limit',
    description: 'API key requests per minute',
    tags: null,
  },

  // ── Storage ──
  {
    key: 'storage.provider',
    value: 'minio',
    valueType: 'string',
    category: 'storage',
    description: 'Storage provider (minio, s3, azure)',
    tags: ['requires-restart'],
  },
  {
    key: 'storage.max_file_size_mb',
    value: '100',
    valueType: 'number',
    category: 'storage',
    description: 'Maximum file upload size in MB',
    tags: null,
  },
  {
    key: 'storage.allowed_extensions',
    value: '["pdf","doc","docx","xls","xlsx","csv","jpg","jpeg","png","gif","mp4"]',
    valueType: 'json',
    category: 'storage',
    description: 'Allowed file extensions',
    tags: null,
  },

  // ── Maintenance ──
  {
    key: 'maintenance.mode_enabled',
    value: 'false',
    valueType: 'boolean',
    category: 'maintenance',
    description: 'Enable maintenance mode',
    tags: null,
  },
  {
    key: 'maintenance.message',
    value: 'System is under maintenance. Please try again later.',
    valueType: 'string',
    category: 'maintenance',
    description: 'Maintenance message shown to users',
    tags: null,
  },
  {
    key: 'maintenance.allowed_ips',
    value: '[]',
    valueType: 'json',
    category: 'maintenance',
    description: 'IPs allowed during maintenance',
    tags: null,
  },

  // ── Billing ──
  {
    key: 'billing.stripe_enabled',
    value: 'false',
    valueType: 'boolean',
    category: 'billing',
    description: 'Enable Stripe payments',
    tags: null,
  },
  {
    key: 'billing.default_currency',
    value: 'USD',
    valueType: 'string',
    category: 'billing',
    description: 'Default currency for billing',
    tags: null,
  },
  {
    key: 'billing.tax_rate',
    value: '0',
    valueType: 'number',
    category: 'billing',
    description: 'Default tax rate percentage',
    tags: null,
  },
  {
    key: 'billing.invoice_due_days',
    value: '30',
    valueType: 'number',
    category: 'billing',
    description: 'Days until invoice is due',
    tags: null,
  },

  // ── Feature flags ──
  {
    key: 'feature.swagger_enabled',
    value: 'true',
    valueType: 'boolean',
    category: 'feature_flag',
    description: 'Enable Swagger API documentation',
    tags: null,
  },
  {
    key: 'feature.graphql_playground',
    // 2026-04-30 vocabulary decision preserved: the deprecated GraphQL
    // Playground stays disabled by default.
    value: 'false',
    valueType: 'boolean',
    category: 'feature_flag',
    description:
      'Deprecated GraphQL Playground is disabled; use supported GraphQL tooling through the gateway policy.',
    tags: null,
  },
  {
    key: 'feature.registration_enabled',
    value: 'true',
    valueType: 'boolean',
    category: 'feature_flag',
    description: 'Allow new user registration',
    tags: null,
  },
];

/** Attribution recorded in created_by/updated_by for seeded rows. */
const SEED_ACTOR = 'seed:platform-configurations';

const INSERT_SEED_ROW_SQL =
  `INSERT INTO "config"."configurations" ` +
  `("tenant_id","service","key","value","value_type","environment","description",` +
  `"is_secret","is_active","category","tags","created_by","updated_by","version") ` +
  `VALUES ($1,$2,$3,$4,$5::"config"."configurations_value_type_enum",` +
  `'all'::"config"."configurations_environment_enum",$6,$7,true,$8,$9,$10,$10,1) ` +
  `ON CONFLICT ("tenant_id","service","key","environment") DO NOTHING`;

export class SeedPlatformConfigurations1805400000000 implements MigrationInterface {
  name = 'SeedPlatformConfigurations1805400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // `config.configurations` carries a FORCE row-level-security policy keyed on
    // the app.current_tenant GUC. The migration runner has no request context,
    // so scope this transaction to the SYSTEM tenant explicitly — the seed rows
    // are SYSTEM-tenant rows, and a restricted migration role would otherwise be
    // denied by the deny-by-default policy. Transaction-local (is_local = true),
    // so nothing leaks past this migration.
    await queryRunner.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, SYSTEM_TENANT_ID]);

    for (const row of PLATFORM_CONFIGURATION_SEED) {
      await queryRunner.query(INSERT_SEED_ROW_SQL, [
        SYSTEM_TENANT_ID,
        PLATFORM_CONFIGURATION_SERVICE,
        row.key,
        row.value,
        row.valueType,
        row.description,
        row.valueType === 'secret',
        row.category,
        row.tags === null ? null : [...row.tags],
        SEED_ACTOR,
      ]);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SELECT set_config($1, $2, true)`, [RLS_TENANT_GUC, SYSTEM_TENANT_ID]);

    await queryRunner.query(
      `DELETE FROM "config"."configurations" WHERE "tenant_id" = $1 AND "service" = $2 AND "key" = ANY($3)`,
      [
        SYSTEM_TENANT_ID,
        PLATFORM_CONFIGURATION_SERVICE,
        PLATFORM_CONFIGURATION_SEED.map((row) => row.key),
      ],
    );
  }
}
