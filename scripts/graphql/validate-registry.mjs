#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const registryPath = join(repoRoot, 'infrastructure/apollo-router/subgraphs.json');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, files);
    } else {
      files.push(path);
    }
  }
  return files;
}

if (!existsSync(registryPath)) {
  fail('Missing infrastructure/apollo-router/subgraphs.json');
} else {
  const registry = readJson(registryPath);
  const projectFiles = walk(join(repoRoot, 'apps'))
    .concat(walk(join(repoRoot, 'libs')))
    .concat(walk(join(repoRoot, 'platform/libs')))
    .filter((path) => path.endsWith('project.json'));
  const projectNames = new Map();
  for (const projectFile of projectFiles) {
    const project = readJson(projectFile);
    if (project?.name) {
      projectNames.set(project.name, projectFile);
    }
  }

  if (registry.runtimeMode !== 'self-hosted-static-supergraph') {
    fail('runtimeMode must be self-hosted-static-supergraph');
  }
  if (!registry.federationVersion) {
    fail('federationVersion is required');
  }
  if (!Array.isArray(registry.subgraphs) || registry.subgraphs.length === 0) {
    fail('subgraphs must be a non-empty array');
  }

  const names = new Set();
  const envs = new Set();
  for (const [index, subgraph] of (registry.subgraphs ?? []).entries()) {
    const prefix = `subgraphs[${index}] ${subgraph?.name ?? '<unnamed>'}`;
    for (const key of [
      'name',
      'nxProject',
      'urlEnv',
      'localUrl',
      'routingUrl',
      'schemaUrl',
      'schemaArtifactPath',
    ]) {
      if (!subgraph?.[key]) fail(`${prefix} missing ${key}`);
    }
    if (names.has(subgraph.name)) fail(`Duplicate subgraph name: ${subgraph.name}`);
    names.add(subgraph.name);
    if (envs.has(subgraph.urlEnv)) fail(`Duplicate subgraph urlEnv: ${subgraph.urlEnv}`);
    envs.add(subgraph.urlEnv);
    if (subgraph.nxProject && !projectNames.has(subgraph.nxProject)) {
      fail(`${prefix} references missing Nx project ${subgraph.nxProject}`);
    }
    if (subgraph.schemaArtifactPath && !subgraph.schemaArtifactPath.startsWith('dist/graphql/subgraphs/')) {
      fail(`${prefix} schemaArtifactPath must be under dist/graphql/subgraphs/`);
    }
    if (subgraph.name && subgraph.schemaArtifactPath && !subgraph.schemaArtifactPath.endsWith(`/${subgraph.name}.graphql`)) {
      fail(`${prefix} schemaArtifactPath must end with /${subgraph.name}.graphql`);
    }

    const appModule = join(repoRoot, 'apps', subgraph.nxProject ?? '', 'src/app.module.ts');
    if (existsSync(appModule)) {
      const source = readFileSync(appModule, 'utf8');
      if (!source.includes(subgraph.schemaArtifactPath)) {
        fail(`${prefix} schemaArtifactPath is not referenced by ${subgraph.nxProject}/src/app.module.ts`);
      }
    }
  }

  const excludedNames = new Set();
  for (const [index, excluded] of (registry.excludedFederatedServices ?? []).entries()) {
    const prefix = `excludedFederatedServices[${index}] ${excluded?.name ?? '<unnamed>'}`;
    for (const key of ['name', 'owner', 'removeAfterRelease', 'reason']) {
      if (!excluded?.[key]) fail(`${prefix} missing ${key}`);
    }
    excludedNames.add(excluded.name);
  }

  for (const [projectName, projectFile] of projectNames.entries()) {
    if (!projectFile.includes(`${join('apps', '')}`)) continue;
    const appModule = join(repoRoot, 'apps', projectName, 'src/app.module.ts');
    if (!existsSync(appModule)) continue;
    const source = readFileSync(appModule, 'utf8');
    if (source.includes('ApolloFederationDriver')) {
      const isActive = names.has(projectName.replace(/-service$/, '')) ||
        [...names].some((name) => registry.subgraphs.find((s) => s.name === name)?.nxProject === projectName);
      if (!isActive && !excludedNames.has(projectName)) {
        fail(`${projectName} uses ApolloFederationDriver but is neither active nor explicitly excluded`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error('GraphQL subgraph registry validation failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('GraphQL subgraph registry validation passed.');
