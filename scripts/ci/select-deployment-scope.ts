#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

interface FrontendMatrixEntry {
  readonly dockerfile: string;
  readonly module: string;
  readonly module_path: string;
  readonly nx_project: string;
}

interface InfraMatrixEntry {
  readonly buildInputGlobs: string[];
  readonly context: string;
  readonly dockerfile: string;
  readonly image: string;
}

interface GeneratedCatalog {
  readonly dbSchemas: Array<{
    readonly migrationGlobs: string[];
    readonly serviceId: string;
  }>;
  readonly deploy: {
    readonly backendImageTargets: string[];
    readonly frontendImageMatrix: FrontendMatrixEntry[];
    readonly frontendImageTargets: string[];
    readonly infraImageMatrix: InfraMatrixEntry[];
    readonly infraImageTargets: string[];
    readonly nxFrontendProjects?: string[];
  };
}

interface Arguments {
  readonly affectedProjects: string[];
  readonly changedFiles: string[];
  readonly channel: string;
  readonly fullValidation: boolean;
  readonly repo: string;
  readonly requestedServices: string;
}

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface BackendMatrixEntry {
  readonly dockerfile: string;
  readonly service: string;
}

export interface DeploymentScope {
  readonly backendMatrix: BackendMatrixEntry[];
  readonly dependencyAuditRequired: boolean;
  readonly deployServices: string[];
  readonly farmChecksRequired: boolean;
  readonly frontendMatrix: FrontendMatrixEntry[];
  readonly fullDeploy: boolean;
  readonly infraMatrix: InfraMatrixEntry[];
  readonly migrationRequired: boolean;
  readonly reason: string;
  readonly rustChecksRequired: boolean;
  readonly sensorChecksRequired: boolean;
}

function argumentValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return '';
  return argv[index + 1] ?? '';
}

function hasArgument(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function stringArray(value: string, field: string): string[] {
  const parsed = JSON.parse(value || '[]') as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`${field} must be a JSON string array`);
  }
  return [...new Set(parsed)].sort();
}

