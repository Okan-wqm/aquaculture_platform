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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { buildSubgraphSchema, printSubgraphSchema } from '@apollo/subgraph';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  TypeMetadataStorage,
} from '@nestjs/graphql';
import { gql } from 'graphql-tag';

// Federation v2 link — the directives a NestJS code-first subgraph can emit.
const FEDERATION_V2_LINK =
  'extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", ' +
  'import: ["@key", "@shareable", "@external", "@requires", "@provides", ' +
  '"@tag", "@extends", "@override", "@inaccessible", "@composeDirective", ' +
  '"@interfaceObject"])';

function repoRoot(): string {
  return resolve(__dirname, '..', '..');
}

type ResolverClass = (new (...args: never[]) => object) & { readonly name: string };

/**
 * Root fields (Query / Mutation / Subscription) that more than one resolver
 * method declares in this subgraph, as `Query.sensor: A.m, B.m` lines.
 *
 * A root field name has one definition in the schema, but code-first lets two
 * methods claim it: the schema factory keeps one declaration's type and
 * arguments while the runtime resolver map can call the other, so one name
 * answers with two shapes and which one depends on load order (sensor
 * `sensor(id)`, 2026-10-31; farm `availableTanks`, 2026-06-24). Read from
 * the metadata the schema was just built from, after create() has loaded it
 * (the getters are empty before), so the check sees exactly what is served.
 */
function rootFieldsWithTwoOwners(resolvers: readonly ResolverClass[]): string[] {
  // An operation declared on a resolver's base class belongs to it too.
  const served = new Set<object>();
  for (const resolver of resolvers) {
    for (
      let target: object | null = resolver;
      target !== null && target !== Function.prototype;
      target = Object.getPrototypeOf(target) as object | null
    ) {
      served.add(target);
    }
  }

  const roots = [
    ['Query', TypeMetadataStorage.getQueriesMetadata()],
    ['Mutation', TypeMetadataStorage.getMutationsMetadata()],
    ['Subscription', TypeMetadataStorage.getSubscriptionsMetadata()],
  ] as const;
  const report: string[] = [];
  for (const [root, operations] of roots) {
    const owners = new Map<string, Set<string>>();
    for (const operation of operations) {
      if (!served.has(operation.target)) continue;
      const declared = owners.get(operation.schemaName) ?? new Set<string>();
      declared.add(`${operation.target.name}.${operation.methodName}`);
      owners.set(operation.schemaName, declared);
    }
    for (const [field, declared] of owners) {
      if (declared.size > 1) report.push(`${root}.${field}: ${[...declared].join(', ')}`);
    }
  }
  return report;
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

  // createRequire (not the global `require`) so the no-var-requires lint rule
  // is satisfied while ts-node + tsconfig-paths still resolve the @aquaculture/*
  // workspace aliases the resolver files import. Loading a class file never
  // opens a DB/NATS connection (that happens at DI instantiation, which we never
  // do — we only reflect decorator metadata into the global TypeMetadataStorage).
  const requireTs = createRequire(__filename);
  // A resolver export is a CLASS, and that is assignable to the `Function[]`
  // GraphQLSchemaFactory.create() declares — so the list can be typed at what it
  // actually holds instead of collected as `unknown[]` and cast at the call site.
  // The bare `Function` type is not used here: eslint's no-unsafe-function-type
  // bans it, and it would accept any callable, including the plain functions this
  // loop is filtering out.
  const resolverCtors: ResolverClass[] = [];
  for (const file of resolverFiles) {
    const mod = requireTs(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const candidate = exported as ResolverClass;
      if (!/Resolver$/.test(candidate.name)) continue;
      resolverCtors.push(candidate);
    }
  }

  const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  const schemaFactory = app.get(GraphQLSchemaFactory);

  // Build the base code-first schema (federation v2 needs no extra directives —
  // @key etc. are carried by the @Directive decorators on the entity types).
  const schema = await schemaFactory.create(resolverCtors, [], {
    skipCheck: true,
    orphanedTypes: [],
  });

  const twoOwners = rootFieldsWithTwoOwners(resolverCtors);
  if (twoOwners.length > 0) {
    process.stderr.write(
      `${subgraphName}: each root field must have one resolver method; these have more:\n` +
        twoOwners.map((line) => `  ${line}\n`).join(''),
    );
    process.exit(1);
  }

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
