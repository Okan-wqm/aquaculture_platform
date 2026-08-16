#!/usr/bin/env ts-node
/**
 * emit-subgraph-sdl — R0 (OBS… no: Apollo Router static composition).
 * =============================================================================
 * Emits a subgraph's Federation v2 SDL to dist/graphql/subgraphs/<name>.graphql
 * WITHOUT a runtime: no Postgres / NATS / Redis, and without the @nestjs/apollo
 * ApolloFederationDriver. It works because code-first SDL is pure metadata
 * reflection — importing the resolver files populates the global
 * TypeMetadataStorage (every @ObjectType/@Field/@Resolver registers at import
 * time), and NestJS's own GraphQLSchemaFactory + @apollo/subgraph build the
 * federated schema from that metadata, never instantiating the resolvers or
 * their service/repository dependencies. This is the same pipeline the runtime
 * ApolloFederationDriver runs (GraphQLFederationFactory.generateSchemaFromCodeFirst),
 * reproduced standalone so the supergraph can be composed at BUILD time and a
 * schema break becomes a red PR instead of a production restart-loop.
 *
 * Usage: ts-node ... emit-subgraph-sdl.ts <subgraph-name> <service-dir>
 *   e.g. emit-subgraph-sdl.ts auth apps/auth-service
 */
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { buildSubgraphSchema, printSubgraphSchema } from '@apollo/subgraph';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { assertValidSchema } from 'graphql';
import { gql } from 'graphql-tag';

import {
  canonicalResolverSourcePath,
  compareCanonicalUtf16,
  compileResolverConstructorRegistry,
} from './lib/resolver-metadata-registry';

// Federation v2 link — the directives a NestJS code-first subgraph can emit.
const FEDERATION_V2_LINK =
  'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", ' +
  'import: ["@key", "@shareable", "@external", "@requires", "@provides", ' +
  '"@tag", "@extends", "@override", "@inaccessible", "@composeDirective", ' +
  '"@interfaceObject"])';

function isModuleExports(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function errorDetails(error: unknown): unknown | undefined {
  if (typeof error !== 'object' || error === null || !('details' in error)) return undefined;
  return error.details;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function repoRoot(): string {
  return resolve(__dirname, '..', '..');
}

async function main(): Promise<void> {
  const [, , subgraphName, serviceDir] = process.argv;
  if (!subgraphName || !serviceDir) {
    process.stderr.write('usage: emit-subgraph-sdl.ts <subgraph-name> <service-dir>\n');
    process.exit(2);
  }

  const root = repoRoot();
  // Import every resolver in the service. Each resolver file transitively
  // imports the @ObjectType/@InputType return + argument types it references,
  // so this populates the global TypeMetadataStorage for the whole subgraph.
  // Recursive readdir (typed via @types/node, no glob dependency) — collect
  // every *.resolver.ts under the service's src/.
  const srcDir = join(root, serviceDir, 'src');
  const resolverSourcePaths = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.resolver.ts'))
    .map(canonicalResolverSourcePath)
    .sort(compareCanonicalUtf16);
  if (resolverSourcePaths.length === 0) {
    process.stderr.write(`no *.resolver.ts found under ${serviceDir}/src\n`);
    process.exit(1);
  }

  // createRequire (not the global `require`) so the no-var-requires lint rule
  // is satisfied while ts-node + tsconfig-paths still resolve the @aquaculture/*
  // workspace aliases the resolver files import. Loading a class file never
  // opens a DB/NATS connection (that happens at DI instantiation, which we never
  // do — we only reflect decorator metadata into the global TypeMetadataStorage).
  const requireTs = createRequire(__filename);
  const realSourceRoot = realpathSync.native(srcDir);
  const realSourceOwners = new Map<string, string>();
  const resolverModules = resolverSourcePaths.map((sourcePath) => {
    const file = join(srcDir, sourcePath);
    const realFile = realpathSync.native(file);
    const relativeRealFile = relative(realSourceRoot, realFile);
    if (relativeRealFile.startsWith('..') || isAbsolute(relativeRealFile)) {
      throw new Error(`resolver source escapes service root: ${sourcePath}`);
    }
    const priorOwner = realSourceOwners.get(realFile);
    if (priorOwner) {
      throw new Error(`duplicate resolver source identity: ${priorOwner} and ${sourcePath}`);
    }
    realSourceOwners.set(realFile, sourcePath);
    const moduleExports: unknown = requireTs(realFile);
    if (!isModuleExports(moduleExports)) {
      throw new TypeError(`resolver module does not expose an export record: ${sourcePath}`);
    }
    return { sourcePath, exports: moduleExports };
  });
  const resolverRegistry = compileResolverConstructorRegistry(resolverModules);
  const resolverCtors = resolverRegistry.map((registration) => registration.constructor);

  const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  const schemaFactory = app.get(GraphQLSchemaFactory);

  // Build the base code-first schema (federation v2 needs no extra directives —
  // @key etc. are carried by the @Directive decorators on the entity types).
  const schema = await schemaFactory.create(resolverCtors, [], {
    skipCheck: false,
    orphanedTypes: [],
  });
  assertValidSchema(schema);

  // Reproduce GraphQLFederationFactory.generateSchemaFromCodeFirst:
  // print-with-directives -> prepend the federation @link -> buildSubgraphSchema.
  const printed = printSchemaWithDirectives(schema);
  const typeDefs = `${FEDERATION_V2_LINK}\n\n${printed}`;
  const federated = buildSubgraphSchema(gql(typeDefs));
  assertValidSchema(federated);
  const sdl = printSubgraphSchema(federated);

  const outPath = join(root, 'dist', 'graphql', 'subgraphs', `${subgraphName}.graphql`);
  mkdirSync(dirname(outPath), { recursive: true });
  const artifact = `${sdl}\n`;
  writeFileSync(outPath, artifact);

  await app.close();

  process.stdout.write(
    `emitted ${subgraphName} SDL: ${outPath} (${sdl.length} bytes, ${resolverRegistry.length} resolvers)\n`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  const details = errorDetails(error);
  if (details !== undefined) process.stderr.write(`${JSON.stringify(details)}\n`);
  process.stderr.write(`FATAL emitting subgraph SDL: ${errorMessage(error)}\n`);
  process.exit(1);
});
