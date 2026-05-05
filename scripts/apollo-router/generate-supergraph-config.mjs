#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const registryPath = resolve(repoRoot, 'infrastructure/apollo-router/subgraphs.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

function quote(value) {
  return JSON.stringify(value);
}

const lines = [
  '# Generated from infrastructure/apollo-router/subgraphs.json.',
  '# 2026-04-30: Keep Rover composition and Router rollout on the same registry source.',
  `federation_version: ${registry.federationVersion}`,
  'subgraphs:',
];

for (const subgraph of registry.subgraphs) {
  lines.push(`  ${subgraph.name}:`);
  lines.push(`    routing_url: ${quote(subgraph.routingUrl)}`);
  lines.push('    schema:');
  lines.push(`      subgraph_url: ${quote(subgraph.schemaUrl)}`);
}

process.stdout.write(`${lines.join('\n')}\n`);
