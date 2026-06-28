export type DeployTarget = 'droplet' | 'staging' | 'unsupported';
export type DeploymentStatus = 'active' | 'inactive';
export type ServiceClassification =
  | 'infra'
  | 'gateway'
  | 'subgraph'
  | 'internal-service'
  | 'frontend'
  | 'one-shot';
export type CriticalityLevel = 'critical' | 'required' | 'warning' | 'ignored';
export type PrivilegeMode = 'migration-authority' | 'dml-only' | 'tenant-provisioner' | 'none';
export type MigrationHeadPolicy = 'non-empty-glob' | 'placeholder-ok' | 'not-applicable';
export type ServiceVisibility = 'public' | 'internal' | 'infrastructure';
export type GatewayParticipation = 'apollo-subgraph' | 'gateway' | 'none';
export type DeployProfile = 'droplet' | 'staging' | 'rust-sidecar';
export type BuildKind =
  | 'node-service'
  | 'frontend'
  | 'rust-sidecar'
  | 'docker-only'
  | 'one-shot'
  | 'infra';
export type ReadinessContract = 'docker-healthcheck' | 'one-shot-success' | 'none';
export type EventStoreTenantScopePolicy = 'tenant-bound' | 'all-tenants' | 'none';
/**
 * Prometheus scrape surface of a service (OBS-HIGH-001).
 *
 *   - 'prom-endpoint' — the service serves GET /metrics in Prometheus
 *     exposition format on its single HTTP listener (containerPort,
 *     shared with /health). Derived
 *     default for every node-service: validateServiceCatalog REJECTS a
 *     node-service with 'none', so a new backend service cannot silently
 *     opt out of observability. tests/invariants/metrics-endpoint-
 *     adoption.spec.ts asserts the app.module.ts actually registers a
 *     metrics module for each 'prom-endpoint' entry.
 *   - 'none' — no scrape surface (frontends, infra containers, one-shot
 *     jobs, the Rust sidecar).
 */
export type MetricsExposure = 'prom-endpoint' | 'none';
/**
 * How a frontend image obtains its compiled assets.
 *
 *   - 'prebuilt-artifact'      — CI builds the module in the
 *     build-frontend-artifacts job (nx run-many or npm workspace build)
 *     and the Dockerfile COPYs the dist/ artifact in.
 *   - 'dockerfile-self-build'  — the Dockerfile runs the module's own
 *     npm ci + vite build inside the image (standalone lockfile); the
 *     artifact prebuild step MUST skip it.
 *
 * Before this field existed the distinction lived only in a YAML comment
 * in deploy-digitalocean.yml while the generator derived the prebuild
 * list by subtraction (frontend targets minus NX projects) — aquamobil
 * (self-building, web/apps/) fell into the npm-workspace list and the
 * first full-deploy build broke on `--workspace=web/modules/aquamobil`
 * (INFRA-HIGH-005, 2026-06-10 main red).
 */
export type FrontendAssetStrategy = 'prebuilt-artifact' | 'dockerfile-self-build';

export interface GatewaySubgraphCatalogEntry {
  name: string;
  nxProject: string;
  urlEnv: string;
  localUrl: string;
  routingUrl: string;
  schemaArtifactPath: string;
}

export interface ServiceCatalogEntry {
  serviceId: string;
  composeServiceName: string;
  nxProject?: string;
  buildKind: BuildKind;
  imageTarget?: string;
  imageName?: string;
  serviceVisibility: ServiceVisibility;
  gatewayParticipation: GatewayParticipation;
  deployProfiles: readonly DeployProfile[];
  healthEndpoint?: string;
  /**
   * Container-internal HTTP port the service listens on (compose `PORT`
   * env). Readiness sweeps exec curl against this port INSIDE the
   * container — a wrong value here is a false-negative production
   * verify (INFRA-HIGH-014: the readiness view hardcoded 3000 while
   * observability listens on 3009).
   */
  containerPort: number;
  /**
   * Cold-boot budget in seconds — the SSoT for startup timing across the
   * deploy stack (DEPLOY-SSOT: the number lived in three unlinked places —
   * a hardcoded 300 literal in generate-artifacts, a dead `?? 300` fallback
   * in check-service-health, and hand-typed compose `start_period` values).
   *
   * Meaning depends on readinessContract:
   *   - 'docker-healthcheck' — the realistic upper bound for the service to
   *     report `healthy`. Compose `start_period` for this service MUST be
   *     ≤ this value (enforced by the deploy invariant; a future generator
   *     pass will EMIT start_period from here, collapsing the last copy).
   *   - 'one-shot-success' / 'none' — there is no health-gated wait window;
   *     the value is the boot budget the orchestration allows before the
   *     one-shot is considered stuck. The readiness SLA is derived only from
   *     CRITICAL docker-healthcheck services, so one-shot budgets never feed
   *     the SLA computation (mirrors how check-service-health treats
   *     `ignored`/one-shot entries as always-satisfied).
   *
   * The platform-wide readiness SLA (readiness_sla_seconds, consumed by
   * scripts/deploy/check-service-health.ts) is DERIVED at artifact-generation
   * time as max(startupBudgetSeconds over CRITICAL services) + a named margin
   * — never typed. validateServiceCatalog REQUIRES this > 0 for every active
   * service so a new service cannot ship without a declared budget.
   */
  startupBudgetSeconds: number;
  readinessContract: ReadinessContract;
  /**
   * Prometheus scrape surface — see MetricsExposure. Derived in buildEntry
   * (node-service ⇒ 'prom-endpoint'). The scrape endpoint is served on the
   * single Node HTTP listener (`containerPort`) — /metrics and /health share
   * one port per service, so there is no separate metrics port.
   */
  metricsExposure: MetricsExposure;
  schema?: string;
  dbSchema?: string;
  schemaOwnerRole?: string;
  dbRoles?: {
    owner?: string;
    migrator?: string;
    runtime?: string;
    tenantProvisioner?: string;
  };
  privilegeMode: PrivilegeMode;
  migration?: {
    globs: readonly string[];
    entityGlobs?: readonly string[];
    postMigrationHardening?: boolean;
    headPolicy: MigrationHeadPolicy;
  };
  migrationGlobs?: readonly string[];
  entityGlobs?: readonly string[];
  postMigrationHardening?: boolean;
  deploymentStatus: DeploymentStatus;
  deployTarget: DeployTarget;
  criticality: CriticalityLevel;
  classification: ServiceClassification;
  requiredSignals: readonly string[];
  requiredEnv: readonly string[];
  requiredSecrets: readonly string[];
  eventStoreTenantScopePolicy?: EventStoreTenantScopePolicy;
  serviceIdentityAudience?: string;
  gatewaySubgraph?: GatewaySubgraphCatalogEntry;
  /** Frontend entries only: workspace path of the module's package.json (SSOT for build + image-matrix paths). */
  modulePath?: string;
  /** Frontend entries only: asset acquisition strategy — see FrontendAssetStrategy. */
  frontendAssets?: FrontendAssetStrategy;
}

