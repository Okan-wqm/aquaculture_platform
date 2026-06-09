#!/usr/bin/env ts-node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_SERVICE_CATALOG,
  activeDropletServices,
  backendImageBuildTargets,
  frontendImageBuildTargets,
  gatewaySubgraphs,
  imageBuildTargets,
  infraImageBuildTargets,
  readinessServices,
  requiredRuntimeEnv,
  requiredRuntimeSecrets,
  serviceDbRolePrefixes,
  validateServiceCatalog,
} from '../../platform/libs/service-catalog/src/index.ts';
import { BOOT_INVARIANT_SIGNALS } from '../../libs/backend-common/src/constants/boot-invariant-signals.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG_PATH = 'platform/libs/service-catalog/src/index.ts';
const GENERATOR_PATH = 'scripts/service-catalog/generate-artifacts.ts';
const GENERATOR_VERSION = 2;

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

function header(format: 'json' | 'yaml'): string {
  const lines = [
    'Generated from platform service catalog.',
    `source: ${CATALOG_PATH}`,
    `generator: ${GENERATOR_PATH}`,
    `generatorVersion: ${GENERATOR_VERSION}`,
    `catalogHash: ${catalogHash()}`,
    'do not edit by hand',
  ];

  if (format === 'json') {
    return `${JSON.stringify(
      {
        generatedFrom: CATALOG_PATH,
        generator: GENERATOR_PATH,
        generatorVersion: GENERATOR_VERSION,
        catalogHash: catalogHash(),
        note: 'do not edit by hand',
      },
      null,
      2,
    )}`;
  }

  return lines.map((line) => `# ${line}`).join('\n');
}

function jsonArtifact(value: Record<string, unknown>): string {
  const metadata = JSON.parse(header('json')) as Record<string, unknown>;
  return `${JSON.stringify({ metadata, ...value }, null, 2)}\n`;
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
  if (serviceId === 'shell') return 'web/shell';
  if (serviceId === 'aquamobil') return 'web/apps/aquamobil';
  return `web/modules/${serviceId}`;
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
        (entry) => entry.gatewayParticipation !== 'apollo-subgraph' && entry.classification === 'subgraph',
      ).map((entry) => ({
        name: entry.serviceId,
        owner: 'platform-service-catalog',
        removeAfterRelease: `${entry.serviceId}-gateway-participation-cutover`,
        reason: 'not registered in gatewaySubgraphs(); promotion requires catalog gatewayParticipation change',
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

  return {
    path: 'infrastructure/deploy/service-criticality.yaml',
    contents: `${header('yaml')}
schema_version: 1
defaults:
  readiness_sla_seconds: 300
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
        ...(entry.composeServiceName === 'db-migrate' ? ['    window_seconds: 300'] : []),
      ].join('\n'),
    );

  return {
    path: 'infrastructure/deploy/required-signals.yaml',
    contents: `${header('yaml')}
schema_version: 2
defaults:
  window_seconds: 120
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
  const runtimeEntries = variables.filter((name) => runtimeEnv.has(name) && !catalogSecrets.has(name));
  const secretEntries = variables.filter((name) => !runtimeEntries.includes(name));

  const renderEntry = (name: string, purposePrefix: string, klass: 'runtime-env' | 'secret'): string =>
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
  const nxFrontend = activeDropletServices()
    .filter((entry) => entry.buildKind === 'frontend' && entry.nxProject)
    .map((entry) => entry.nxProject!)
    .sort();
  const nonNxFrontend = frontendTargets.filter((target) => !nxFrontend.includes(target));
  const readySpecs = readinessServices().map((entry) => `${entry.serviceId}:${entry.port}`);

  return {
    path: 'infrastructure/deploy/service-catalog.deploy.vars',
    contents: `${header('yaml')}
${shellAssignment('CATALOG_BACKEND_IMAGE_SERVICES', [...backendImageBuildTargets()])}
${shellAssignment('CATALOG_FRONTEND_IMAGE_SERVICES', frontendTargets)}
${shellAssignment('CATALOG_INFRA_IMAGE_SERVICES', [...infraImageBuildTargets()])}
${shellAssignment('CATALOG_APPLICATION_IMAGE_SERVICES', [...imageBuildTargets()])}
${shellAssignment('CATALOG_SERVICE_DB_ROLE_PREFIXES', [...serviceDbRolePrefixes()])}
${shellAssignment('CATALOG_NX_FRONTEND_PROJECTS', nxFrontend)}
${shellAssignment('CATALOG_NON_NX_FRONTEND_PROJECTS', nonNxFrontend)}
${shellAssignment('CATALOG_READINESS_SERVICES', readySpecs)}
`,
  };
}

function catalogGeneratedArtifact(): Artifact {
  const frontendTargets = [...frontendImageBuildTargets()];
  const nxFrontend = activeDropletServices()
    .filter((entry) => entry.buildKind === 'frontend' && entry.nxProject)
    .map((entry) => entry.nxProject!)
    .sort();
  const nonNxFrontend = frontendTargets.filter((target) => !nxFrontend.includes(target));

  return {
    path: 'infrastructure/deploy/service-catalog.generated.json',
    contents: jsonArtifact({
      activeDropletComposeServices: activeDropletServices().map((entry) => entry.composeServiceName),
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
        readinessServices: readinessServices(),
        frontendImageMatrix: frontendTargets.map((target) => ({
          module: target,
          dockerfile: frontendDockerfile(target),
          module_path: frontendModulePath(target),
        })),
        infraImageMatrix: infraImageBuildTargets().map((target) => {
          if (target !== 'mosquitto') {
            throw new Error(`No infra image matrix mapping for ${target}`);
          }
          return {
            image: 'mosquitto',
            dockerfile: 'infrastructure/mosquitto/Dockerfile',
            context: 'infrastructure/mosquitto',
          };
        }),
      },
      packageBuildProjects: activeDropletServices()
        .filter((entry) => entry.nxProject && ['node-service', 'frontend', 'one-shot'].includes(entry.buildKind))
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
    writeFileSync(target, artifact.contents);
    console.log(`generated ${artifact.path}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`service catalog generated artifacts are out of date:\n${mismatches.join('\n')}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
