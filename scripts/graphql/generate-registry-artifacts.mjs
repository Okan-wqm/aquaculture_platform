#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const registryPath = resolve(repoRoot, 'infrastructure/apollo-router/subgraphs.json');
const registryText = readFileSync(registryPath, 'utf8');
const registry = JSON.parse(registryText);
const registryHash = createHash('sha256').update(registryText).digest('hex');
const generatorVersion = '1';
const check = process.argv.includes('--check');
const artifacts = [];

function tsString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function artifact(path, content) {
  artifacts.push({ path, content: `${content.trimEnd()}\n` });
}

const gatewayLines = [
  '/**',
  ' * Generated from infrastructure/apollo-router/subgraphs.json.',
  ` * Registry SHA256: ${registryHash}`,
  ` * Generator version: ${generatorVersion}`,
  ' */',
  'export interface FederatedSubgraphConfig {',
  '  name: string;',
  '  nxProject: string;',
  '  urlEnv: string;',
  '  localUrl: string;',
  '  routingUrl: string;',
  '  schemaArtifactPath: string;',
  '}',
  '',
  'export const FEDERATED_SUBGRAPHS: FederatedSubgraphConfig[] = [',
];

for (const subgraph of registry.subgraphs) {
  gatewayLines.push(
    `  { name: ${tsString(subgraph.name)}, nxProject: ${tsString(subgraph.nxProject)}, urlEnv: ${tsString(subgraph.urlEnv)}, localUrl: ${tsString(subgraph.localUrl)}, routingUrl: ${tsString(subgraph.routingUrl)}, schemaArtifactPath: ${tsString(subgraph.schemaArtifactPath)} },`,
  );
}
gatewayLines.push('];');

artifact('apps/gateway-api/src/config/federated-subgraphs.generated.ts', gatewayLines.join('\n'));

const supergraphLines = [
  '# Generated from infrastructure/apollo-router/subgraphs.json.',
  `# Registry SHA256: ${registryHash}`,
  `# Generator version: ${generatorVersion}`,
  `federation_version: ${registry.federationVersion}`,
  'subgraphs:',
];

for (const subgraph of registry.subgraphs) {
  supergraphLines.push(`  ${subgraph.name}:`);
  supergraphLines.push(`    routing_url: ${JSON.stringify(subgraph.routingUrl)}`);
  supergraphLines.push('    schema:');
  supergraphLines.push(`      file: ${JSON.stringify(subgraph.schemaArtifactPath)}`);
}

artifact(
  'infrastructure/apollo-router/supergraph-config.generated.yaml',
  supergraphLines.join('\n'),
);

artifact(
  'infrastructure/apollo-router/codegen-schema.generated.json',
  JSON.stringify(
    {
      source: 'infrastructure/apollo-router/subgraphs.json',
      registryHash,
      generatorVersion,
      supergraphPath: 'dist/graphql/supergraph.graphql',
      schemaArtifactPaths: registry.subgraphs.map((subgraph) => subgraph.schemaArtifactPath),
      documents: [
        'web/shell/src/graphql/**/*.ts',
        'web/modules/*/src/graphql/**/*.ts',
        'web/apps/*/src/**/*.{ts,tsx}',
      ],
    },
    null,
    2,
  ),
);

const mismatches = [];
for (const { path, content } of artifacts) {
  const outputPath = resolve(repoRoot, path);
  if (check) {
    if (!existsSync(outputPath)) {
      mismatches.push(`${path} is missing`);
      continue;
    }
    const existing = readFileSync(outputPath, 'utf8');
    if (existing !== content) {
      mismatches.push(`${path} is out of date for registry SHA256 ${registryHash}`);
    }
    continue;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(`Generated ${path}`);
}

if (mismatches.length > 0) {
  console.error('GraphQL registry generated artifacts are out of date:');
  for (const mismatch of mismatches) {
    console.error(`  - ${mismatch}`);
  }
  process.exit(1);
}

if (check) {
  console.log(`GraphQL registry artifacts match SHA256 ${registryHash}.`);
}
