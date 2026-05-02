#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const routerConfigPath = resolve(repoRoot, 'infrastructure/apollo-router/router.yaml');
const registryPath = resolve(repoRoot, 'infrastructure/apollo-router/subgraphs.json');

const failures = [];

if (!existsSync(routerConfigPath)) {
  failures.push('Missing infrastructure/apollo-router/router.yaml');
}

if (!existsSync(registryPath)) {
  failures.push('Missing infrastructure/apollo-router/subgraphs.json');
}

if (existsSync(routerConfigPath)) {
  const routerConfig = readFileSync(routerConfigPath, 'utf8');
  if (/APOLLO_GRAPH_REF|APOLLO_KEY|uplink/i.test(routerConfig)) {
    failures.push('Router PoC must not require GraphOS/Uplink runtime availability');
  }
  if (!/coprocessor:\s*\n/.test(routerConfig)) {
    failures.push('Router config must declare a coprocessor for trusted header normalization');
  }
}

if (existsSync(registryPath)) {
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (registry.runtimeMode !== 'self-hosted-static-supergraph') {
    failures.push('Registry runtimeMode must be self-hosted-static-supergraph');
  }
  if (!Array.isArray(registry.subgraphs) || registry.subgraphs.length === 0) {
    failures.push('Subgraph registry must include at least one active subgraph');
  }
  for (const subgraph of registry.subgraphs ?? []) {
    if (!subgraph.name || !subgraph.routingUrl || !subgraph.schemaUrl) {
      failures.push(`Subgraph entry is incomplete: ${JSON.stringify(subgraph)}`);
    }
  }
}

if (failures.length > 0) {
  console.error('Apollo Router static fallback gate failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log('Apollo Router static fallback gate passed.');
