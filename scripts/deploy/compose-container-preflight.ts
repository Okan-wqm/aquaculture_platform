#!/usr/bin/env node
/**
 * Compose recreate preflight (INFRA-HIGH-230).
 *
 * `docker compose up --force-recreate <svc>` replaces a service container in
 * three steps: create the new container under a temporary name
 * `<old-id[:12]>_<name>`, stop and remove the old container, rename the new one
 * to `<name>`. Two states on the host break it, and both reached production on
 * 2026-10-17 (CI - Affected run 38990686731, deploy-development/deploy):
 *
 *   1. A container compose does not own holds `<name>`. Compose cannot create
 *      or rename onto it, aborts mid-recreate, and leaves the temp containers
 *      it already created for the other services (attempt 3: `aqua-mobile`
 *      held by 740006e18d09).
 *   2. A temp container left by such an aborted run. On the next `up`, compose
 *      treats the temp container as the one to replace, removes it, and then
 *      cannot rename its new container onto `<name>`, which the original still
 *      holds (attempt 4: `7d7f4e41431e_aqua-dashboard`).
 *
 * For every requested service this preflight decides both cases BEFORE compose
 * stops anything:
 *   - a container named `<name>` whose compose project/service labels are not
 *     this project's service is a conflict: report it by name, id and owner and
 *     exit 1 without changing anything;
 *   - a container named `<12 hex>_<name>` labelled as this project's service is
 *     the residue of an aborted recreate: remove it (it was never started and
 *     holds no name compose needs; anonymous volumes are kept).
 *
 * Usage:   node scripts/deploy/compose-container-preflight.ts <service>...
 * Env:     COMPOSE_FILE (default docker-compose.droplet.yml), plus whatever the
 *          compose file interpolates (TAG, the .env in the working directory).
 * Exit:    0 ready for compose, 1 conflict or Docker failure, 2 usage error.
 *
 * Node 22 strips the types; only node: builtins are imported so the script
 * runs from the SHA-pinned deploy checkout without node_modules.
 */
import { execFileSync } from 'node:child_process';

const COMPOSE_FILE = process.env['COMPOSE_FILE'] ?? 'docker-compose.droplet.yml';
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const PS_FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.State}}',
  `{{.Label "${PROJECT_LABEL}"}}`,
  `{{.Label "${SERVICE_LABEL}"}}`,
].join('\t');

interface ComposeServiceConfig {
  container_name?: string;
}

interface ComposeConfig {
  name?: string;
  services?: Record<string, ComposeServiceConfig>;
}

interface HostContainer {
  id: string;
  names: string[];
  state: string;
  project: string;
  service: string;
}

interface ServiceTarget {
  service: string;
  containerName: string;
}

interface Finding {
  target: ServiceTarget;
  container: HostContainer;
}

function docker(args: readonly string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function isComposeConfig(value: unknown): value is ComposeConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadComposeConfig(): ComposeConfig {
  const parsed: unknown = JSON.parse(
    docker(['compose', '-f', COMPOSE_FILE, 'config', '--format', 'json']),
  );
  if (!isComposeConfig(parsed)) {
    throw new Error(`docker compose config for ${COMPOSE_FILE} is not a JSON object`);
  }
  return parsed;
}

/** Compose's own default when a service sets no container_name. */
function containerNameFor(project: string, service: string, config: ComposeServiceConfig): string {
  return config.container_name ?? `${project}-${service}-1`;
}

function listHostContainers(): HostContainer[] {
  return docker(['ps', '-a', '--no-trunc', '--format', PS_FORMAT])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [id = '', names = '', state = '', project = '', service = ''] = line.split('\t');
      return { id, names: names.split(','), state, project, service };
    });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function describeContainer(container: HostContainer): string {
  const owner =
    container.project === '' && container.service === ''
      ? 'no compose labels'
      : `compose project "${container.project}" service "${container.service}"`;
  return `${container.names.join(',')} (${container.id.slice(0, 12)}, ${container.state}, ${owner})`;
}

function plan(
  project: string,
  targets: readonly ServiceTarget[],
  containers: readonly HostContainer[],
): { conflicts: Finding[]; leftovers: Finding[] } {
  const conflicts: Finding[] = [];
  const leftovers: Finding[] = [];
  for (const target of targets) {
    const tempName = new RegExp(`^[0-9a-f]{12}_${escapeRegExp(target.containerName)}$`);
    for (const container of containers) {
      const owned = container.project === project && container.service === target.service;
      if (container.names.includes(target.containerName)) {
        if (!owned) conflicts.push({ target, container });
      } else if (owned && container.names.some((name) => tempName.test(name))) {
        leftovers.push({ target, container });
      }
    }
  }
  return { conflicts, leftovers };
}

function main(services: readonly string[]): number {
  if (services.length === 0) {
    process.stderr.write('usage: compose-container-preflight.ts <service>...\n');
    return 2;
  }

  const config = loadComposeConfig();
  const project = config.name;
  if (project === undefined || project === '') {
    process.stdout.write(
      `::error::docker compose config for ${COMPOSE_FILE} has no project name.\n`,
    );
    return 1;
  }
  const declared = config.services ?? {};
  const targets: ServiceTarget[] = [];
  for (const service of services) {
    const serviceConfig = declared[service];
    if (serviceConfig === undefined) {
      process.stdout.write(
        `::error::Service ${service} is not in the ${COMPOSE_FILE} configuration for project ${project}.\n`,
      );
      return 1;
    }
    targets.push({ service, containerName: containerNameFor(project, service, serviceConfig) });
  }

  const { conflicts, leftovers } = plan(project, targets, listHostContainers());

  if (conflicts.length > 0) {
    for (const { target, container } of conflicts) {
      process.stdout.write(
        `::error::Container name ${target.containerName} for compose service ${target.service} is held by ${describeContainer(container)}, which project ${project} does not own.\n`,
      );
    }
    process.stdout.write(
      '  Nothing was stopped or removed. Identify the owner of each container above, stop and remove it through that owner, then rerun the deploy.\n',
    );
    return 1;
  }

  for (const { target, container } of leftovers) {
    process.stdout.write(
      `  ${target.service}: removing ${describeContainer(container)}, the temp container of an interrupted compose recreate.\n`,
    );
    docker(['rm', '-f', container.id]);
  }
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error: unknown) {
  // A Docker CLI failure (daemon down, compose interpolation error) leaves the
  // host state unknown: refuse rather than let compose discover it mid-recreate.
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(
    `::error::Compose recreate preflight could not inspect the host: ${message}\n`,
  );
  process.exitCode = 1;
}
