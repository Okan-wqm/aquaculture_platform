import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';

import { ConfigurationResolver } from '../configuration.resolver';
import { Configuration } from '../entities/configuration.entity';

/**
 * GraphQL schema-build smoke gate (INFRA-HIGH-009).
 *
 * WHY this exists: NestJS GraphQL resolves @Field types via design:type
 * reflection AT RUNTIME — a field typed as a `T | null` union with a bare
 * `@Field({ nullable: true })` compiles, lints, and passes every unit test,
 * then kills the service at bootstrap with "Undefined type error". The
 * 2026-06-11 production boot-loop (Configuration.deletedAt, shipped by the
 * #375 train) was invisible to CI because nothing ever BUILT this
 * subgraph's schema. This spec builds it for real: any
 * reflection-unresolvable field fails the suite instead of production.
 */
describe('config-service GraphQL schema build', () => {
  it('builds the federated schema from the resolvers without reflection errors', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLSchemaBuilderModule],
    }).compile();

    const factory = moduleRef.get(GraphQLSchemaFactory);
    // Configuration rides along as an orphaned type: the resolver's
    // operations return DTOs, so the entity is unreachable from the
    // query graph — but the production app's autoSchemaFile pass still
    // loads every decorated class, which is exactly where the union
    // reflection died. orphanedTypes forces the same full processing
    // here AND pins the entity into the built schema for assertion.
    const schema = await factory.create([ConfigurationResolver], {
      orphanedTypes: [Configuration],
    });

    expect(schema.getType('Configuration')).toBeDefined();
  });
});
