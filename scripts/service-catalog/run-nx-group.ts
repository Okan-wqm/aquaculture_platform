#!/usr/bin/env ts-node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type * as ServiceCatalogModule from '../../platform/libs/service-catalog/src/index';

const entrypoint = process.argv[1];
if (!entrypoint) throw new Error('Cannot resolve the service-catalog runner entrypoint');
const REPO_ROOT = resolve(dirname(entrypoint), '..', '..');
const requireFromRepository = createRequire(resolve(REPO_ROOT, 'package.json'));
const { activeDropletServices } = requireFromRepository(
  './platform/libs/service-catalog/src/index.ts',
) as typeof ServiceCatalogModule;

type ProjectGroup = 'backend' | 'frontend' | 'deployable';
type BuildKind = ServiceCatalogModule.BuildKind;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArg(name: string): string {
  const value = argValue(name);
  if (!value) throw new Error(`Missing required argument ${name}`);
  return value;
}

function projectKinds(group: ProjectGroup): readonly BuildKind[] {
  if (group === 'backend') return ['node-service', 'node-worker', 'one-shot', 'rust-sidecar'];
  if (group === 'frontend') return ['frontend'];
  return ['node-service', 'node-worker', 'one-shot', 'rust-sidecar', 'frontend'];
}

function projectsFor(group: ProjectGroup): string[] {
  const kinds = new Set(projectKinds(group));
  return activeDropletServices()
    .filter((entry) => kinds.has(entry.buildKind))
    .map((entry) => entry.nxProject)
    .filter((project): project is string => typeof project === 'string')
    .sort();
}

function trailingArgs(): string[] {
  const marker = process.argv.indexOf('--');
  return marker >= 0 ? process.argv.slice(marker + 1) : [];
}

function main(): void {
  const group = requiredArg('--group') as ProjectGroup;
  const target = requiredArg('--target');
  if (!['backend', 'frontend', 'deployable'].includes(group)) {
    throw new Error(`Unsupported catalog project group: ${group}`);
  }

  const projects = projectsFor(group);
  if (projects.length === 0) {
    throw new Error(`Catalog project group ${group} is empty`);
  }
  if (process.argv.includes('--print')) {
    process.stdout.write(`${projects.join(',')}\n`);
    return;
  }

  const args = [
    'nx',
    'run-many',
    `--target=${target}`,
    `--projects=${projects.join(',')}`,
    ...trailingArgs(),
  ];
  const result = spawnSync('npx', args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
