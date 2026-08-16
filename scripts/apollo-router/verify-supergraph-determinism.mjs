#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts/apollo-router/build-supergraph.mjs');
const SUBGRAPH_REGISTRY = join(REPO_ROOT, 'infrastructure/apollo-router/subgraphs.json');

function fail(message) {
  process.stderr.write(`verify-supergraph-determinism: ${message}\n`);
  process.exit(1);
}

function governedArtifactPaths() {
  const registry = JSON.parse(readFileSync(SUBGRAPH_REGISTRY, 'utf8'));
  const subgraphs = registry.subgraphs ?? [];
  if (!Array.isArray(subgraphs) || subgraphs.length === 0) {
    fail('subgraph registry has no governed artifact set');
  }
  return [
    ...subgraphs.map((subgraph) => {
      if (typeof subgraph.schemaArtifactPath !== 'string') {
        fail(`subgraph ${String(subgraph.name)} has no schemaArtifactPath`);
      }
      return subgraph.schemaArtifactPath;
    }),
    'dist/graphql/supergraph.graphql',
  ].sort();
}

function emit() {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) fail(`schema emit exited with status ${String(result.status)}`);
}

function artifactManifest(paths) {
  return paths.map((path) => {
    const bytes = readFileSync(join(REPO_ROOT, path));
    return {
      path,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

const artifactPaths = governedArtifactPaths();
emit();
const first = artifactManifest(artifactPaths);
emit();
const second = artifactManifest(artifactPaths);
if (JSON.stringify(first) !== JSON.stringify(second)) {
  for (let index = 0; index < first.length; index += 1) {
    if (JSON.stringify(first[index]) !== JSON.stringify(second[index])) {
      process.stderr.write(
        `non-deterministic artifact: ${first[index]?.path ?? second[index]?.path ?? 'unknown'}\n`,
      );
    }
  }
  fail('two schema emissions did not produce a byte-identical governed artifact set');
}
process.stdout.write(
  `verify-supergraph-determinism: ${artifactPaths.length} artifacts are byte-identical across two emissions\n`,
);
