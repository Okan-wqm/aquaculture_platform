import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefreshTokenMfaVerified1800110000000 implements MigrationInterface {
  name = 'RefreshTokenMfaVerified1800110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."refresh_tokens"
        ADD COLUMN IF NOT EXISTS "mfaVerified" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "auth"."refresh_tokens"
        DROP COLUMN IF EXISTS "mfaVerified"
    `);
  }
}
