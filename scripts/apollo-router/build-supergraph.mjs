#!/usr/bin/env node
// =============================================================================
// build-supergraph.mjs — R0: build-time static supergraph composition.
// =============================================================================
// Kills the runtime IntrospectAndCompose path (apps/gateway-api boots, fetches
// every subgraph's schema over HTTP, and recomposes the supergraph live — a
// single subgraph being unreachable restart-loops the whole gateway). Instead:
//
//   1. emit each subgraph's Federation v2 SDL from its code-first resolvers,
//      WITHOUT a runtime (no DB/NATS/Redis, no @nestjs/apollo) — one child
//      process per subgraph because NestJS's global TypeMetadataStorage is
//      per-process (two subgraphs in one process would cross-contaminate).
//   2. compose them with @apollo/composition (the same engine `rover supergraph
//      compose` wraps) — pure Node, no rover binary to install.
//   3. write dist/graphql/supergraph.graphql, or FAIL LOUD with the composition
//      errors. A schema break is now a red PR, not a production restart-loop.
//
// SSoT for the subgraph set: infrastructure/apollo-router/subgraphs.json
// (generated from the service catalog). The router boots from the artifact.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeServices } from '@apollo/composition';
import { parse } from 'graphql';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBGRAPHS_JSON = join(REPO_ROOT, 'infrastructure/apollo-router/subgraphs.json');
const SDL_DIR = join(REPO_ROOT, 'dist/graphql/subgraphs');
const SUPERGRAPH_OUT = join(REPO_ROOT, 'dist/graphql/supergraph.graphql');
const EMITTER = join(REPO_ROOT, 'tools/scripts/emit-subgraph-sdl.ts');
const TS_NODE = join(REPO_ROOT, 'node_modules/.bin/ts-node');

function fail(message) {
  process.stderr.write(`build-supergraph: ${message}\n`);
  process.exit(1);
}

function serviceDirFor(subgraph) {
  const project = subgraph.nxProject ?? subgraph.serviceId;
  if (!project) fail(`subgraph ${subgraph.name} has no nxProject/serviceId`);
  return `apps/${project}`;
}

function main() {
  const registry = JSON.parse(readFileSync(SUBGRAPHS_JSON, 'utf8'));
  const subgraphs = registry.subgraphs ?? [];
  if (subgraphs.length === 0) fail('subgraphs.json lists no subgraphs');

  mkdirSync(SDL_DIR, { recursive: true });

  // 1. Emit each subgraph SDL in its own process.
  for (const subgraph of subgraphs) {
    const serviceDir = serviceDirFor(subgraph);
    const result = spawnSync(
      TS_NODE,
      ['--transpile-only', '-r', 'tsconfig-paths/register', EMITTER, subgraph.name, serviceDir],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          TS_NODE_PROJECT: join(REPO_ROOT, serviceDir, 'tsconfig.app.json'),
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=4096',
        },
      },
    );
    if (result.status !== 0) fail(`SDL emit failed for subgraph '${subgraph.name}' (${serviceDir})`);
  }

  // 2. Compose. composeServices is the federation-2 composition engine.
  const services = subgraphs.map((subgraph) => {
    const sdlPath = join(SDL_DIR, `${subgraph.name}.graphql`);
    if (!existsSync(sdlPath)) fail(`emitted SDL missing for '${subgraph.name}': ${sdlPath}`);
    return {
      name: subgraph.name,
      url: subgraph.routingUrl,
      typeDefs: parse(readFileSync(sdlPath, 'utf8')),
    };
  });

  const composition = composeServices(services);
  if (composition.errors && composition.errors.length > 0) {
    process.stderr.write(`build-supergraph: COMPOSITION FAILED (${composition.errors.length} errors)\n`);
    for (const error of composition.errors) {
      process.stderr.write(`  - ${error.message}\n`);
    }
    process.exit(1);
  }

  // 3. Write the composed supergraph the router boots from.
  mkdirSync(dirname(SUPERGRAPH_OUT), { recursive: true });
  writeFileSync(SUPERGRAPH_OUT, composition.supergraphSdl);
  process.stdout.write(
    `build-supergraph: composed ${services.length} subgraphs -> ${SUPERGRAPH_OUT} ` +
      `(${composition.supergraphSdl.length} bytes)\n`,
  );
}

main();
