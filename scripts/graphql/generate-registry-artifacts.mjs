#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(new URL('../..', import.meta.url).pathname);
const registryPath = resolve(repoRoot, 'infrastructure/apollo-router/subgraphs.json');
const registryText = readFileSync(registryPath, 'utf8');
const registry = JSON.parse(registryText);
const registryHash = createHash('sha256').update(registryText).digest('hex');
const generatorVersion = '1';

function tsString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function write(path, content) {
  const outputPath = resolve(repoRoot, path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${content.trimEnd()}\n`);
  console.log(`Generated ${path}`);
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

write('apps/gateway-api/src/config/federated-subgraphs.generated.ts', gatewayLines.join('\n'));

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

write('infrastructure/apollo-router/supergraph-config.generated.yaml', supergraphLines.join('\n'));

write(
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
        'web/apps/*/src/graphql/**/*.ts',
      ],
    },
    null,
    2,
  ),
);
