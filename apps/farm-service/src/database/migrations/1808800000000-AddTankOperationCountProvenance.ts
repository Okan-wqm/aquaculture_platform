import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Persists whether a removal count was derived from a biomass-only command. */
export class AddTankOperationCountProvenance1808800000000 implements MigrationInterface {
  name = 'AddTankOperationCountProvenance1808800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tank_operations" ADD "countDerived" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "tank_operations" DROP COLUMN "countDerived"`);
  }
}
