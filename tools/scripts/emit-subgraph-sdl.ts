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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { buildSubgraphSchema, printSubgraphSchema } from '@apollo/subgraph';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { gql } from 'graphql-tag';

import { loadRepositoryApplicationModule } from '../gates/lib/repository-application-module-loader';

// Federation v2 link — the directives a NestJS code-first subgraph can emit.
const FEDERATION_V2_LINK =
  'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", ' +
  'import: ["@key", "@shareable", "@external", "@requires", "@provides", ' +
  '"@tag", "@extends", "@override", "@inaccessible", "@composeDirective", ' +
  '"@interfaceObject"])';

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
  const resolverFiles = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .filter((entry): entry is string => typeof entry === 'string' && entry.endsWith('.resolver.ts'))
    .map((entry) => join(srcDir, entry));
  if (resolverFiles.length === 0) {
    process.stderr.write(`no *.resolver.ts found under ${serviceDir}/src\n`);
    process.exit(1);
  }

  // The descriptor-bound loader constrains targets to canonical application
  // source while ts-node + tsconfig-paths resolve workspace aliases. Loading a
  // class file never opens DB/NATS connections (that happens at DI instantiation).
  const resolverCtors: unknown[] = [];
  for (const file of resolverFiles) {
    const mod = loadRepositoryApplicationModule(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported === 'function' && /Resolver$/.test((exported as { name: string }).name)) {
        resolverCtors.push(exported);
      }
    }
  }

  const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  const schemaFactory = app.get(GraphQLSchemaFactory);

  // Build the base code-first schema (federation v2 needs no extra directives —
  // @key etc. are carried by the @Directive decorators on the entity types).
  const schema = await schemaFactory.create(resolverCtors as never[], [], {
    skipCheck: true,
    orphanedTypes: [],
  });

  // Reproduce GraphQLFederationFactory.generateSchemaFromCodeFirst:
  // print-with-directives -> prepend the federation @link -> buildSubgraphSchema.
  const printed = printSchemaWithDirectives(schema);
  const typeDefs = `${FEDERATION_V2_LINK}\n\n${printed}`;
  const federated = buildSubgraphSchema(gql(typeDefs));
  const sdl = printSubgraphSchema(federated);

  const outPath = join(root, 'dist', 'graphql', 'subgraphs', `${subgraphName}.graphql`);
  mkdirSync(dirname(outPath), { recursive: true });
  const artifact = `${sdl}\n`;
  writeFileSync(outPath, artifact);

  // Some services retain a committed schema.graphql snapshot for tooling that
  // cannot consume the composed supergraph. Keep that snapshot derived from
  // the exact same code-first metadata as the runtime subgraph artifact.
  // Services without a committed snapshot do not gain a second schema copy.
  const committedSnapshotPath = join(root, serviceDir, 'schema.graphql');
  if (existsSync(committedSnapshotPath)) {
    writeFileSync(committedSnapshotPath, artifact);
  }
  await app.close();

  process.stdout.write(
    `emitted ${subgraphName} SDL: ${outPath} (${sdl.length} bytes, ${resolverCtors.length} resolvers)\n`,
  );
  process.exit(0);
}

main().catch((error: unknown) => {
  const err = error as { message?: string; details?: unknown };
  if (err?.details) process.stderr.write(`${JSON.stringify(err.details)}\n`);
  process.stderr.write(`FATAL emitting subgraph SDL: ${err?.message ?? String(error)}\n`);
  process.exit(1);
});
