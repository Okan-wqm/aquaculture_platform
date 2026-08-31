#!/usr/bin/env ts-node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type * as BootInvariantModule from '../../libs/backend-common/src/constants/boot-invariant-signals';
import type * as ServiceCatalogModule from '../../platform/libs/service-catalog/src/index';

const requireFromRepository = createRequire(resolve(process.cwd(), 'package.json'));
const { BOOT_INVARIANT_SIGNALS } = requireFromRepository(
  './libs/backend-common/src/constants/boot-invariant-signals.ts',
) as typeof BootInvariantModule;
const {
  PLATFORM_SERVICE_CATALOG,
  activeDropletServices,
  backendImageBuildTargets,
  frontendImageBuildTargets,
  frontendPrebuildPlan,
  gatewaySubgraphs,
  getServiceCatalogEntry,
  imageBuildTargets,
  infraImageBuildMatrix,
  infraImageBuildTargets,
  readinessServices,
  readinessSlaSeconds,
  requiredRuntimeEnv,
  requiredRuntimeSecrets,
  serviceDbRolePrefixes,
  validateServiceCatalog,
} = requireFromRepository(
  './platform/libs/service-catalog/src/index.ts',
) as typeof ServiceCatalogModule;

// npm invokes this command at the repository root. Resolving from cwd keeps the
// generator independent of Node's CJS/ESM entrypoint mode; the catalog itself
// is loaded through createRequire above so its extensionless TypeScript imports
// use ts-node's CommonJS resolver on every supported Node release.
const REPO_ROOT = resolve(process.cwd());
const CATALOG_PATH = 'platform/libs/service-catalog/src/index.ts';
const GENERATOR_PATH = 'scripts/service-catalog/generate-artifacts.ts';
const GENERATOR_VERSION = 4;

interface Artifact {
  path: string;
  contents: string;
}

