import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.dev.yml',
  'docker-compose.prod.yml',
  'docker-compose.droplet.yml',
  'docker-compose.staging.yml',
  'docker-compose.watch.yml',
] as const;
const REQUIRED_ENVIRONMENT = [
  'FARM_ENVIRONMENT_MONITORING_ENABLED',
  'MET_NORWAY_APPLICATION_NAME',
  'MET_NORWAY_CONTACT',
  'MET_NORWAY_FROST_CLIENT_ID',
  'SENTINEL_HUB_ENCRYPTION_KEY',
] as const;

interface ComposeService {
  command?: string | string[];
  depends_on?: Record<string, { condition?: string } | string> | string[];
  environment?: Record<string, unknown> | string[];
  healthcheck?: { test?: string[] };
  volumes?: string[];
}

interface ComposeDocument {
  networks?: Record<string, unknown>;
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

interface HelmValues {
  farmService?: { env?: Record<string, unknown> };
  secrets?: Record<string, unknown>;
}

interface KubernetesResource {
  kind?: string;
  metadata?: { name?: string };
  data?: Record<string, unknown>;
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          name?: string;
          env?: Array<{
            name?: string;
            valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
          }>;
          envFrom?: Array<{ configMapRef?: { name?: string } }>;
        }>;
      };
    };
  };
}

