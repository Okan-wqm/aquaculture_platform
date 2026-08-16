import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  FEEDING_MIGRATION_AUTHORITY_V1,
  assertFeedingMigrationAuthorityV1,
} from './feeding-migration-authority.v1';

const MIGRATION_AUTHORITY_DIGEST =
  '0f23c8d97804e652410c049efe33ef8ad8138e00a06aa908256d74ad54a264f8';
const PROTOCOL_RESOLUTION_CONTRACT_V1 = FEEDING_MIGRATION_AUTHORITY_V1.protocolResolution;

const sqlTextArray = (values: readonly string[]): string =>
  `ARRAY[${values.map((value) => `'${value}'`).join(', ')}]::text[]`;

/** Splits immutable calculation provenance from the mutable live decision. */
export class AddDayPlanLiveProtocolResolution1809100000000 implements MigrationInterface {
  name = 'AddDayPlanLiveProtocolResolution1809100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    assertFeedingMigrationAuthorityV1(MIGRATION_AUTHORITY_DIGEST);
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '300s'`);
    const presence: Array<{ plans: string | null }> = await queryRunner.query(
      `SELECT to_regclass('feeding_day_plans')::text AS plans`,
    );
    if (!presence[0]?.plans) return;

    await queryRunner.query(
      `ALTER TABLE "feeding_day_plans"
         ADD COLUMN IF NOT EXISTS resolution jsonb NOT NULL DEFAULT '{}'::jsonb`,
    );
    const invalid: Array<{ count: string }> = await queryRunner.query(`
      SELECT COUNT(*)::text AS count
        FROM "feeding_day_plans"
       WHERE resolution = '{}'::jsonb
         AND (
           jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
           OR jsonb_typeof(snapshot->'feed') IS DISTINCT FROM 'object'
           OR NOT snapshot->'feed' ?& ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.feedExactKeys)}
           OR (snapshot->'feed') - ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.feedExactKeys)} <> '{}'::jsonb
           OR COALESCE(snapshot->>'bandIndex', '') !~ '^[0-9]+$'
           OR jsonb_typeof(snapshot->'baseRatePercent') IS DISTINCT FROM 'number'
           OR jsonb_typeof(snapshot->'tempMultiplier') IS DISTINCT FROM 'number'
           OR jsonb_typeof(snapshot->'effectiveRatePercent') IS DISTINCT FROM 'number'
           OR jsonb_typeof(snapshot->'expectedFcr') IS DISTINCT FROM 'number'
           OR (snapshot->>'expectedFcr')::numeric <= 0
           OR NOT COALESCE(
             snapshot->>'fcrResolvedSource' = ANY(
               ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.fcrResolvedSources)}
             ),
             false
           )
           OR jsonb_typeof(snapshot->'avgWeightG') IS DISTINCT FROM 'number'
           OR (snapshot->>'avgWeightG')::numeric < 0
           OR NOT COALESCE(
             snapshot->>'temperatureSource' = ANY(
               ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.temperatureSources)}
             ),
             false
           )
           OR (
             snapshot->'waterTempC' IS NOT NULL
             AND snapshot->'waterTempC' <> 'null'::jsonb
             AND jsonb_typeof(snapshot->'waterTempC') IS DISTINCT FROM 'number'
           )
         )
    `);
    if (Number(invalid[0]?.count ?? 0) !== 0) {
      throw new Error(
        `Cannot derive ${PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion}: ${invalid[0]?.count ?? 'unknown'} day-plan snapshots lack exact live-resolution provenance`,
      );
    }
    await queryRunner.query(`
      UPDATE "feeding_day_plans"
         SET resolution = jsonb_build_object(
           'schemaVersion', '${PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion}',
           'resolvedAt', to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'bandIndex', (snapshot->>'bandIndex')::integer,
           'feed', snapshot->'feed',
           'baseRatePercent', (snapshot->>'baseRatePercent')::numeric,
           'tempMultiplier', (snapshot->>'tempMultiplier')::numeric,
           'effectiveRatePercent', (snapshot->>'effectiveRatePercent')::numeric,
           'expectedFcr', (snapshot->>'expectedFcr')::numeric,
           'fcrResolvedSource', snapshot->>'fcrResolvedSource',
           'bandBasisWeightG', (snapshot->>'avgWeightG')::numeric,
           'waterTempC', snapshot->'waterTempC',
           'temperatureSource', snapshot->>'temperatureSource'
         )
       WHERE resolution = '{}'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_day_plans"
        DROP CONSTRAINT IF EXISTS "CHK_fdp_resolution_v1"
    `);
    await queryRunner.query(`
      ALTER TABLE "feeding_day_plans"
        ADD CONSTRAINT "CHK_fdp_resolution_v1"
        CHECK (
          jsonb_typeof(resolution) = 'object'
          AND resolution ?& ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.exactKeys)}
          AND resolution - ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.exactKeys)} = '{}'::jsonb
          AND resolution->>'schemaVersion' = '${PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion}'
          AND jsonb_typeof(resolution->'resolvedAt') = 'string'
          AND resolution->>'resolvedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
          AND jsonb_typeof(resolution->'bandIndex') = 'number'
          AND (resolution->>'bandIndex')::numeric = trunc((resolution->>'bandIndex')::numeric)
          AND (resolution->>'bandIndex')::numeric >= 0
          AND jsonb_typeof(resolution->'feed') = 'object'
          AND resolution->'feed' ?& ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.feedExactKeys)}
          AND (resolution->'feed') - ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.feedExactKeys)} = '{}'::jsonb
          AND jsonb_typeof(resolution->'feed'->'id') = 'string'
          AND jsonb_typeof(resolution->'feed'->'code') = 'string'
          AND jsonb_typeof(resolution->'feed'->'name') = 'string'
          AND length(resolution->'feed'->>'id') > 0
          AND length(resolution->'feed'->>'code') > 0
          AND length(resolution->'feed'->>'name') > 0
          AND jsonb_typeof(resolution->'baseRatePercent') = 'number'
          AND jsonb_typeof(resolution->'tempMultiplier') = 'number'
          AND jsonb_typeof(resolution->'effectiveRatePercent') = 'number'
          AND jsonb_typeof(resolution->'expectedFcr') = 'number'
          AND (resolution->>'expectedFcr')::numeric > 0
          AND resolution->>'fcrResolvedSource' = ANY(
            ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.fcrResolvedSources)}
          )
          AND jsonb_typeof(resolution->'bandBasisWeightG') = 'number'
          AND (resolution->>'bandBasisWeightG')::numeric >= 0
          AND (
            resolution->'waterTempC' = 'null'::jsonb
            OR jsonb_typeof(resolution->'waterTempC') = 'number'
          )
          AND resolution->>'temperatureSource' = ANY(
            ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.temperatureSources)}
          )
        )
    `);
    await queryRunner.query(`ALTER TABLE "feeding_day_plans" ALTER COLUMN resolution DROP DEFAULT`);
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows: Array<{ ok: boolean }> = await queryRunner.query(`
      SELECT to_regclass('feeding_day_plans') IS NULL OR NOT EXISTS (
        SELECT 1 FROM "feeding_day_plans"
         WHERE resolution->>'schemaVersion' <> '${PROTOCOL_RESOLUTION_CONTRACT_V1.schemaVersion}'
            OR NOT resolution ?& ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.exactKeys)}
            OR resolution - ${sqlTextArray(PROTOCOL_RESOLUTION_CONTRACT_V1.exactKeys)} <> '{}'::jsonb
            OR (resolution->>'expectedFcr')::numeric <= 0
      ) AS ok
    `);
    return rows[0]?.ok === true;
  }

  public async down(): Promise<void> {
    // Forward-only: removing the live projection makes historical snapshot
    // values look current and can apply biomass with a stale FCR.
  }
}
