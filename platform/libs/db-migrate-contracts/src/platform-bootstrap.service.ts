import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { SCHEMA_REGISTRY, type SchemaRegistryRole } from './schema-registry';

export const PLATFORM_BOOTSTRAP_SERVICE_ROLE_PASS_ENV_BY_ROLE = {
  auth_service: 'AUTH_SERVICE_DB_PASS',
  farm_service: 'FARM_SERVICE_DB_PASS',
  sensor_service: 'SENSOR_SERVICE_DB_PASS',
  hr_service: 'HR_SERVICE_DB_PASS',
  messaging_service: 'MESSAGING_SERVICE_DB_PASS',
  hydroponics_service: 'HYDROPONICS_SERVICE_DB_PASS',
  alert_service: 'ALERT_SERVICE_DB_PASS',
  billing_service: 'BILLING_SERVICE_DB_PASS',
  notification_service: 'NOTIFICATION_SERVICE_DB_PASS',
  ai_service: 'AI_SERVICE_DB_PASS',
  admin_service: 'ADMIN_SERVICE_DB_PASS',
  config_service: 'CONFIG_SERVICE_DB_PASS',
  observability_service: 'OBSERVABILITY_SERVICE_DB_PASS',
  event_store_service: 'EVENT_STORE_SERVICE_DB_PASS',
  gateway_service: 'GATEWAY_SERVICE_DB_PASS',
} satisfies Record<SchemaRegistryRole, string>;

export const PLATFORM_BOOTSTRAP_SERVICE_ROLE_PASS_ENVS = SCHEMA_REGISTRY.map(
  ({ role }) => PLATFORM_BOOTSTRAP_SERVICE_ROLE_PASS_ENV_BY_ROLE[role],
);

export const CROSS_SERVICE_BOOTSTRAP_SCHEMAS = ['shared', 'compliance'] as const;

export const PLATFORM_BOOTSTRAP_SCHEMAS: readonly string[] = [
  ...SCHEMA_REGISTRY.map(({ schema }) => schema),
  ...CROSS_SERVICE_BOOTSTRAP_SCHEMAS,
];

export const PLATFORM_BOOTSTRAP_FUNCTIONS = [
  'current_tenant_id',
  'set_tenant_id',
  'update_updated_at_column',
  'audit_immutability_guard',
] as const;

export const PLATFORM_BOOTSTRAP_SHARED_SCHEMA_TABLES = [
  'audit_logs',
  'gdpr_data_requests',
  'user_consents',
  'user_permissions',
  'access_logs',
] as const;

export interface PlatformBootstrapOptions {
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    ssl?: PostgresConnectionOptions['ssl'];
  };
  /** Absolute path to apps/db-migrate/src/sql/platform-bootstrap/. */
  sqlDir: string;
  /** Structured JSON logger (matches main.ts log function shape). */
  log: (record: Record<string, unknown>) => void;
  /** Optional bootstrap version label (git SHA / image tag). */
  version?: string;
  /** Advisory-lock acquisition timeout, seconds. Default 300. */
  lockTimeoutSeconds?: number;
}

export interface PlatformBootstrapResult {
  schemaCount: number;
  functionCount: number;
  sharedTableCount: number;
  durationMs: number;
  stagesApplied: string[];
}
