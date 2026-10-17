import { MigrationInterface, QueryRunner } from 'typeorm';

import { ExpandContract } from '@aquaculture/backend-common';

// SAFE FORM (unguarded_shared_enum_drop and the expand-contract rules must not
// fire): the reclamation is gated on pg_depend, carries the reviewed
// annotation, and is a contract phase that names its expand phase.
@ExpandContract({ phase: 'contract', dependsOn: 'UnguardedEnumDrop' })
export class ReviewedEnumReclaim1900000000005 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const dependents: Array<{ n: number }> = await queryRunner.query(`
      -- SHARED-ENUM-DROP-REVIEWED: every dependent column is cleared by
      -- 1900000000000; this pg_depend probe fails closed if one remains.
      SELECT count(*)::int AS n
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_type t ON t.oid = d.refobjid
       WHERE t.typname = 'ponds_legacy_grade_enum'
    `);
    if (dependents.length > 0 && dependents[0].n > 0) {
      throw new Error('ponds_legacy_grade_enum still has dependents; refusing DROP TYPE');
    }
    await queryRunner.query(`DROP TYPE IF EXISTS "farm"."ponds_legacy_grade_enum"`);
  }

  public async down(): Promise<void> {
    // The reclaimed type is not recreated: nothing references it.
  }
}