export const MIGRATION_BOOT_SIGNAL_CONTRACT = {
  authorityServiceId: 'db-migrate',
  completeSignal: 'db_migrate_complete',
  retiredRunnerSignal: 'migration_runner_applied',
} as const;

type CatalogEntryInput = Omit<
  ServiceCatalogEntry,
  | 'composeServiceName'
  | 'buildKind'
  | 'serviceVisibility'
  | 'gatewayParticipation'
  | 'deployProfiles'
  | 'readinessContract'
  | 'containerPort'
  | 'metricsExposure'
  | 'dbSchema'
  | 'migrationGlobs'
  | 'entityGlobs'
  | 'postMigrationHardening'
  | 'requiredSecrets'
  | 'serviceIdentityAudience'
> &
  Partial<
    Pick<
      ServiceCatalogEntry,
      | 'composeServiceName'
      | 'buildKind'
      | 'serviceVisibility'
      | 'gatewayParticipation'
      | 'deployProfiles'
      | 'readinessContract'
      | 'containerPort'
      | 'metricsExposure'
      | 'dbSchema'
      | 'migrationGlobs'
      | 'entityGlobs'
      | 'postMigrationHardening'
      | 'requiredSecrets'
      | 'serviceIdentityAudience'
    >
  >;

const SECRET_ENV_PATTERN = /(?:PASSWORD|PASS|SECRET|KEY|TOKEN|PEPPER|HASH|ENCRYPTION|CREDENTIAL)/;

function buildEntry(input: CatalogEntryInput): ServiceCatalogEntry {
  const migrationGlobs = input.migrationGlobs ?? input.migration?.globs;
  const entityGlobs = input.entityGlobs ?? input.migration?.entityGlobs;
  const postMigrationHardening =
    input.postMigrationHardening ?? input.migration?.postMigrationHardening;
  const requiredSecrets =
    input.requiredSecrets ?? input.requiredEnv.filter((name) => SECRET_ENV_PATTERN.test(name));
  const requiredEnv = input.requiredEnv.filter((name) => !requiredSecrets.includes(name));
  const buildKind =
    input.buildKind ??
    (input.classification === 'frontend'
      ? 'frontend'
      : input.classification === 'infra'
        ? 'infra'
        : input.classification === 'one-shot'
          ? 'one-shot'
          : 'node-service');
  const serviceVisibility =
    input.serviceVisibility ??
    (input.classification === 'gateway'
      ? 'public'
      : input.classification === 'infra'
        ? 'infrastructure'
        : 'internal');
  const gatewayParticipation =
    input.gatewayParticipation ??
    (input.classification === 'gateway'
      ? 'gateway'
      : input.classification === 'subgraph'
        ? 'apollo-subgraph'
        : 'none');
  // OBS-HIGH-001: every NestJS backend exposes a Prometheus scrape surface
  // by default — observability adoption is the zero-effort path, opt-out is
  // structurally rejected for node-services by validateServiceCatalog.
  const metricsExposure =
    input.metricsExposure ?? (buildKind === 'node-service' ? 'prom-endpoint' : 'none');

  return {
    ...input,
    composeServiceName: input.composeServiceName ?? input.serviceId,
    buildKind,
    imageName: input.imageName ?? input.imageTarget,
    serviceVisibility,
    gatewayParticipation,
    deployProfiles:
      input.deployProfiles ??
      (input.deployTarget === 'droplet' && input.deploymentStatus === 'active'
        ? (['droplet'] as const)
        : ([] as const)),
    // Platform default: every node-service listens on 3000 unless its
    // compose service declares otherwise (PORT env) — deviations MUST be
    // declared here so readiness/verify views stay truthful.
    containerPort: input.containerPort ?? 3000,
    readinessContract:
      input.readinessContract ??
      (input.classification === 'one-shot'
        ? 'one-shot-success'
        : input.deploymentStatus === 'active'
          ? 'docker-healthcheck'
          : 'none'),
    metricsExposure,
    dbSchema: input.dbSchema ?? input.schema,
    migrationGlobs,
    entityGlobs,
    postMigrationHardening,
    requiredEnv,
    requiredSecrets,
    eventStoreTenantScopePolicy: input.eventStoreTenantScopePolicy,
    serviceIdentityAudience:
      input.serviceIdentityAudience ?? input.gatewaySubgraph?.name ?? input.serviceId,
  };
}

