/**
 * Platform service catalog.
 *
 * This is the cross-surface service inventory SSOT. Local manifests such as
 * schema registry, compose criticality, boot signals, image matrices, and Nx
 * project metadata must either derive from or validate against these records.
 */

export type PlatformServiceKind =
  | 'backend'
  | 'frontend'
  | 'infrastructure'
  | 'migration-job';

export type PlatformDeploymentStatus =
  | 'deployed'
  | 'profiled'
  | 'notDeployed';

export type PlatformCriticalityLevel =
  | 'critical'
  | 'required'
  | 'warning'
  | 'ignored';

export interface PlatformServiceCatalogEntry {
  /** Compose/Nx/service identity used across deploy tooling. */
  name: string;
  kind: PlatformServiceKind;
  deploymentStatus: PlatformDeploymentStatus;
  /** PostgreSQL schema owned by this service, if any. */
  schema?: string;
  /** True when the schema must be present in apps/db-migrate SCHEMA_REGISTRY. */
  schemaOwner?: boolean;
  /** Criticality entry expected when deploymentStatus !== notDeployed. */
  criticality?: PlatformCriticalityLevel;
  /** Profile-gated compose metadata expected in service-criticality.yaml. */
  profiles?: readonly string[];
  /** Boot signals expected when deploymentStatus !== notDeployed. */
  requiredSignals?: readonly string[];
  /** Nx project name when this service maps to an Nx project. */
  nxProject?: string;
  /** Explicit note for services that intentionally differ by deploy path. */
  note?: string;
}

export const PLATFORM_SERVICE_CATALOG: readonly PlatformServiceCatalogEntry[] = [
  { name: 'postgres', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'critical' },
  { name: 'redis', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'critical' },
  { name: 'nats', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'critical' },
  { name: 'nginx', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'critical' },
  { name: 'mosquitto', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'ignored' },
  { name: 'minio', kind: 'infrastructure', deploymentStatus: 'deployed', criticality: 'ignored' },

  {
    name: 'db-migrate',
    kind: 'migration-job',
    deploymentStatus: 'deployed',
    criticality: 'ignored',
    requiredSignals: ['db_migrate_complete'],
    nxProject: 'db-migrate',
    note: 'One-shot release/source DDL runner; not a schema owner.',
  },

  {
    name: 'auth-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'auth',
    schemaOwner: true,
    criticality: 'critical',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'auth-service',
  },
  {
    name: 'gateway-api',
    kind: 'backend',
    deploymentStatus: 'deployed',
    criticality: 'critical',
    nxProject: 'gateway-api',
  },
  {
    name: 'farm-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'farm',
    schemaOwner: true,
    criticality: 'critical',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'farm-service',
  },
  {
    name: 'sensor-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'sensor',
    schemaOwner: true,
    criticality: 'critical',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'sensor-service',
  },
  {
    name: 'sensor-ingestion',
    kind: 'backend',
    deploymentStatus: 'profiled',
    criticality: 'required',
    profiles: ['rust-sidecar'],
    nxProject: 'sensor-ingestion',
  },
  {
    name: 'hr-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'hr',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'hr-service',
  },
  {
    name: 'messaging-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'messaging',
    schemaOwner: true,
    criticality: 'critical',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'messaging-service',
  },
  {
    name: 'hydroponics-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'hydroponics',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['schema_drift_clean'],
    nxProject: 'hydroponics-service',
  },
  {
    name: 'alert-engine',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'alert',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'alert-engine',
  },
  {
    name: 'billing-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'billing',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'billing-service',
  },
  {
    name: 'notification-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'notification',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'notification-service',
  },
  {
    name: 'ai-service',
    kind: 'backend',
    deploymentStatus: 'notDeployed',
    schema: 'ai',
    schemaOwner: true,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'ai-service',
    note: 'Schema owner exists, but no active droplet compose runtime entry.',
  },
  {
    name: 'admin-api-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'admin',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'admin-api-service',
  },
  {
    name: 'config-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'config',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['schema_drift_clean'],
    nxProject: 'config-service',
  },
  {
    name: 'observability-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'observability',
    schemaOwner: true,
    criticality: 'warning',
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    nxProject: 'observability-service',
  },
  {
    name: 'event-store-service',
    kind: 'backend',
    deploymentStatus: 'deployed',
    schema: 'event_store',
    schemaOwner: true,
    criticality: 'critical',
    requiredSignals: ['schema_drift_clean'],
    nxProject: 'event-store-service',
    note: 'Canonical event ledger runtime; deploy promotion is tied to ledger/readiness gates.',
  },

  { name: 'shell', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'shell' },
  { name: 'dashboard', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'dashboard' },
  { name: 'farm-module', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'farm-module' },
  { name: 'sensor-module', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'sensor-module' },
  { name: 'hr-module', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'hr-module' },
  { name: 'hydroponics-module', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'hydroponics-module' },
  { name: 'admin-panel', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'admin-panel' },
  { name: 'tenant-admin', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'tenant-admin' },
  { name: 'aquamobil', kind: 'frontend', deploymentStatus: 'deployed', criticality: 'warning', nxProject: 'aquamobil' },
] as const;

export function deployedCatalogEntries(): PlatformServiceCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.filter(
    (entry) => entry.deploymentStatus !== 'notDeployed',
  );
}

export function schemaOwnerCatalogEntries(): PlatformServiceCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.filter((entry) => entry.schemaOwner);
}