function repoPath(path: string): string {
  return resolve(REPO_ROOT, path);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function catalogHash(): string {
  return sha256(readFileSync(repoPath(CATALOG_PATH), 'utf8'));
}

/**
 * Pretty-printed JSON for COMMITTED FILE ARTIFACTS (stable diffs,
 * human review). This is the single indent-formatting site in the
 * generator. The no-restricted-syntax ban on indented JSON.stringify
 * targets multi-line LOG output breaking structured JSON logging —
 * file-artifact generation is outside that rule's intent, hence the
 * one documented exemption below.
 */
function prettyJson(value: unknown): string {
  // eslint-disable-next-line no-restricted-syntax -- file-artifact formatting, not log output; see function header.
  return JSON.stringify(value, null, 2);
}

function headerMetadata(): Record<string, unknown> {
  return {
    generatedFrom: CATALOG_PATH,
    generator: GENERATOR_PATH,
    generatorVersion: GENERATOR_VERSION,
    catalogHash: catalogHash(),
    note: 'do not edit by hand',
  };
}

function header(format: 'json' | 'yaml'): string {
  if (format === 'json') {
    return prettyJson(headerMetadata());
  }

  const lines = [
    'Generated from platform service catalog.',
    `source: ${CATALOG_PATH}`,
    `generator: ${GENERATOR_PATH}`,
    `generatorVersion: ${GENERATOR_VERSION}`,
    `catalogHash: ${catalogHash()}`,
    'do not edit by hand',
  ];
  return lines.map((line) => `# ${line}`).join('\n');
}

function jsonArtifact(value: Record<string, unknown>): string {
  return `${prettyJson({ metadata: headerMetadata(), ...value })}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[], indent: string): string {
  return values.map((value) => `${indent}- ${value}`).join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellAssignment(name: string, values: readonly string[]): string {
  return `${name}=${shellQuote(values.join(' '))}`;
}

function frontendModulePath(serviceId: string): string {
  // Catalog entry is the SSOT for module paths (INFRA-HIGH-005: the old
  // per-script convention diverged from the npm-workspace reality).
  const modulePath = getServiceCatalogEntry(serviceId)?.modulePath;
  if (!modulePath) {
    throw new Error(`No catalog modulePath for frontend service ${serviceId}`);
  }
  return modulePath;
}

function frontendDockerfile(serviceId: string): string {
  if (serviceId === 'shell') return 'infrastructure/docker/Dockerfile.shell';
  if (serviceId === 'aquamobil') return 'infrastructure/docker/Dockerfile.aquamobil';
  return 'infrastructure/docker/Dockerfile.microfrontend.simple';
}

function signalEmitterSources(key: string): readonly string[] {
  if (key === 'nats_auth_mode_mtls') {
    return ['platform/libs/event-bus/src/nats/nats-event-bus.ts'];
  }
  if (key === 'schema_drift_clean') {
    return ['libs/backend-common/src/database/schema-drift-validator.service.ts'];
  }
  if (key === 'db_migrate_complete') {
    return ['apps/db-migrate/src/main.ts'];
  }
  throw new Error(`No emitter source mapping for boot signal ${key}`);
}

function apolloSubgraphsArtifact(): Artifact {
  return {
    path: 'infrastructure/apollo-router/subgraphs.json',
    contents: jsonArtifact({
      federationVersion: '=2.10.0',
      runtimeMode: 'self-hosted-static-supergraph',
      subgraphs: gatewaySubgraphs().map((entry) => ({
        ...entry,
        schemaUrl: entry.routingUrl,
      })),
      excludedFederatedServices: PLATFORM_SERVICE_CATALOG.filter(
        (entry) =>
          entry.gatewayParticipation !== 'apollo-subgraph' && entry.classification === 'subgraph',
      ).map((entry) => ({
        name: entry.serviceId,
        owner: 'platform-service-catalog',
        removeAfterRelease: `${entry.serviceId}-gateway-participation-cutover`,
        reason:
          'not registered in gatewaySubgraphs(); promotion requires catalog gatewayParticipation change',
      })),
    }),
  };
}

function criticalityArtifact(): Artifact {
  const services = activeDropletServices().map((entry) => {
    const profiles = entry.deployProfiles.filter((profile) => profile !== 'droplet');
    return [
      `  - name: ${entry.composeServiceName}`,
      `    level: ${entry.criticality}`,
      ...(profiles.length > 0 ? [`    profiles: [${profiles.join(', ')}]`] : []),
      `    reason: ${yamlString(`generated from ${entry.serviceId} criticality in platform service catalog`)}`,
    ].join('\n');
  });

  // DEPLOY-SSOT: readiness SLA is DERIVED from the catalog, not typed.
  // = max(startupBudgetSeconds over CRITICAL services) + margin. Replaces the
  // former hardcoded `readiness_sla_seconds: 300` literal that drifted freely
  // from the per-service compose start_period values it was supposed to bound.
  const readinessSla = readinessSlaSeconds();

  return {
    path: 'infrastructure/deploy/service-criticality.yaml',
    contents: `${header('yaml')}
schema_version: 1
defaults:
  readiness_sla_seconds: ${readinessSla}
services:
${services.join('\n')}\n`,
  };
}

function requiredSignalsArtifact(): Artifact {
  const signalLibrary = Object.entries(BOOT_INVARIANT_SIGNALS).map(([key, signal]) =>
    [
      `  ${key}:`,
      `    pattern: ${yamlString(signal.pattern)}`,
      `    description: ${yamlString(signal.description)}`,
      '    canonicalSource: "libs/backend-common/src/constants/boot-invariant-signals.ts"',
      '    emitterSources:',
      yamlList(signalEmitterSources(key), '      '),
    ].join('\n'),
  );
  const services = activeDropletServices()
    .filter((entry) => entry.requiredSignals.length > 0)
    .map((entry) =>
      [
        `  - name: ${entry.composeServiceName}`,
        '    signals:',
        yamlList(entry.requiredSignals, '      '),
      ].join('\n'),
    );

  return {
    path: 'infrastructure/deploy/required-signals.yaml',
    contents: `${header('yaml')}
schema_version: 2
# window_seconds is the MAX time a service has to emit each required boot signal
# before the deploy gate declares it missing. assert-service-signals.ts polls and
# passes the instant every signal appears, so a wide window is free for fast
# services — it only prevents FALSE failures for healthy-but-slow boots. On a
# contended single-droplet cold-start (all ~25 containers booting at once +
# gateway supergraph composition retrying while auth-service warms up), the
# heaviest backend's schema_drift_clean scan (77 entities × per-tenant schemas)
# legitimately emitted ~220s in — past the former 120s default, false-failing the
# gate into a rollback even though every container was healthy. 300s (the value
# db-migrate already used) gives margin; a genuinely dead service still fails,
# just later.
defaults:
  window_seconds: 300
signal_library:
${signalLibrary.join('\n')}
services:
${services.join('\n')}\n`,
  };
}

function composeRequiredVariables(composePath: string): readonly string[] {
  const compose = readFileSync(repoPath(composePath), 'utf8');
  return [
    ...new Set(
      [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)]
        .map((match) => match[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
}

function requiredSecretsArtifact(): Artifact {
  const composeFile = 'docker-compose.droplet.yml';
  const runtimeEnv = new Set(['TAG', ...requiredRuntimeEnv()]);
  const catalogSecrets = new Set(requiredRuntimeSecrets());
  const variables = composeRequiredVariables(composeFile);
  const declaredVariables = new Set([...runtimeEnv, ...catalogSecrets]);
  const undeclaredVariables = variables.filter((name) => !declaredVariables.has(name));
  if (undeclaredVariables.length > 0) {
    throw new Error(
      `${composeFile} requires variables not declared in the platform service catalog: ${undeclaredVariables.join(
        ', ',
      )}`,
    );
  }
  const runtimeEntries = variables.filter(
    (name) => runtimeEnv.has(name) && !catalogSecrets.has(name),
  );
  const secretEntries = variables.filter((name) => !runtimeEntries.includes(name));

  const renderEntry = (
    name: string,
    purposePrefix: string,
    klass: 'runtime-env' | 'secret',
  ): string =>
    [
      `  - name: ${name}`,
      '    owner: platform-service-catalog',
      `    class: ${klass}`,
      `    purpose: ${yamlString(`${purposePrefix}; generated from active droplet compose and platform service catalog`)}`,
      `    rotation_intent: ${yamlString(klass === 'secret' ? 'rotate through deploy secret bootstrap or external vault' : 'operator supplied per release')}`,
      `    provisioning_mode: ${yamlString(klass === 'secret' ? 'first-run bootstrap or external secret manager' : 'deploy environment')}`,
      `    required_by: [${composeFile}]`,
    ].join('\n');

  return {
    path: 'infrastructure/deploy/required-secrets.yaml',
    contents: `${header('yaml')}
version: 1
compose_files:
  - ${composeFile}
runtime_required_env:
${runtimeEntries.map((name) => renderEntry(name, 'runtime deploy variable', 'runtime-env')).join('\n')}
secrets:
${secretEntries.map((name) => renderEntry(name, 'secret deploy variable', 'secret')).join('\n')}\n`,
  };
}

function catalogDeployEnvArtifact(): Artifact {
  const frontendTargets = [...frontendImageBuildTargets()];
  // frontendPrebuildPlan() is the SSOT split: dockerfile-self-build
  // targets (aquamobil) appear in NEITHER list — their Dockerfile owns
  // the asset build (INFRA-HIGH-005).
  const prebuild = frontendPrebuildPlan();
  const nxFrontend = prebuild.nxProjects;
  const nonNxFrontend = prebuild.workspaceModules.map((entry) => entry.module);
  const readySpecs = readinessServices().map((entry) => `${entry.serviceId}:${entry.port}`);
  const gatewayRecompositionServices = gatewaySubgraphs().map((entry) => entry.nxProject);

  return {
    path: 'infrastructure/deploy/service-catalog.deploy.vars',
    contents: `${header('yaml')}
${shellAssignment('CATALOG_BACKEND_IMAGE_SERVICES', [...backendImageBuildTargets()])}
${shellAssignment('CATALOG_FRONTEND_IMAGE_SERVICES', frontendTargets)}
${shellAssignment('CATALOG_INFRA_IMAGE_SERVICES', [...infraImageBuildTargets()])}
${shellAssignment('CATALOG_APPLICATION_IMAGE_SERVICES', [...imageBuildTargets()])}
${shellAssignment('CATALOG_SERVICE_DB_ROLE_PREFIXES', [...serviceDbRolePrefixes()])}
${shellAssignment('CATALOG_GATEWAY_RECOMPOSITION_SERVICES', gatewayRecompositionServices)}
${shellAssignment('CATALOG_NX_FRONTEND_PROJECTS', nxFrontend)}
${shellAssignment('CATALOG_NON_NX_FRONTEND_PROJECTS', nonNxFrontend)}
${shellAssignment('CATALOG_READINESS_SERVICES', readySpecs)}
`,
  };
}

function catalogGeneratedArtifact(): Artifact {
  const frontendTargets = [...frontendImageBuildTargets()];
  // Same SSOT split as catalogDeployEnvArtifact — one derivation, two artifacts.
  const prebuild = frontendPrebuildPlan();
  const nxFrontend = prebuild.nxProjects;
  const nonNxFrontend = prebuild.workspaceModules.map((entry) => entry.module);

  return {
    path: 'infrastructure/deploy/service-catalog.generated.json',
    contents: jsonArtifact({
      activeDropletComposeServices: activeDropletServices().map(
        (entry) => entry.composeServiceName,
      ),
      imageBuildTargets: activeDropletServices()
        .filter((entry) => entry.imageTarget && entry.buildKind !== 'infra')
        .map((entry) => entry.imageTarget),
      deploy: {
        backendImageTargets: backendImageBuildTargets(),
        frontendImageTargets: frontendTargets,
        infraImageTargets: infraImageBuildTargets(),
        applicationImageServices: imageBuildTargets(),
        serviceDbRolePrefixes: serviceDbRolePrefixes(),
        nxFrontendProjects: nxFrontend,
        nonNxFrontendProjects: nonNxFrontend,
        // module → workspacePath pairs for the npm-workspace prebuild
        // lane; deploy workflows MUST resolve build paths from here,
        // never from a `web/modules/${mod}` convention (INFRA-HIGH-005).
        nonNxFrontendBuild: prebuild.workspaceModules,
        readinessServices: readinessServices(),
        frontendImageMatrix: frontendTargets.map((target) => ({
          module: target,
          dockerfile: frontendDockerfile(target),
          module_path: frontendModulePath(target),
          nx_project: getServiceCatalogEntry(target)?.nxProject ?? target,
        })),
        infraImageMatrix: infraImageBuildMatrix(),
      },
      packageBuildProjects: activeDropletServices()
        .filter(
          (entry) =>
            entry.nxProject && ['node-service', 'frontend', 'one-shot'].includes(entry.buildKind),
        )
        .map((entry) => entry.nxProject),
      requiredRuntimeEnv: requiredRuntimeEnv(),
      requiredRuntimeSecrets: requiredRuntimeSecrets(),
      dbSchemas: PLATFORM_SERVICE_CATALOG.filter((entry) => entry.dbSchema).map((entry) => ({
        serviceId: entry.serviceId,
        schema: entry.dbSchema,
        migrationGlobs: entry.migrationGlobs ?? [],
        entityGlobs: entry.entityGlobs ?? [],
        postMigrationHardening: entry.postMigrationHardening === true,
        dbRoles: entry.dbRoles ?? {},
        privilegeMode: entry.privilegeMode,
      })),
    }),
  };
}

/**
 * Prometheus file_sd scrape targets for the droplet (D3 / ORPHAN-HIGH-090:
 * the droplet runs no collector because nothing generated scrape targets).
 * Every catalog service that exposes a Prometheus endpoint becomes a target
 * keyed by its compose service name + the shared HTTP port (containerPort —
 * /metrics and /health share one listener; there is no separate metricsPort).
 * The catalog is the SSoT, so the scrape config CANNOT drift from the running
 * service set — the generator --check gate fails CI on any unregenerated edit.
 * The injected `app` + `namespace` labels are exactly what the dormant alert
 * rules (aquaculture-rules.yaml) group by; `criticality` lets Alertmanager
 * route by service importance without a second source of truth. Output is the
 * native Prometheus file_sd shape (a bare array of target groups) — provenance
 * is enforced by the generator, not by an in-file metadata object the scraper
 * would reject.
 */
function prometheusScrapeTargetsArtifact(): Artifact {
  const targetGroups = activeDropletServices()
    .filter((entry) => entry.metricsExposure === 'prom-endpoint')
    .map((entry) => ({
      targets: [`${entry.composeServiceName}:${entry.containerPort}`],
      labels: {
        app: entry.serviceId,
        namespace: 'aquaculture',
        criticality: entry.criticality,
      },
    }));
  return {
    path: 'infrastructure/monitoring/droplet/file_sd/aqua-services.json',
    contents: `${prettyJson(targetGroups)}\n`,
  };
}

function artifacts(): readonly Artifact[] {
  const errors = validateServiceCatalog();
  if (errors.length > 0) {
    throw new Error(
      `Service catalog is invalid:\n${errors.map((error) => `- ${error.serviceId}: ${error.message}`).join('\n')}`,
    );
  }
  return [
    apolloSubgraphsArtifact(),
    criticalityArtifact(),
    requiredSignalsArtifact(),
    requiredSecretsArtifact(),
    catalogDeployEnvArtifact(),
    catalogGeneratedArtifact(),
    prometheusScrapeTargetsArtifact(),
  ];
}

function main(): void {
  const check = process.argv.includes('--check');
  const mismatches: string[] = [];

  for (const artifact of artifacts()) {
    const target = repoPath(artifact.path);
    if (check) {
      if (!existsSync(target)) {
        mismatches.push(`${artifact.path} is missing`);
        continue;
      }
      const existing = readFileSync(target, 'utf8');
      if (existing !== artifact.contents) {
        mismatches.push(`${artifact.path} is out of date`);
      }
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, artifact.contents);
    process.stdout.write(`generated ${artifact.path}\n`);
  }

  if (mismatches.length > 0) {
    throw new Error(
      `service catalog generated artifacts are out of date:\n${mismatches.join('\n')}`,
    );
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