function readCompose(fileName: string): ComposeDocument {
  return yaml.load(fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8')) as ComposeDocument;
}

function environmentMap(service: ComposeService | undefined): Map<string, unknown> {
  const environment = service?.environment;
  if (Array.isArray(environment)) {
    return new Map(
      environment.map((entry) => {
        const separator = entry.indexOf('=');
        return separator < 0
          ? [entry, undefined]
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }
  return new Map(Object.entries(environment ?? {}));
}

function farmEnvironment(fileName: string): Map<string, unknown> {
  return environmentMap(readCompose(fileName).services?.['farm-service']);
}

function helmValidationCommands(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const commands: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index];
    if (sourceLine === undefined) {
      break;
    }
    const line = sourceLine.trim();
    if (line.startsWith('#') || line.startsWith('echo ')) {
      continue;
    }
    const helmStart = line.search(/\bhelm (?:lint|template)\b/);
    if (helmStart === -1) {
      continue;
    }

    let command = line.slice(helmStart);
    while (command.trimEnd().endsWith('\\') && index + 1 < lines.length) {
      index += 1;
      const continuation = lines[index];
      if (continuation === undefined) {
        break;
      }
      command += ` ${continuation.trim()}`;
    }
    commands.push(command);
  }

  return commands;
}

describe('INVARIANT: farm environmental monitoring deployment contract', () => {
  it.each(COMPOSE_FILES)(
    '%s wires the company-owned provider identity, fail-closed gate, and legacy cutover key',
    (fileName) => {
      const environment = farmEnvironment(fileName);
      for (const variable of REQUIRED_ENVIRONMENT) {
        expect(environment.has(variable)).toBe(true);
      }
      expect(String(environment.get('FARM_ENVIRONMENT_MONITORING_ENABLED'))).toContain(
        'FARM_ENVIRONMENT_MONITORING_ENABLED:-false',
      );
      expect(String(environment.get('SENTINEL_HUB_ENCRYPTION_KEY'))).toContain(
        'SENTINEL_HUB_ENCRYPTION_KEY',
      );
    },
  );

  it('renders the Helm farm contract from typed values and a farm-only secret', () => {
    const values = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, 'infrastructure/helm/aquaculture/values.yaml'), 'utf8'),
    ) as HelmValues;
    const farmEnvironment = values.farmService?.env ?? {};

    for (const variable of REQUIRED_ENVIRONMENT.filter(
      (candidate) => candidate !== 'SENTINEL_HUB_ENCRYPTION_KEY',
    )) {
      expect(farmEnvironment).toHaveProperty(variable);
    }
    expect(farmEnvironment['FARM_ENVIRONMENT_MONITORING_ENABLED']).toBe('false');
    expect(values.secrets).toHaveProperty('sentinelHubEncryptionKey');

    const deploymentTemplate = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/helm/aquaculture/templates/backend-services.yaml'),
      'utf8',
    );
    expect(deploymentTemplate).toContain('range $name, $value := .Values.farmService.env');
    expect(deploymentTemplate).toContain('- name: SENTINEL_HUB_ENCRYPTION_KEY');
    expect(deploymentTemplate).toContain('}}-farm-environment-secrets');
    expect(deploymentTemplate).toContain('key: sentinelHubEncryptionKey');

    const secretTemplate = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/helm/aquaculture/templates/secrets.yaml'),
      'utf8',
    );
    expect(secretTemplate).toContain('secrets.sentinelHubEncryptionKey must be set');
    expect(secretTemplate).toContain('}}-farm-environment-secrets');
    expect(secretTemplate).toContain('/sentinel-hub-encryption-key');
  });

  it('keeps every required Helm secret on one CI-render overlay', () => {
    const secretTemplate = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/helm/aquaculture/templates/secrets.yaml'),
      'utf8',
    );
    const ciValues = yaml.load(
      fs.readFileSync(
        path.join(REPO_ROOT, 'infrastructure/helm/aquaculture/values-ci.yaml'),
        'utf8',
      ),
    ) as HelmValues;
    const requiredSecretKeys = [
      ...secretTemplate.matchAll(/required\s+"[^"]+"\s+\.Values\.secrets\.([A-Za-z0-9]+)/g),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

    expect(requiredSecretKeys.length).toBeGreaterThan(0);
    for (const key of new Set(requiredSecretKeys)) {
      expect(String(ciValues.secrets?.[key] ?? '').trim()).not.toBe('');
    }

    const workflowDirectory = path.join(REPO_ROOT, '.github/workflows');
    const workflowSources = fs
      .readdirSync(workflowDirectory)
      .filter((fileName) => /\.ya?ml$/.test(fileName))
      .map((fileName) => fs.readFileSync(path.join(workflowDirectory, fileName), 'utf8'));
    const commands = workflowSources.flatMap(helmValidationCommands);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain('values-ci.yaml');
    }

    const allWorkflows = workflowSources.join('\n');
    expect(allWorkflows).not.toMatch(
      /--set(?:-string|-file|-json)?(?:=|\s+)(?:secrets\.|postgresql\.auth\.password|redis\.auth\.password)/,
    );

    const helmSetupAction = fs.readFileSync(
      path.join(REPO_ROOT, '.github/actions/setup-helm/action.yml'),
      'utf8',
    );
    expect(helmSetupAction).toContain(
      'uses: azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310 # v5.0.1',
    );
    expect(helmSetupAction).toContain('version: v3.16.2');
    expect(allWorkflows).not.toContain('uses: azure/setup-helm@');
    for (const source of workflowSources.filter(
      (workflow) => helmValidationCommands(workflow).length,
    )) {
      expect(source).toContain('uses: ./.github/actions/setup-helm');
    }
  });

  it('runs composition and codegen gates for shared code-first schema sources', () => {
    const sharedSchemaTrigger = "- 'libs/backend-common/src/**/*.ts'";
    for (const workflowPath of [
      '.github/workflows/apollo-supergraph-validate.yml',
      '.github/workflows/graphql-codegen-validate.yml',
    ]) {
      const workflow = fs.readFileSync(path.join(REPO_ROOT, workflowPath), 'utf8');
      const pullRequestMarker = '\n  pull_request:';
      const pullRequestStart = workflow.indexOf(pullRequestMarker);

      expect(pullRequestStart).toBeGreaterThan(-1);
      expect(workflow.slice(0, pullRequestStart)).toContain(sharedSchemaTrigger);
      expect(workflow.slice(pullRequestStart)).toContain(sharedSchemaTrigger);
      expect(workflow.match(/libs\/backend-common\/src\/\*\*\/\*\.ts/g)).toHaveLength(2);
    }

    const codegenWorkflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github/workflows/graphql-codegen-validate.yml'),
      'utf8',
    );
    expect(codegenWorkflow).toContain(
      'git diff --exit-code \\\n            web/shared-ui/src/generated',
    );
    expect(codegenWorkflow).toContain(
      "echo '::error::shared-ui generated GraphQL types are stale.",
    );
  });

  it('keeps Kustomize base and every overlay on the same farm environment contract', () => {
    const configDocuments: KubernetesResource[] = [];
    yaml.loadAll(
      fs.readFileSync(
        path.join(REPO_ROOT, 'infrastructure/kubernetes/base/configmap.yaml'),
        'utf8',
      ),
      (document: unknown) => configDocuments.push(document as KubernetesResource),
    );
    const config = configDocuments.find(
      (document) =>
        document.kind === 'ConfigMap' && document.metadata?.name === 'aquaculture-config',
    );
    for (const variable of REQUIRED_ENVIRONMENT.filter(
      (candidate) => candidate !== 'SENTINEL_HUB_ENCRYPTION_KEY',
    )) {
      expect(config?.data).toHaveProperty(variable);
    }
    expect(config?.data?.['FARM_ENVIRONMENT_MONITORING_ENABLED']).toBe('false');

    const farmDocuments: KubernetesResource[] = [];
    yaml.loadAll(
      fs.readFileSync(
        path.join(REPO_ROOT, 'infrastructure/kubernetes/base/farm-service.yaml'),
        'utf8',
      ),
      (document: unknown) => farmDocuments.push(document as KubernetesResource),
    );
    const deployment = farmDocuments.find(
      (document) => document.kind === 'Deployment' && document.metadata?.name === 'farm-service',
    );
    const container = deployment?.spec?.template?.spec?.containers?.find(
      (candidate) => candidate.name === 'farm-service',
    );
    expect(container?.envFrom).toContainEqual({
      configMapRef: { name: 'aquaculture-config' },
    });
    expect(container?.env).toContainEqual({
      name: 'SENTINEL_HUB_ENCRYPTION_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'farm-environment-secrets',
          key: 'SENTINEL_HUB_ENCRYPTION_KEY',
        },
      },
    });

    const secretSchema = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/kubernetes/base/secrets.yaml'),
      'utf8',
    );
    expect(secretSchema).toContain('name: farm-environment-secrets');
    expect(secretSchema).toContain('Required key: SENTINEL_HUB_ENCRYPTION_KEY');

    for (const overlay of ['dev', 'staging', 'production']) {
      const overlayDocument = yaml.load(
        fs.readFileSync(
          path.join(REPO_ROOT, `infrastructure/kubernetes/overlays/${overlay}/kustomization.yaml`),
          'utf8',
        ),
      ) as { resources?: string[] };
      expect(overlayDocument.resources).toContain('../../base');
    }
  });

  it.each(['docker-compose.prod.yml', 'docker-compose.droplet.yml'])(
    '%s orders the production credential SSoT before farm bootstrap with its own cert identity',
    (fileName) => {
      const document = readCompose(fileName);
      const farm = document.services?.['farm-service'];
      const config = document.services?.['config-service'];
      const farmDependencies = farm?.depends_on as
        | Record<string, { condition?: string }>
        | undefined;
      const configDependencies = config?.depends_on as
        | Record<string, { condition?: string }>
        | undefined;
      const configEnvironment = new Map(Object.entries(config?.environment ?? {}));

      expect(farmDependencies?.['config-service']?.condition).toBe('service_healthy');
      expect(configDependencies?.['redis']?.condition).toBe('service_healthy');
      expect(configDependencies?.['nats']?.condition).toBe('service_healthy');
      expect(configDependencies?.['db-migrate']?.condition).toBe('service_completed_successfully');
      const certPath = String(configEnvironment.get('NATS_TLS_CERT'));
      const keyPath = String(configEnvironment.get('NATS_TLS_KEY'));
      expect(certPath).toMatch(/\/config_service-cert\.pem$/);
      expect(keyPath).toMatch(/\/config_service-key\.pem$/);
      expect(config?.volumes).toEqual(
        expect.arrayContaining([
          expect.stringMatching(
            new RegExp(`:${certPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:ro$`),
          ),
          expect.stringMatching(
            new RegExp(`:${keyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:ro$`),
          ),
        ]),
      );
      expect(configEnvironment.get('NATS_TLS_ENABLED')).toBe('true');
    },
  );

  it('keeps local NATS explicitly anonymous and production NATS cert-mapped', () => {
    for (const fileName of ['docker-compose.yml', 'docker-compose.infra.yml']) {
      const document = yaml.load(
        fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8'),
      ) as ComposeDocument;
      const nats = document.services?.['nats'];
      expect(nats?.command).toEqual(['-js', '--store_dir', '/data', '--http_port', '8222']);
      expect(nats?.volumes ?? []).not.toContain(
        './infrastructure/docker/nats/nats.conf:/etc/nats/nats.conf:ro',
      );
    }

    for (const fileName of ['docker-compose.prod.yml', 'docker-compose.droplet.yml']) {
      const document = yaml.load(
        fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8'),
      ) as ComposeDocument;
      const nats = document.services?.['nats'];
      expect(nats?.volumes ?? []).toContain(
        './infrastructure/docker/nats/nats.conf:/etc/nats/nats.conf:ro',
      );
      expect(nats?.volumes ?? []).toContain(
        './infrastructure/docker/nats/nats-tls-enabled.conf:/etc/nats/nats-tls.conf:ro',
      );
    }
  });

  it('starts config-service in every supported local backend command', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    for (const script of [
      'dev:backend',
      'dev:backend:minimal',
      'dev:backend:core',
      'watch:backend',
      'start:services',
    ]) {
      expect(packageJson.scripts?.[script]).toContain('config-service');
    }
  });

  it.each(['docker-compose.yml', 'docker-compose.dev.yml', 'docker-compose.watch.yml'])(
    '%s starts the credential SSoT before farm-service with one dev signing secret',
    (fileName) => {
      const document = readCompose(fileName);
      const farm = document.services?.['farm-service'];
      const config = document.services?.['config-service'];
      const farmDependencies = farm?.depends_on as
        | Record<string, { condition?: string }>
        | undefined;
      const configDependencies = config?.depends_on as
        | Record<string, { condition?: string }>
        | undefined;
      const farmEnvironment = environmentMap(farm);
      const configEnvironment = environmentMap(config);

      expect(config).toBeDefined();
      expect(farmDependencies?.['config-service']?.condition).toBe('service_healthy');
      expect(configDependencies?.['redis']?.condition).toBe('service_healthy');
      expect(farmEnvironment.get('SERVICE_IDENTITY_SIGNING_SECRET')).toBe(
        configEnvironment.get('SERVICE_IDENTITY_SIGNING_SECRET'),
      );
    },
  );

  it('authenticates the pre-built dev Redis healthcheck used by config-service ordering', () => {
    const redis = readCompose('docker-compose.dev.yml').services?.['redis'];
    expect(redis?.healthcheck?.test).toEqual([
      'CMD-SHELL',
      'REDISCLI_AUTH=${REDIS_PASSWORD:-devpassword} redis-cli ping',
    ]);
  });

  it('declares the network and volumes inherited by the watch topology', () => {
    const watch = readCompose('docker-compose.watch.yml');
    expect(watch.networks).toHaveProperty('aqua-network');
    for (const volume of ['postgres_data', 'redis_data', 'nats_data']) {
      expect(watch.volumes).toHaveProperty(volume);
    }
  });

  it('declares every environmental secret in generated and operator-facing contracts', () => {
    const requiredSecrets = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/deploy/required-secrets.yaml'),
      'utf8',
    );
    const productionExample = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/docker/.env.production.example'),
      'utf8',
    );
    const developmentExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    const deploySecretCatalog = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/deploy/lib/required-env-secrets.sh'),
      'utf8',
    );
    const deploySecretBootstrap = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/deploy/droplet-bootstrap-env.sh'),
      'utf8',
    );
    for (const variable of [
      'CONFIG_ENCRYPTION_KEY',
      'CONFIG_SERVICE_DB_PASS',
      'SENTINEL_HUB_ENCRYPTION_KEY',
      'SERVICE_IDENTITY_KEYRING',
      'SERVICE_IDENTITY_SIGNING_KID',
    ]) {
      expect(requiredSecrets).toContain(`name: ${variable}`);
      expect(productionExample).toContain(`${variable}=`);
    }
    for (const variable of [
      'CONFIG_ENCRYPTION_KEY',
      'FARM_ENVIRONMENT_MONITORING_ENABLED',
      'SENTINEL_HUB_ENCRYPTION_KEY',
      'MET_NORWAY_APPLICATION_NAME',
      'MET_NORWAY_CONTACT',
      'MET_NORWAY_FROST_CLIENT_ID',
    ]) {
      expect(developmentExample).toContain(`${variable}=`);
    }
    expect(deploySecretCatalog).toContain(
      '"SENTINEL_HUB_ENCRYPTION_KEY" "require_preprovisioned_sentinel_hub_key"',
    );
    expect(deploySecretCatalog).toContain('validate_required_env_secret_specs()');
    expect(deploySecretCatalog).not.toContain('SENTINEL_HUB_ENCRYPTION_KEY:');
    expect(deploySecretBootstrap).toContain('value="$("${generator}")"');
    expect(deploySecretBootstrap).not.toMatch(/\beval\b/);
  });

  it('keeps ingestion active-only while retained-schema lifecycle work cannot stop', () => {
    const platformSql = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql',
      ),
      'utf8',
    );
    const environmentCron = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/farm-service/src/weather/services/environment-cron.service.ts'),
      'utf8',
    );
    const credentialCutover = fs.readFileSync(
      path.join(
        REPO_ROOT,
        'apps/farm-service/src/sentinel-hub/sentinel-credential-cutover.service.ts',
      ),
      'utf8',
    );

    expect(platformSql).toContain(
      "ARRAY['active', 'suspended', 'migrating', 'pending_deletion']::TEXT[]",
    );
    expect(environmentCron).toContain(
      'tenants = rotate(await listActiveTenantSchemaIdentities(this.dataSource)',
    );
    expect(environmentCron).toContain(
      'tenants = await listRetainedTenantSchemaIdentities(this.dataSource)',
    );
    expect(credentialCutover).toContain('forEachVerifiedRetainedTenantSchema(');
    expect(credentialCutover).not.toContain('forEachVerifiedTenantSchema(');
  });

  it('ships matching Kubernetes and droplet alerts backed by the emitted metrics', () => {
    const kubernetesRules = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/monitoring/prometheus/alerts/farm-data-ssot-alerts.yml'),
      'utf8',
    );
    const dropletRules = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/monitoring/droplet/rules/40-farm-environment.yml'),
      'utf8',
    );
    for (const metric of [
      'farm_environment_monitoring_enabled',
      'farm_environment_cron_heartbeat_timestamp_seconds',
      'farm_environment_cron_last_run_timestamp_seconds',
      'farm_environment_cron_runs_total',
      'farm_environment_provider_completions_total',
      'farm_environment_lease_discarded_total',
      'farm_environment_due_backlog',
      'farm_environment_oldest_due_age_seconds',
    ]) {
      expect(kubernetesRules).toContain(metric);
      expect(dropletRules).toContain(metric);
    }
    expect(kubernetesRules).toContain(
      'absent(farm_environment_cron_heartbeat_timestamp_seconds{namespace="aquaculture",app="farm-service",job="provider_sync"})',
    );
    expect(dropletRules).toContain(
      'absent(farm_environment_cron_heartbeat_timestamp_seconds{namespace="aquaculture",app="farm-service",job="provider_sync"})',
    );
    expect(kubernetesRules).toContain(
      'absent(farm_environment_cron_last_run_timestamp_seconds{namespace="aquaculture",app="farm-service",job="retention"})',
    );
    expect(dropletRules).toContain(
      'absent(farm_environment_cron_last_run_timestamp_seconds{namespace="aquaculture",app="farm-service",job="retention"})',
    );
    expect(kubernetesRules).toContain(
      'status=~"PARTIAL_FAILURE|PROVIDER_UNAVAILABLE|CONFIGURATION_ERROR"',
    );
    expect(dropletRules).toContain(
      'status=~"PARTIAL_FAILURE|PROVIDER_UNAVAILABLE|CONFIGURATION_ERROR"',
    );
    for (const rules of [kubernetesRules, dropletRules]) {
      expect(rules).not.toContain('farm_sentinel_credential_cutover_pending');
      const retentionBlock = rules.slice(
        rules.indexOf('alert: FarmEnvironmentRetentionStalled'),
        rules.indexOf('alert: FarmEnvironmentCronFailures'),
      );
      expect(retentionBlock).not.toContain('farm_environment_monitoring_enabled');
      expect(retentionBlock).toContain('job="retention"');
    }
  });

  it('routes tenant marine imagery to gateway-api without edge response buffering', () => {
    const dropletNginx = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/nginx/droplet.conf'),
      'utf8',
    );
    const marineRoute = dropletNginx.indexOf('location /api/marine/');
    const adminCatchAll = dropletNginx.indexOf('# ── Admin API REST endpoints');

    expect(marineRoute).toBeGreaterThan(-1);
    expect(adminCatchAll).toBeGreaterThan(marineRoute);
    const dropletMarineBlock = dropletNginx.slice(marineRoute, adminCatchAll);
    expect(dropletMarineBlock).toContain('proxy_pass http://$backend_gw_marine:3000');
    expect(dropletMarineBlock).toContain('proxy_buffering off');

    const productionNginx = fs.readFileSync(
      path.join(REPO_ROOT, 'infrastructure/docker/nginx/nginx.prod.conf'),
      'utf8',
    );
    const productionMarineRoute = productionNginx.indexOf('location /api/marine/');
    const productionRestCatchAll = productionNginx.indexOf(
      'location /api/',
      productionMarineRoute + 1,
    );
    expect(productionMarineRoute).toBeGreaterThan(-1);
    expect(productionRestCatchAll).toBeGreaterThan(productionMarineRoute);
    expect(productionNginx.slice(productionMarineRoute, productionRestCatchAll)).toContain(
      'proxy_buffering off',
    );
    expect(productionNginx.slice(productionMarineRoute, productionRestCatchAll)).toContain(
      'proxy_read_timeout 220s',
    );
    expect(dropletMarineBlock).toContain('proxy_read_timeout 220s');

    const gatewayRoute = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/gateway-api/src/routes/marine.routes.ts'),
      'utf8',
    );
    expect(gatewayRoute).toContain('MARINE_PROXY_REQUEST_TIMEOUT_MS = 210_000');
  });

  it('keeps operational MCP site reads and tenant-admin authority catalog as separate contracts', () => {
    const resolver = fs.readFileSync(
      path.join(REPO_ROOT, 'apps/farm-service/src/site/site.resolver.ts'),
      'utf8',
    );
    const mcpSiteQueries = fs.readFileSync(
      path.join(REPO_ROOT, 'mcp/farm-management/src/graphql/queries/sites.ts'),
      'utf8',
    );

    expect(resolver).toContain("@Query(() => [SiteResponse], { name: 'activeSites' })");
    expect(resolver).toContain(
      "@Query(() => [SiteAccessCatalogItemResponse], { name: 'activeSiteAccessCatalog' })",
    );
    expect(mcpSiteQueries).toContain('query ActiveSites {');
    expect(mcpSiteQueries).toContain('query ActiveSitesLight {');
    expect(resolver).toContain('ACTIVE_SITE_COLLECTION_HARD_CAP + 1');
    expect(resolver).toContain('result.data.length !== result.pagination.total');
  });
});
