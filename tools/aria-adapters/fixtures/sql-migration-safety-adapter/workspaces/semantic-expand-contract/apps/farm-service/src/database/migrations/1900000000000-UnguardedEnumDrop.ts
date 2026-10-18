import { MigrationInterface, QueryRunner } from 'typeorm';

// TRUE POSITIVE (unguarded_shared_enum_drop, breaking_ddl_without_expand_contract):
// up() drops the shared source-schema enum with no pg_depend gate and no
// reviewed annotation, and carries no @ExpandContract marker.
export class UnguardedEnumDrop1900000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ponds DROP COLUMN IF EXISTS "legacy_grade"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "farm"."ponds_legacy_grade_enum"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE ponds ADD COLUMN IF NOT EXISTS "legacy_grade" varchar(32)`,
    );
  }
}
