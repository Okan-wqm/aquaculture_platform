import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_FORECAST_GENERATION_CATALOG_DIGEST,
} from '../../libs/feeding-contracts/src/feeding-forecast-generation';
import { FEEDING_FORECAST_PROJECTION_V1 } from '../../libs/feeding-contracts/src/feeding-forecast-projection';
import { FEEDING_MIGRATION_AUTHORITY_V1 } from '../../apps/farm-service/src/database/migrations/feeding-migration-authority.v1';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function classProperties(path: string, className: string): string[] {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!declaration) throw new Error(`Missing ${className} in ${path}`);
  return declaration.members
    .filter((member): member is ts.PropertyDeclaration => ts.isPropertyDeclaration(member))
    .map((member) => member.name.getText(source))
    .sort();
}

describe('feeding forecast projection SSOT', () => {
  it('derives persistence and GraphQL field sets from the compiled projection contract', () => {
    expect(
      classProperties(
        'apps/farm-service/src/feeding-protocol/entities/feeding-forecast-snapshot.entity.ts',
        'FeedingForecastSnapshot',
      ),
    ).toEqual(
      [
        'id',
        'tenantId',
        ...FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotMetadataFields,
        ...FEEDING_FORECAST_PROJECTION_V1.persistedFields,
        'createdAt',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(
      classProperties(
        'apps/farm-service/src/feeding-protocol/dto/feed-forecast.results.ts',
        'ProtocolFeedForecastView',
      ),
    ).toEqual([...FEEDING_FORECAST_PROJECTION_V1.graphqlFields].sort());
  });

  it('routes membership, band path, alert cutoff and generation qualification through owner adapters', () => {
    const executor = read(
      'apps/farm-service/src/feeding-protocol/executors/protocol-feed-forecast.executor.ts',
    );
    const writer = read(
      'apps/farm-service/src/feeding-protocol/feeding-aggregate-mutation.writer.ts',
    );
    const resolver = read(
      'apps/farm-service/src/feeding-protocol/resolvers/feed-forecast.resolver.ts',
    );
    expect(executor).toContain('feedingForecastPoolMembershipV1(');
    expect(executor).toContain('compileFeedingForecastBandPathV1(');
    expect(executor).toContain('compileFeedingForecastAlertV1(');
    expect(writer).toContain('compileFeedingForecastGenerationExactSetProofV1(');
    expect(writer).toContain('FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.qualify');
    expect(writer).toContain('FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.activate');
    expect(writer).toContain(
      'FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions.purgeRetired',
    );
    for (const mutationFunction of Object.values(
      FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions,
    )) {
      expect(writer).not.toContain(mutationFunction);
    }
    expect(writer).not.toContain('DELETE FROM "feeding_forecast_snapshots"');
    expect(resolver).toContain('feedingForecastAlertWithinHorizonV1(');
    expect(resolver).toContain('feedingForecastIsStaleV1(');
  });

  it('pins the immutable migration snapshot to the runtime generation catalog', () => {
    const migration = FEEDING_MIGRATION_AUTHORITY_V1.forecastProjection.generation;
    expect(migration.schemaVersion).toBe(FEEDING_FORECAST_GENERATION_AUTHORITY.schemaVersion);
    expect(migration.catalogDigest).toBe(FEEDING_FORECAST_GENERATION_CATALOG_DIGEST);
    expect(migration.states).toEqual(FEEDING_FORECAST_GENERATION_AUTHORITY.states);
    expect(migration.generationRelation).toBe(
      FEEDING_FORECAST_GENERATION_AUTHORITY.generationRelation,
    );
    expect(migration.snapshotRelation).toBe(FEEDING_FORECAST_GENERATION_AUTHORITY.snapshotRelation);
    expect(migration.activePointerRelation).toBe(
      FEEDING_FORECAST_GENERATION_AUTHORITY.activePointer.relation,
    );
    expect(migration.mutationFunctions).toEqual(
      FEEDING_FORECAST_GENERATION_AUTHORITY.mutationFunctions,
    );
  });
});