function gitChangedFiles(repo: string, baseSha: string, headSha: string): string[] {
  if (!baseSha || !headSha) {
    throw new Error('--base-sha and --head-sha are required without changed-files override');
  }
  return execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMRD', baseSha, headSha, '--'],
    { cwd: repo, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function nxAffectedProjects(
  repo: string,
  baseSha: string,
  headSha: string,
  fullValidation: boolean,
): string[] {
  if (!headSha) {
    throw new Error('--head-sha is required without affected-projects override');
  }
  const nxArguments = fullValidation
    ? ['show', 'projects', '--json']
    : ['show', 'projects', '--affected', `--base=${baseSha}`, `--head=${headSha}`, '--json'];
  const output = execFileSync(join(repo, 'node_modules/.bin/nx'), nxArguments, {
    cwd: repo,
    encoding: 'utf8',
  });
  return stringArray(output, 'Nx affected projects');
}

function parseArguments(argv: readonly string[]): Arguments {
  const repo = resolve(argumentValue(argv, '--repo') || process.cwd());
  const baseSha = argumentValue(argv, '--base-sha');
  const headSha = argumentValue(argv, '--head-sha');
  const fullValidation = argv.includes('--full-validation') || baseSha === EMPTY_TREE_SHA;
  return {
    affectedProjects: hasArgument(argv, '--affected-projects-json')
      ? stringArray(argumentValue(argv, '--affected-projects-json'), 'affected projects')
      : nxAffectedProjects(repo, baseSha, headSha, fullValidation),
    changedFiles: hasArgument(argv, '--changed-files-json')
      ? stringArray(argumentValue(argv, '--changed-files-json'), 'changed files')
      : gitChangedFiles(repo, baseSha, headSha),
    channel: argumentValue(argv, '--channel') || 'development',
    fullValidation,
    repo,
    requestedServices: argumentValue(argv, '--requested-services') || 'auto',
  };
}

function loadCatalog(repo: string): GeneratedCatalog {
  return JSON.parse(
    readFileSync(join(repo, 'infrastructure/deploy/service-catalog.generated.json'), 'utf8'),
  ) as GeneratedCatalog;
}

function backendMatrix(services: readonly string[]): BackendMatrixEntry[] {
  return services.map((service) => ({
    service,
    dockerfile:
      service === 'db-migrate'
        ? 'infrastructure/docker/Dockerfile.db-migrate'
        : 'infrastructure/docker/Dockerfile.backend.simple',
  }));
}

const WORKSPACE_GLOBAL_INPUTS = new Set([
  '.npmrc',
  'nx.json',
  'package-lock.json',
  'package.json',
  'tsconfig.base.json',
]);

function isWorkspaceGlobalInput(file: string): boolean {
  return (
    WORKSPACE_GLOBAL_INPUTS.has(file) ||
    file.startsWith('tools/build/') ||
    /^tsconfig\.[^/]+\.json$/.test(file)
  );
}

function isDeployControlPlane(file: string): boolean {
  return (
    /^docker-compose(?:\.[^/]+)?\.ya?ml$/.test(file) ||
    file.startsWith('.github/actions/') ||
    file.startsWith('.github/manifests/') ||
    file.startsWith('.github/workflows/') ||
    file.startsWith('infrastructure/deploy/') ||
    file.startsWith('infrastructure/nats/') ||
    file.startsWith('scripts/deploy/')
  );
}

function isDocumentation(file: string): boolean {
  return (
    file.startsWith('docs/') || /(?:^|\/)README\.md$/i.test(file) || /^\w[\w.-]*\.md$/i.test(file)
  );
}

function globToRegExp(glob: string): RegExp {
  let expression = '';
  let inBrace = false;

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? '';
    if (character === '*') {
      if (glob[index + 1] === '*') {
        expression += '.*';
        index += 1;
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else if (character === '[') {
      let characterClass = '[';
      let classIndex = index + 1;
      if (glob[classIndex] === '!' || glob[classIndex] === '^') {
        characterClass += '^';
        classIndex += 1;
      }
      while (classIndex < glob.length && glob[classIndex] !== ']') {
        characterClass += glob[classIndex];
        classIndex += 1;
      }
      characterClass += ']';
      expression += characterClass;
      index = classIndex;
    } else if (character === '{') {
      inBrace = true;
      expression += '(?:';
    } else if (character === '}') {
      inBrace = false;
      expression += ')';
    } else if (character === ',' && inBrace) {
      expression += '|';
    } else {
      expression += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }

  return new RegExp(`^${expression}$`);
}

function migrationOwners(catalog: GeneratedCatalog, changedFiles: readonly string[]): Set<string> {
  return new Set(
    catalog.dbSchemas
      .filter((schema) =>
        changedFiles.some((file) =>
          schema.migrationGlobs.some((glob) => globToRegExp(glob).test(file)),
        ),
      )
      .map((schema) => schema.serviceId),
  );
}

interface SpecialistChecks {
  readonly dependencyAuditRequired: boolean;
  readonly farmChecksRequired: boolean;
  readonly rustChecksRequired: boolean;
  readonly sensorChecksRequired: boolean;
}

const ALL_SPECIALIST_CHECKS: SpecialistChecks = {
  dependencyAuditRequired: true,
  farmChecksRequired: true,
  rustChecksRequired: true,
  sensorChecksRequired: true,
};

function allScope(
  catalog: GeneratedCatalog,
  reason: string,
  checks: SpecialistChecks = ALL_SPECIALIST_CHECKS,
): DeploymentScope {
  return {
    backendMatrix: backendMatrix(catalog.deploy.backendImageTargets),
    ...checks,
    deployServices: [
      ...catalog.deploy.backendImageTargets,
      ...catalog.deploy.frontendImageTargets,
      ...catalog.deploy.infraImageTargets,
    ],
    frontendMatrix: catalog.deploy.frontendImageMatrix,
    fullDeploy: true,
    infraMatrix: catalog.deploy.infraImageMatrix,
    migrationRequired: true,
    reason,
  };
}

function specialistChecks(args: Arguments): SpecialistChecks {
  const affected = new Set(args.affectedProjects);
  const changed = (prefix: string): boolean =>
    args.changedFiles.some((file) => file === prefix || file.startsWith(`${prefix}/`));

  return {
    dependencyAuditRequired: args.changedFiles.some((file) =>
      /(?:^|\/)package(?:-lock)?\.json$/.test(file),
    ),
    farmChecksRequired:
      affected.has('farm-service') || affected.has('farm-module') || changed('apps/farm-service'),
    rustChecksRequired:
      affected.has('sensor-ingestion') ||
      changed('sens-api-gateway') ||
      changed('apps/sensor-ingestion'),
    sensorChecksRequired:
      affected.has('sensor-service') ||
      affected.has('sensor-module') ||
      affected.has('sensor-contracts') ||
      affected.has('sensor-ingestion') ||
      changed('apps/sensor-service') ||
      changed('apps/sensor-ingestion') ||
      changed('sens-api-gateway'),
  };
}

function requestedScope(
  catalog: GeneratedCatalog,
  requestedServices: string,
  checks: SpecialistChecks,
): DeploymentScope {
  const requested = new Set(
    requestedServices
      .split(',')
      .map((service) => service.trim())
      .filter(Boolean),
  );
  const knownServices = new Set([
    ...catalog.deploy.backendImageTargets,
    ...catalog.deploy.frontendImageTargets,
    ...catalog.deploy.infraImageTargets,
  ]);
  const unknown = [...requested].filter((service) => !knownServices.has(service));
  if (requested.size === 0 || unknown.length > 0) {
    throw new Error(
      unknown.length > 0
        ? `unknown requested services: ${unknown.join(', ')}`
        : 'requested-services CSV must contain at least one service',
    );
  }

  const selectedBackend = catalog.deploy.backendImageTargets.filter((service) =>
    requested.has(service),
  );
  const selectedFrontend = catalog.deploy.frontendImageTargets.filter((service) =>
    requested.has(service),
  );
  const selectedInfra = catalog.deploy.infraImageTargets.filter((service) =>
    requested.has(service),
  );
  const frontendOnly = selectedFrontend.length === requested.size;
  if (!frontendOnly && !selectedBackend.includes('db-migrate')) {
    selectedBackend.unshift('db-migrate');
  }

  return {
    backendMatrix: backendMatrix(selectedBackend),
    ...checks,
    deployServices: [...selectedBackend, ...selectedFrontend, ...selectedInfra],
    frontendMatrix: catalog.deploy.frontendImageMatrix.filter((entry) =>
      selectedFrontend.includes(entry.module),
    ),
    fullDeploy: false,
    infraMatrix: catalog.deploy.infraImageMatrix.filter((entry) =>
      selectedInfra.includes(entry.image),
    ),
    migrationRequired: !frontendOnly,
    reason: 'requested-services',
  };
}

export function selectDeploymentScope(args: Arguments): DeploymentScope {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.channel)) {
    throw new Error(`unsupported deployment channel: ${args.channel}`);
  }

  const catalog = loadCatalog(args.repo);
  const checks = specialistChecks(args);
  if (args.fullValidation) {
    return allScope(catalog, 'full-validation');
  }
  if (args.requestedServices === 'all') {
    return allScope(catalog, 'requested-all');
  }
  if (args.requestedServices !== 'auto') {
    return requestedScope(catalog, args.requestedServices, checks);
  }
  if (args.changedFiles.some(isDeployControlPlane)) {
    return allScope(catalog, 'deploy-control-plane', checks);
  }
  if (args.changedFiles.some(isWorkspaceGlobalInput)) {
    return allScope(catalog, 'workspace-global-input');
  }
  if (args.changedFiles.length > 0 && args.changedFiles.every(isDocumentation)) {
    return {
      backendMatrix: [],
      ...checks,
      deployServices: [],
      farmChecksRequired: false,
      frontendMatrix: [],
      fullDeploy: false,
      infraMatrix: [],
      migrationRequired: false,
      reason: 'docs-only',
      rustChecksRequired: false,
      sensorChecksRequired: false,
    };
  }

  const affected = new Set(args.affectedProjects);
  const owners = migrationOwners(catalog, args.changedFiles);
  const backendDockerfileChanged = args.changedFiles.includes(
    'infrastructure/docker/Dockerfile.backend.simple',
  );
  const dbMigrateDockerfileChanged = args.changedFiles.includes(
    'infrastructure/docker/Dockerfile.db-migrate',
  );
  const changedDockerfiles = new Set(
    args.changedFiles.filter((file) => file.includes('/Dockerfile')),
  );
  const selectedBackend = catalog.deploy.backendImageTargets.filter(
    (service) =>
      backendDockerfileChanged ||
      (service === 'db-migrate' && dbMigrateDockerfileChanged) ||
      affected.has(service) ||
      owners.has(service),
  );
  if (selectedBackend.length > 0 && !selectedBackend.includes('db-migrate')) {
    selectedBackend.unshift('db-migrate');
  }
  const selectedFrontend = catalog.deploy.frontendImageMatrix
    .filter((entry) => affected.has(entry.nx_project) || changedDockerfiles.has(entry.dockerfile))
    .map((entry) => entry.module);
  const infraBuildInputChanged = catalog.deploy.infraImageMatrix.some((entry) =>
    args.changedFiles.some((file) =>
      entry.buildInputGlobs.some((glob) => globToRegExp(glob).test(file)),
    ),
  );
  const selectedInfra = catalog.deploy.infraImageMatrix
    .filter(
      (entry) =>
        affected.has(entry.image) ||
        args.changedFiles.some((file) =>
          entry.buildInputGlobs.some((glob) => globToRegExp(glob).test(file)),
        ),
    )
    .map((entry) => entry.image);
  if (selectedInfra.length > 0 && !selectedBackend.includes('db-migrate')) {
    selectedBackend.unshift('db-migrate');
  }

  let reason = 'nx-affected';
  if (owners.size > 0) reason = 'migration-owner';
  if (backendDockerfileChanged) reason = 'backend-dockerfile-group';
  if (dbMigrateDockerfileChanged && !backendDockerfileChanged) reason = 'db-migrate-dockerfile';
  if (changedDockerfiles.size > 0 && selectedFrontend.length > 0 && selectedBackend.length === 0) {
    reason = 'frontend-dockerfile-group';
  }
  if (infraBuildInputChanged) reason = 'infra-build-input';

  return {
    backendMatrix: backendMatrix(selectedBackend),
    ...checks,
    deployServices: [...selectedBackend, ...selectedFrontend, ...selectedInfra],
    frontendMatrix: catalog.deploy.frontendImageMatrix.filter((entry) =>
      selectedFrontend.includes(entry.module),
    ),
    fullDeploy: false,
    infraMatrix: catalog.deploy.infraImageMatrix.filter((entry) =>
      selectedInfra.includes(entry.image),
    ),
    migrationRequired: selectedBackend.length > 0,
    reason,
  };
}

function writeGithubOutputs(scope: DeploymentScope, args: Arguments): void {
  const outputPath = process.env['GITHUB_OUTPUT'];
  if (!outputPath) return;
  const nxFrontendProjects = new Set(loadCatalog(args.repo).deploy.nxFrontendProjects ?? []);
  appendFileSync(
    outputPath,
    [
      `backend_matrix=${JSON.stringify(scope.backendMatrix)}`,
      `backend_services=${scope.backendMatrix.map((entry) => entry.service).join(' ')}`,
      `frontend_matrix=${JSON.stringify(scope.frontendMatrix)}`,
      `frontend_projects=${scope.frontendMatrix.map((entry) => entry.module).join(' ')}`,
      `nx_frontend_projects=${scope.frontendMatrix
        .map((entry) => entry.nx_project)
        .filter((project) => nxFrontendProjects.has(project))
        .join(' ')}`,
      `infra_matrix=${JSON.stringify(scope.infraMatrix)}`,
      `deploy_services=${scope.deployServices.join(' ')}`,
      `full_deploy=${String(scope.fullDeploy)}`,
      `migration_required=${String(scope.migrationRequired)}`,
      `has_images=${String(scope.deployServices.length > 0)}`,
      `has_backend=${String(scope.backendMatrix.length > 0)}`,
      `has_frontend=${String(scope.frontendMatrix.length > 0)}`,
      `has_infra=${String(scope.infraMatrix.length > 0)}`,
      `dependency_audit_required=${String(scope.dependencyAuditRequired)}`,
      `farm_checks_required=${String(scope.farmChecksRequired)}`,
      `rust_checks_required=${String(scope.rustChecksRequired)}`,
      `sensor_checks_required=${String(scope.sensorChecksRequired)}`,
      `docs_changed=${String(args.changedFiles.some((file) => isDocumentation(file)))}`,
      `full_validation=${String(args.fullValidation)}`,
      `validation_required=${String(validationRequired(scope, args))}`,
      `affected_projects_json=${JSON.stringify(args.affectedProjects)}`,
      `changed_files_json=${JSON.stringify(args.changedFiles)}`,
      `selection_reason=${scope.reason}`,
      '',
    ].join('\n'),
  );
}

function validationRequired(scope: DeploymentScope, args: Arguments): boolean {
  return args.changedFiles.length > 0 && scope.reason !== 'docs-only';
}

function main(argv: readonly string[]): number {
  try {
    const args = parseArguments(argv);
    const scope = selectDeploymentScope(args);
    writeGithubOutputs(scope, args);
    process.stdout.write(
      `${JSON.stringify({
        ...scope,
        affectedProjects: args.affectedProjects,
        changedFiles: args.changedFiles,
        validationRequired: validationRequired(scope, args),
      })}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`select-deployment-scope: ${message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