function subgraph(
  name: string,
  nxProject: string,
  urlEnv: string,
  localUrl: string,
  routingServiceName = nxProject,
): GatewaySubgraphCatalogEntry {
  return {
    name,
    nxProject,
    urlEnv,
    localUrl,
    routingUrl: `http://${routingServiceName}:3000/graphql`,
    schemaArtifactPath: `dist/graphql/subgraphs/${name}.graphql`,
  };
}

export const PLATFORM_SERVICE_CATALOG: readonly ServiceCatalogEntry[] = [
  buildEntry({
    serviceId: 'postgres',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'infra',
    // DB cold-start (TimescaleDB-HA image): the compose healthcheck omits an
    // explicit start_period (Docker default 0s) but pg accepts connections
    // within ~30s on the droplet; the budget caps the readiness wait window.
    startupBudgetSeconds: 30,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: ['POSTGRES_PASSWORD'],
  }),
  buildEntry({
    serviceId: 'redis',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'infra',
    startupBudgetSeconds: 15,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: ['REDIS_PASSWORD'],
  }),
  buildEntry({
    serviceId: 'nats',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'infra',
    // Matches compose start_period: 15s.
    startupBudgetSeconds: 15,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  buildEntry({
    serviceId: 'db-migrate',
    nxProject: 'db-migrate',
    imageTarget: 'db-migrate',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'ignored',
    classification: 'one-shot',
    // One-shot migration runner — no health-gated wait window. The budget is
    // the boot allowance before the job is considered stuck; it never feeds
    // the readiness SLA (derived from CRITICAL docker-healthcheck services
    // only). Matches the migration window in required-signals.yaml (300s).
    startupBudgetSeconds: 300,
    privilegeMode: 'migration-authority',
    dbRoles: { migrator: 'db_migrate' },
    eventStoreTenantScopePolicy: 'all-tenants',
    requiredSignals: [MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal],
    requiredEnv: ['POSTGRES_PASSWORD'],
  }),
  buildEntry({
    serviceId: 'tenant-schema-provisioner',
    composeServiceName: 'tenant-schema-provisioner',
    imageName: 'db-migrate',
    buildKind: 'one-shot',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'required',
    classification: 'internal-service',
    readinessContract: 'none',
    // One-shot provisioner — no health-gated wait window (readinessContract
    // 'none'); budget is the boot allowance, not an SLA input.
    startupBudgetSeconds: 120,
    privilegeMode: 'tenant-provisioner',
    dbRoles: { migrator: 'db_migrate' },
    eventStoreTenantScopePolicy: 'all-tenants',
    requiredSignals: [],
    requiredEnv: ['POSTGRES_PASSWORD'],
  }),
  buildEntry({
    serviceId: 'gateway-api',
    nxProject: 'gateway-api',
    imageTarget: 'gateway-api',
    dbRoles: { runtime: 'gateway_service' },
    privilegeMode: 'dml-only',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'gateway',
    // Gateway is now FAST to ready: supergraph composition moved to a
    // background manager, so /health passes without waiting on subgraph
    // introspection. Budget headroom over the compose start_period (30s).
    startupBudgetSeconds: 40,
    requiredSignals: [],
    requiredEnv: [
      'GATEWAY_SERVICE_DB_PASS',
      'SERVICE_IDENTITY_KEYRING',
      'SERVICE_IDENTITY_SIGNING_KID',
    ],
  }),
  buildEntry({
    serviceId: 'auth-service',
    nxProject: 'auth-service',
    imageTarget: 'auth-service',
    schema: 'auth',
    schemaOwnerRole: 'auth_schema_owner',
    dbRoles: { owner: 'auth_schema_owner', migrator: 'db_migrate', runtime: 'auth_service' },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/auth-service/src/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: [
      'AUTH_SERVICE_DB_PASS',
      'PASSWORD_PEPPER',
      'MFA_ENCRYPTION_KEY',
      'SUPER_ADMIN_PASSWORD',
    ],
    gatewaySubgraph: subgraph(
      'auth',
      'auth-service',
      'AUTH_SERVICE_URL',
      'http://localhost:3001/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'farm-service',
    nxProject: 'farm-service',
    imageTarget: 'farm-service',
    schema: 'farm',
    schemaOwnerRole: 'farm_schema_owner',
    dbRoles: {
      owner: 'farm_schema_owner',
      migrator: 'db_migrate',
      runtime: 'farm_service',
      tenantProvisioner: 'farm_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/farm-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 120s — the heaviest backend cold-boot
    // (entity metadata + migrations check) and the current SLA-defining max.
    startupBudgetSeconds: 120,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['FARM_SERVICE_DB_PASS', 'ENCRYPTION_KEY'],
    gatewaySubgraph: subgraph(
      'farm',
      'farm-service',
      'FARM_SERVICE_URL',
      'http://localhost:3002/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'sensor-service',
    nxProject: 'sensor-service',
    imageTarget: 'sensor-service',
    schema: 'sensor',
    schemaOwnerRole: 'sensor_schema_owner',
    dbRoles: {
      owner: 'sensor_schema_owner',
      migrator: 'db_migrate',
      runtime: 'sensor_service',
      tenantProvisioner: 'sensor_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/sensor-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 90s.
    startupBudgetSeconds: 90,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['SENSOR_SERVICE_DB_PASS', 'CREDENTIAL_ENCRYPTION_KEY'],
    gatewaySubgraph: subgraph(
      'sensor',
      'sensor-service',
      'SENSOR_SERVICE_URL',
      'http://localhost:3003/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'sensor-ingestion',
    nxProject: 'sensor-ingestion',
    imageTarget: 'sensor-ingestion',
    buildKind: 'rust-sidecar',
    deploymentStatus: 'inactive',
    deployTarget: 'unsupported',
    deployProfiles: [],
    criticality: 'ignored',
    classification: 'internal-service',
    // Inactive sidecar (not deployed to droplet) — nominal budget; the
    // validator only enforces > 0 for active services.
    startupBudgetSeconds: 30,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  buildEntry({
    serviceId: 'hr-service',
    nxProject: 'hr-service',
    imageTarget: 'hr-service',
    schema: 'hr',
    schemaOwnerRole: 'hr_schema_owner',
    dbRoles: {
      owner: 'hr_schema_owner',
      migrator: 'db_migrate',
      runtime: 'hr_service',
      tenantProvisioner: 'hr_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/hr-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'warning',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['HR_SERVICE_DB_PASS'],
    gatewaySubgraph: subgraph(
      'hr',
      'hr-service',
      'HR_SERVICE_URL',
      'http://localhost:3005/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'hydroponics-service',
    nxProject: 'hydroponics-service',
    imageTarget: 'hydroponics-service',
    schema: 'hydroponics',
    schemaOwnerRole: 'hydroponics_schema_owner',
    dbRoles: {
      owner: 'hydroponics_schema_owner',
      migrator: 'db_migrate',
      runtime: 'hydroponics_service',
      tenantProvisioner: 'hydroponics_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/hydroponics-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'placeholder-ok',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'warning',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['HYDROPONICS_SERVICE_DB_PASS'],
    gatewaySubgraph: subgraph(
      'hydroponics',
      'hydroponics-service',
      'HYDROPONICS_SERVICE_URL',
      'http://localhost:4007/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'messaging-service',
    nxProject: 'messaging-service',
    imageTarget: 'messaging-service',
    schema: 'messaging',
    schemaOwnerRole: 'messaging_schema_owner',
    dbRoles: {
      owner: 'messaging_schema_owner',
      migrator: 'db_migrate',
      runtime: 'messaging_service',
      tenantProvisioner: 'messaging_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: [
        'apps/messaging-service/src/migrations/[0-9]*{.ts,.js}',
        'apps/messaging-service/src/database/migrations/[0-9]*{.ts,.js}',
      ],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['MESSAGING_SERVICE_DB_PASS'],
    gatewaySubgraph: subgraph(
      'messaging',
      'messaging-service',
      'MESSAGING_SERVICE_URL',
      'http://messaging-service:3000/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'alert-engine',
    nxProject: 'alert-engine',
    imageTarget: 'alert-engine',
    schema: 'alert',
    schemaOwnerRole: 'alert_schema_owner',
    dbRoles: {
      owner: 'alert_schema_owner',
      migrator: 'db_migrate',
      runtime: 'alert_service',
      tenantProvisioner: 'alert_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/alert-engine/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    // OBS-HIGH-001 (OPERATOR-APPROVAL ITEM): raised from 'warning' to
    // 'critical'. alert-engine produces life-safety alerts (dissolved-oxygen
    // crash, equipment failure escalation) — a deploy that leaves it
    // unhealthy must FAIL, not warn. Propagates through the generated
    // service-criticality.yaml into scripts/deploy/check-service-health.ts:
    // an unhealthy alert-engine now blocks the deploy gate.
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['ALERT_SERVICE_DB_PASS'],
    gatewaySubgraph: subgraph(
      'alert',
      'alert-engine',
      'ALERT_SERVICE_URL',
      'http://localhost:3004/graphql',
      'alert-engine',
    ),
  }),
  buildEntry({
    serviceId: 'billing-service',
    nxProject: 'billing-service',
    imageTarget: 'billing-service',
    schema: 'billing',
    schemaOwnerRole: 'billing_schema_owner',
    dbRoles: { owner: 'billing_schema_owner', migrator: 'db_migrate', runtime: 'billing_service' },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/billing-service/src/database/migrations/[0-9]*{.ts,.js}'],
      postMigrationHardening: true,
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['BILLING_SERVICE_DB_PASS'],
    gatewaySubgraph: subgraph(
      'billing',
      'billing-service',
      'BILLING_SERVICE_URL',
      'http://localhost:3006/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'notification-service',
    nxProject: 'notification-service',
    imageTarget: 'notification-service',
    schema: 'notification',
    schemaOwnerRole: 'notification_schema_owner',
    dbRoles: {
      owner: 'notification_schema_owner',
      migrator: 'db_migrate',
      runtime: 'notification_service',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/notification-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['NOTIFICATION_SERVICE_DB_PASS', 'WEBHOOK_ENCRYPTION_KEY'],
    gatewaySubgraph: subgraph(
      'notification',
      'notification-service',
      'NOTIFICATION_SERVICE_URL',
      'http://localhost:4008/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'admin-api-service',
    nxProject: 'admin-api-service',
    imageTarget: 'admin-api-service',
    schema: 'admin',
    schemaOwnerRole: 'admin_schema_owner',
    dbRoles: { owner: 'admin_schema_owner', migrator: 'db_migrate', runtime: 'admin_service' },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/admin-api-service/src/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'subgraph',
    gatewayParticipation: 'none',
    eventStoreTenantScopePolicy: 'all-tenants',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['ADMIN_SERVICE_DB_PASS', 'ENCRYPTION_KEY'],
  }),
  buildEntry({
    serviceId: 'config-service',
    nxProject: 'config-service',
    imageTarget: 'config-service',
    schema: 'config',
    schemaOwnerRole: 'config_schema_owner',
    dbRoles: { owner: 'config_schema_owner', migrator: 'db_migrate', runtime: 'config_service' },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/config-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'required',
    classification: 'internal-service',
    gatewayParticipation: 'apollo-subgraph',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['schema_drift_clean'],
    requiredEnv: [
      'CONFIG_SERVICE_DB_PASS',
      'SERVICE_IDENTITY_KEYRING',
      'SERVICE_IDENTITY_SIGNING_KID',
      'CONFIG_ENCRYPTION_KEY',
    ],
    gatewaySubgraph: subgraph(
      'config',
      'config-service',
      'CONFIG_SERVICE_URL',
      'http://localhost:3007/graphql',
    ),
  }),
  buildEntry({
    serviceId: 'event-store-service',
    nxProject: 'event-store-service',
    imageTarget: 'event-store-service',
    schema: 'event_store',
    schemaOwnerRole: 'event_store_schema_owner',
    dbRoles: {
      owner: 'event_store_schema_owner',
      migrator: 'db_migrate',
      runtime: 'event_store_service',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/event-store-service/src/migrations/[0-9]*{.ts,.js}'],
      postMigrationHardening: true,
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'critical',
    classification: 'internal-service',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['schema_drift_clean'],
    eventStoreTenantScopePolicy: 'none',
    requiredEnv: ['EVENT_STORE_SERVICE_DB_PASS', 'SERVICE_IDENTITY_KEYRING'],
  }),
  buildEntry({
    serviceId: 'observability-service',
    nxProject: 'observability-service',
    imageTarget: 'observability-service',
    // The ONE backend that does not listen on 3000: docker-compose.droplet.yml
    // sets PORT: 3009 and its healthcheck probes localhost:3009. Both the
    // readiness sweep AND the Prometheus scrape target this single port.
    containerPort: 3009,
    schema: 'observability',
    schemaOwnerRole: 'observability_schema_owner',
    dbRoles: {
      owner: 'observability_schema_owner',
      migrator: 'db_migrate',
      runtime: 'observability_service',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/observability-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'placeholder-ok',
    },
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'warning',
    classification: 'internal-service',
    // Matches compose start_period: 60s.
    startupBudgetSeconds: 60,
    requiredSignals: ['nats_auth_mode_mtls', 'schema_drift_clean'],
    requiredEnv: ['OBSERVABILITY_INTERNAL_API_KEY', 'OBSERVABILITY_SERVICE_DB_PASS'],
  }),
  buildEntry({
    serviceId: 'ai-service',
    nxProject: 'ai-service',
    imageTarget: 'ai-service',
    schema: 'ai',
    schemaOwnerRole: 'ai_schema_owner',
    dbRoles: {
      owner: 'ai_schema_owner',
      migrator: 'db_migrate',
      runtime: 'ai_service',
      tenantProvisioner: 'ai_tenant_provisioner',
    },
    privilegeMode: 'dml-only',
    migration: {
      globs: ['apps/ai-service/src/database/migrations/[0-9]*{.ts,.js}'],
      headPolicy: 'non-empty-glob',
    },
    deploymentStatus: 'inactive',
    deployTarget: 'unsupported',
    criticality: 'ignored',
    classification: 'subgraph',
    gatewayParticipation: 'none',
    // Inactive (not deployed to droplet) — nominal budget; the validator
    // only enforces > 0 for active services.
    startupBudgetSeconds: 60,
    requiredSignals: [],
    requiredEnv: ['AI_SERVICE_DB_PASS'],
  }),
  // ── Monitoring scraper stack (ORPHAN-090, PR #670) ─────────────────────────
  // WHAT: the four observability-infra containers added to
  // docker-compose.droplet.yml (prometheus + cadvisor + node-exporter +
  // alertmanager). They consume the catalog-generated scrape config; they do
  // not expose a Prometheus surface themselves (buildKind 'infra' ⇒
  // metricsExposure 'none'), so they are not scrape targets.
  // WHY criticality 'ignored': these are the monitoring plane, not the
  // application plane. A scraper that is slow or down loses visibility but
  // MUST NOT roll back an otherwise-healthy application deploy — same
  // precedent as the mosquitto/minio infra entries. They declare no
  // compose `profiles:` (always-on), so no profiles list here either
  // (validate-criticality-manifest profile-parity check).
  buildEntry({
    serviceId: 'prometheus',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'ignored',
    classification: 'infra',
    // Pinned image cold-start (TSDB open + config load) is fast; budget caps
    // the readiness wait. ignored services never feed the readiness SLA.
    startupBudgetSeconds: 30,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  buildEntry({
    serviceId: 'cadvisor',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'ignored',
    classification: 'infra',
    startupBudgetSeconds: 30,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  buildEntry({
    serviceId: 'node-exporter',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'ignored',
    classification: 'infra',
    startupBudgetSeconds: 15,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  buildEntry({
    serviceId: 'alertmanager',
    deploymentStatus: 'active',
    deployTarget: 'droplet',
    criticality: 'ignored',
    classification: 'infra',
    startupBudgetSeconds: 15,
    privilegeMode: 'none',
    requiredSignals: [],
    requiredEnv: [],
  }),
  ...[
    'nginx',
    'shell',
    'dashboard',
    'farm-module',
    'sensor-module',
    'hr-module',
    'hydroponics-module',
    'admin-panel',
    'tenant-admin',
    'aquamobil',
    'mosquitto',
    'minio',
  ].map(
    (serviceId): ServiceCatalogEntry =>
      buildEntry({
        serviceId,
        nxProject:
          serviceId.includes('-module') ||
          ['shell', 'dashboard', 'admin-panel', 'tenant-admin'].includes(serviceId)
            ? serviceId
            : undefined,
        imageTarget:
          serviceId === 'mosquitto' || !['nginx', 'minio'].includes(serviceId)
            ? serviceId
            : undefined,
        modulePath: ['nginx', 'mosquitto', 'minio'].includes(serviceId)
          ? undefined
          : serviceId === 'shell'
            ? 'web/shell'
            : serviceId === 'aquamobil'
              ? 'web/apps/aquamobil'
              : `web/modules/${serviceId}`,
        frontendAssets: ['nginx', 'mosquitto', 'minio'].includes(serviceId)
          ? undefined
          : serviceId === 'aquamobil'
            ? 'dockerfile-self-build'
            : 'prebuilt-artifact',
        buildKind: serviceId === 'mosquitto' ? 'docker-only' : undefined,
        deploymentStatus: 'active',
        deployTarget: 'droplet',
        // Startup budgets for the infra + frontend tail, aligned with each
        // service's compose start_period (mosquitto 10s, nginx 30s); minio
        // declares no start_period (Docker default 0s) — 15s caps the wait.
        // Frontends serve static assets behind nginx and have no compose
        // healthcheck, so 30s is a generous liveness budget. None of these
        // are CRITICAL backends (nginx is the only critical entry here and
        // sits at 30s ≤ SLA), so they never raise the readiness SLA.
        startupBudgetSeconds:
          serviceId === 'mosquitto' ? 10 : serviceId === 'minio' ? 15 : 30,
        criticality:
          serviceId === 'nginx'
            ? 'critical'
            : serviceId === 'mosquitto' || serviceId === 'minio'
              ? 'ignored'
              : 'warning',
        classification:
          serviceId === 'nginx' || serviceId === 'mosquitto' || serviceId === 'minio'
            ? 'infra'
            : 'frontend',
        privilegeMode: 'none',
        requiredSignals: [],
        requiredEnv:
          serviceId === 'minio'
            ? ['MINIO_USER', 'MINIO_PASSWORD']
            : serviceId === 'mosquitto'
              ? ['MQTT_AUTH_SECRET', 'MQTT_SENSOR_SERVICE_HASH', 'MQTT_SENSOR_SERVICE_PASSWORD']
              : [],
      }),
  ),
] as const;

export function getServiceCatalogEntry(serviceId: string): ServiceCatalogEntry | undefined {
  return PLATFORM_SERVICE_CATALOG.find((entry) => entry.serviceId === serviceId);
}

export function serviceCatalogById(): Map<string, ServiceCatalogEntry> {
  return new Map(PLATFORM_SERVICE_CATALOG.map((entry) => [entry.serviceId, entry]));
}

export function activeDropletServices(): readonly ServiceCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.filter(
    (entry) => entry.deploymentStatus === 'active' && entry.deployProfiles.includes('droplet'),
  );
}

export function activeDropletComposeServices(): readonly string[] {
  return activeDropletServices().map((entry) => entry.composeServiceName);
}

export function imageBuildTargets(): readonly string[] {
  return activeDropletServices()
    .filter((entry) => entry.buildKind !== 'infra')
    .map((entry) => entry.imageTarget)
    .filter((target): target is string => typeof target === 'string');
}

export function backendImageBuildTargets(): readonly string[] {
  return activeDropletServices()
    .filter((entry) => ['node-service', 'one-shot'].includes(entry.buildKind))
    .map((entry) => entry.imageTarget)
    .filter((target): target is string => typeof target === 'string');
}

export function frontendImageBuildTargets(): readonly string[] {
  return activeDropletServices()
    .filter((entry) => entry.buildKind === 'frontend')
    .map((entry) => entry.imageTarget)
    .filter((target): target is string => typeof target === 'string');
}

export function infraImageBuildTargets(): readonly string[] {
  return activeDropletServices()
    .filter((entry) => entry.buildKind === 'docker-only')
    .map((entry) => entry.imageTarget)
    .filter((target): target is string => typeof target === 'string');
}

export interface FrontendPrebuildModule {
  readonly module: string;
  readonly workspacePath: string;
}

export interface FrontendPrebuildPlan {
  readonly nxProjects: readonly string[];
  readonly workspaceModules: readonly FrontendPrebuildModule[];
}

/**
 * SSOT for the CI artifact-prebuild step (deploy build-frontend-artifacts).
 *
 * Splits active frontend image targets into the two prebuild lanes and
 * EXCLUDES 'dockerfile-self-build' entries entirely — their assets are
 * compiled inside their own Dockerfile, so prebuilding them is at best
 * wasted work and at worst a broken `npm --workspace` invocation
 * (INFRA-HIGH-005: aquamobil). Workspace modules carry their catalog
 * modulePath so no consumer ever reconstructs the path by convention.
 */
export function frontendPrebuildPlan(): FrontendPrebuildPlan {
  const frontends = activeDropletServices().filter(
    (entry) => entry.buildKind === 'frontend' && typeof entry.imageTarget === 'string',
  );
  const prebuilt = frontends.filter(
    (entry) => (entry.frontendAssets ?? 'prebuilt-artifact') === 'prebuilt-artifact',
  );
  const nxProjects = prebuilt
    .map((entry) => entry.nxProject)
    .filter((project): project is string => typeof project === 'string')
    .sort();
  const workspaceModules = prebuilt
    .filter((entry) => entry.nxProject === undefined)
    .map((entry) => {
      if (!entry.modulePath) {
        throw new Error(
          `frontend ${entry.serviceId} has no modulePath — required to prebuild a non-NX workspace module`,
        );
      }
      return { module: entry.imageTarget as string, workspacePath: entry.modulePath };
    })
    .sort((a, b) => a.module.localeCompare(b.module));
  return { nxProjects, workspaceModules };
}

export function serviceDbRolePrefixes(): readonly string[] {
  return activeDropletServices()
    .map((entry) => entry.dbRoles?.runtime)
    .filter((role): role is string => Boolean(role))
    .map((role) => role.replace(/_service$/, '').toUpperCase())
    .sort();
}

export function readinessServices(): readonly { serviceId: string; port: number }[] {
  return activeDropletServices()
    .filter(
      (entry) =>
        entry.readinessContract === 'docker-healthcheck' &&
        ['gateway', 'subgraph', 'internal-service'].includes(entry.classification) &&
        entry.buildKind === 'node-service',
    )
    .map((entry) => ({ serviceId: entry.composeServiceName, port: entry.containerPort }));
}

export function packageBuildProjects(): readonly string[] {
  return activeDropletServices()
    .filter((entry) => ['node-service', 'frontend', 'one-shot'].includes(entry.buildKind))
    .map((entry) => entry.nxProject)
    .filter((project): project is string => typeof project === 'string');
}

export function gatewaySubgraphs(): readonly GatewaySubgraphCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.filter(
    (entry) => entry.gatewayParticipation === 'apollo-subgraph',
  ).map((entry) => {
    if (!entry.gatewaySubgraph) {
      throw new Error(
        `Catalog entry ${entry.serviceId} participates in Apollo gateway without gatewaySubgraph metadata.`,
      );
    }
    return entry.gatewaySubgraph;
  });
}

export function requiredRuntimeEnv(): readonly string[] {
  return [...new Set(PLATFORM_SERVICE_CATALOG.flatMap((entry) => entry.requiredEnv))].sort();
}

export function requiredRuntimeSecrets(): readonly string[] {
  return [...new Set(PLATFORM_SERVICE_CATALOG.flatMap((entry) => entry.requiredSecrets))].sort();
}

export function schemaOwningServices(): readonly ServiceCatalogEntry[] {
  return PLATFORM_SERVICE_CATALOG.filter((entry) => Boolean(entry.dbSchema));
}

export function eventStoreTenantScopePolicyForService(
  serviceId: string,
): EventStoreTenantScopePolicy | undefined {
  return getServiceCatalogEntry(serviceId)?.eventStoreTenantScopePolicy ?? 'tenant-bound';
}

export function serviceIdentityAudienceForService(serviceId: string): string | undefined {
  return getServiceCatalogEntry(serviceId)?.serviceIdentityAudience;
}

export function serviceIdentityAudiencesForService(serviceId: string): readonly string[] {
  const entry = getServiceCatalogEntry(serviceId);
  if (!entry) {
    return [];
  }

  return [
    ...new Set(
      [entry.serviceIdentityAudience, entry.gatewaySubgraph?.name, entry.serviceId].filter(
        (audience): audience is string => Boolean(audience),
      ),
    ),
  ];
}

/**
 * SSoT allowlist of known service-identity CALLER names.
 *
 * WHAT: the sorted, de-duplicated set of catalog `serviceId`s for every
 * active-droplet backend that holds the shared HMAC keyring and can SIGN an
 * inter-service request (classification gateway / subgraph / internal-service,
 * buildKind node-service). The `serviceId` is the exact value each signer binds
 * into the `X-Service-Identity` header via buildSignedInternalHeaders/signedFetch
 * (e.g. gateway-api, admin-api-service, notification-service).
 *
 * WHY it lives here and is read by the verifier (not stamped into the keyring
 * JSON): `callers`/`audiences` are NON-secret authorization policy. The deploy
 * secret bootstrap mints a single shared keyring entry that transports only
 * {kid,secret,status}. Copying policy into that JSON lets it silently drift from
 * the catalog — exactly what regression #388 did (a policy-less entry made the
 * verifier fail-closed `caller-not-allowed` on every gateway→subgraph call → a
 * total login outage). Deriving the allowlist from this single SSoT means the
 * keyring never carries policy, so the drift is structurally impossible, and
 * adding a new backend to the catalog auto-extends the allowlist.
 *
 * This is a known-name allowlist under a shared secret (any secret holder can
 * assert any name), i.e. defense-in-depth — NOT a per-caller crypto boundary.
 * The real per-receiver audience check is matchesExpectedAudience in
 * libs/backend-common service-identity.util. Unforgeable per-caller identity
 * (per-service keys / mTLS) is tracked hardening, not provided here.
 */
export function serviceIdentityCallers(): readonly string[] {
  return [
    ...new Set(
      activeDropletServices()
        .filter(
          (entry) =>
            entry.buildKind === 'node-service' &&
            ['gateway', 'subgraph', 'internal-service'].includes(entry.classification),
        )
        .map((entry) => entry.serviceId),
    ),
  ].sort();
}

/**
 * Safety margin (seconds) added to the slowest CRITICAL service's startup
 * budget to derive the platform readiness SLA. 180s on top of the current
 * max CRITICAL budget (farm-service, 120s) reproduces the historical 300s
 * SLA exactly — but as a DERIVED value, not a typed literal: raise the
 * slowest critical budget and the SLA tracks it automatically.
 */
export const READINESS_SLA_MARGIN_SECONDS = 180;

/**
 * The platform readiness SLA in seconds — the single derived number that
 * scripts/deploy/check-service-health.ts polls against. Computed as
 * max(startupBudgetSeconds over CRITICAL services) + READINESS_SLA_MARGIN_SECONDS.
 *
 * Only CRITICAL services feed the max because the deploy gate rolls back on a
 * CRITICAL service that misses the SLA; warning/required/ignored services do
 * not block the gate, so a slow non-critical boot must not inflate the SLA.
 * This is the SSoT replacement for the former hardcoded `readiness_sla_seconds:
 * 300` literal in the generator and the dead `?? 300` fallback in the consumer.
 */
export function readinessSlaSeconds(
  catalog: readonly ServiceCatalogEntry[] = PLATFORM_SERVICE_CATALOG,
): number {
  const criticalBudgets = catalog
    .filter(
      (entry) =>
        entry.deploymentStatus === 'active' &&
        entry.deployProfiles.includes('droplet') &&
        entry.criticality === 'critical',
    )
    .map((entry) => entry.startupBudgetSeconds);
  if (criticalBudgets.length === 0) {
    throw new Error(
      'readinessSlaSeconds: no active critical droplet services in catalog — cannot derive SLA',
    );
  }
  return Math.max(...criticalBudgets) + READINESS_SLA_MARGIN_SECONDS;
}

export interface CatalogValidationError {
  serviceId: string;
  message: string;
}

export function validateServiceCatalog(
  catalog: readonly ServiceCatalogEntry[] = PLATFORM_SERVICE_CATALOG,
): readonly CatalogValidationError[] {
  const errors: CatalogValidationError[] = [];
  const seenServiceIds = new Set<string>();
  const seenComposeNames = new Set<string>();

  for (const entry of catalog) {
    if (seenServiceIds.has(entry.serviceId)) {
      errors.push({ serviceId: entry.serviceId, message: 'duplicate serviceId' });
    }
    seenServiceIds.add(entry.serviceId);

    if (seenComposeNames.has(entry.composeServiceName)) {
      errors.push({ serviceId: entry.serviceId, message: 'duplicate composeServiceName' });
    }
    seenComposeNames.add(entry.composeServiceName);

    if (entry.dbSchema && entry.dbSchema !== entry.schema) {
      errors.push({ serviceId: entry.serviceId, message: 'schema and dbSchema must match' });
    }
    if (entry.migrationGlobs && entry.migration && entry.migrationGlobs !== entry.migration.globs) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'migrationGlobs must be derived from migration.globs',
      });
    }
    if (entry.privilegeMode === 'dml-only' && !entry.dbRoles?.runtime) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'dml-only service must declare dbRoles.runtime',
      });
    }
    if (entry.dbSchema && !entry.dbRoles?.owner) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'schema-owning service must declare dbRoles.owner',
      });
    }
    if (entry.dbSchema && !entry.dbRoles?.migrator) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'schema-owning service must declare dbRoles.migrator',
      });
    }
    if (entry.requiredSignals.includes(MIGRATION_BOOT_SIGNAL_CONTRACT.retiredRunnerSignal)) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'migration_runner_applied is retired; db-migrate owns migration boot signals',
      });
    }
    if (
      entry.requiredSignals.includes(MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal) &&
      entry.serviceId !== MIGRATION_BOOT_SIGNAL_CONTRACT.authorityServiceId
    ) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'db_migrate_complete may only be required by db-migrate',
      });
    }
    if (
      entry.serviceId === MIGRATION_BOOT_SIGNAL_CONTRACT.authorityServiceId &&
      !entry.requiredSignals.includes(MIGRATION_BOOT_SIGNAL_CONTRACT.completeSignal)
    ) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'db-migrate must require db_migrate_complete',
      });
    }
    if (entry.gatewayParticipation === 'apollo-subgraph' && !entry.gatewaySubgraph) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'apollo-subgraph entry must declare gatewaySubgraph',
      });
    }
    if (entry.serviceId === 'event-store-service' && entry.gatewayParticipation !== 'none') {
      errors.push({
        serviceId: entry.serviceId,
        message: 'event-store-service must not participate in the gateway',
      });
    }
    if (
      entry.eventStoreTenantScopePolicy === 'all-tenants' &&
      entry.serviceVisibility === 'public'
    ) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'all-tenants event-store access is not allowed for public services',
      });
    }
    if (
      ['gateway', 'subgraph', 'internal-service'].includes(entry.classification) &&
      entry.buildKind === 'node-service' &&
      !entry.serviceIdentityAudience
    ) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'node service must declare a service identity audience',
      });
    }
    // OBS-HIGH-001: metrics completeness is structural, not optional.
    // A NestJS backend without a Prometheus scrape surface is an
    // observability blind spot — rejected at the catalog level so the
    // wrong state cannot be expressed.
    if (entry.buildKind === 'node-service' && entry.metricsExposure !== 'prom-endpoint') {
      errors.push({
        serviceId: entry.serviceId,
        message: 'node service must expose a Prometheus endpoint (metricsExposure prom-endpoint)',
      });
    }
    // The scrape port is the single Node HTTP listener (`containerPort`),
    // shared with /health — buildEntry defaults it to 3000, so a
    // prom-endpoint entry always has a valid scrape target; no separate
    // metrics port to validate.

    // DEPLOY-SSOT: startup timing is catalog-derived. An active droplet
    // service MUST declare a positive cold-boot budget — it feeds the
    // readiness SLA (critical services) or the boot allowance (others), and
    // the deploy invariant asserts compose start_period ≤ this. A zero/absent
    // budget would let a new service ship with no startup contract.
    if (
      entry.deploymentStatus === 'active' &&
      entry.deployProfiles.includes('droplet') &&
      !(entry.startupBudgetSeconds > 0)
    ) {
      errors.push({
        serviceId: entry.serviceId,
        message: 'active droplet service must declare startupBudgetSeconds > 0',
      });
    }
  }

  return errors;
}
