import { MigrationInterface, QueryRunner } from 'typeorm';
import { Logger } from '@nestjs/common';

/**
 * Align tenant AI privacy tables with their TypeORM entities.
 *
 * The original compliance migration created `user_ai_consents` with legacy
 * columns (`consentGiven`, `givenAt`). Runtime code and entity metadata now
 * use the canonical privacy contract (`consented`, `consentedAt`). This
 * migration converges source and tenant schemas without data loss by renaming
 * legacy columns when present, adding canonical columns when absent, and
 * backfilling defaults before enforcing NOT NULL.
 */
export class AlignAiConsentColumns1782700000000 implements MigrationInterface {
  name = 'AlignAiConsentColumns1782700000000';

  private readonly logger = new Logger(this.name);

  async up(queryRunner: QueryRunner): Promise<void> {
    const [{ current_schema }] = await queryRunner.query(`SELECT current_schema()`);
    this.logger.log(`up() running for schema "${current_schema}"`);

    if (!(await this.tableExists(queryRunner, 'user_ai_consents'))) {
      this.logger.warn(`user_ai_consents missing in schema "${current_schema}", skipping`);
      return;
    }

    if (
      (await this.columnExists(queryRunner, 'user_ai_consents', 'consentGiven')) &&
      !(await this.columnExists(queryRunner, 'user_ai_consents', 'consented'))
    ) {
      await queryRunner.query(`
        ALTER TABLE "user_ai_consents"
          RENAME COLUMN "consentGiven" TO "consented"
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "user_ai_consents"
        ADD COLUMN IF NOT EXISTS "consented" boolean
    `);

    await queryRunner.query(`
      UPDATE "user_ai_consents"
         SET "consented" = false
       WHERE "consented" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "user_ai_consents"
        ALTER COLUMN "consented" SET DEFAULT false,
        ALTER COLUMN "consented" SET NOT NULL
    `);

    if (
      (await this.columnExists(queryRunner, 'user_ai_consents', 'givenAt')) &&
      !(await this.columnExists(queryRunner, 'user_ai_consents', 'consentedAt'))
    ) {
      await queryRunner.query(`
        ALTER TABLE "user_ai_consents"
          RENAME COLUMN "givenAt" TO "consentedAt"
      `);
    }

    await queryRunner.query(`
      ALTER TABLE "user_ai_consents"
        ADD COLUMN IF NOT EXISTS "consentedAt" timestamptz
    `);

    await queryRunner.query(`
      UPDATE "user_ai_consents"
         SET "consentedAt" = COALESCE("consentedAt", "createdAt", NOW())
    `);

    await queryRunner.query(`
      ALTER TABLE "user_ai_consents"
        ALTER COLUMN "consentedAt" SET DEFAULT NOW(),
        ALTER COLUMN "consentedAt" SET NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await this.tableExists(queryRunner, 'user_ai_consents'))) {
      return;
    }

    if (
      (await this.columnExists(queryRunner, 'user_ai_consents', 'consented')) &&
      !(await this.columnExists(queryRunner, 'user_ai_consents', 'consentGiven'))
    ) {
      await queryRunner.query(`
        ALTER TABLE "user_ai_consents"
          RENAME COLUMN "consented" TO "consentGiven"
      `);
    }

    if (
      (await this.columnExists(queryRunner, 'user_ai_consents', 'consentedAt')) &&
      !(await this.columnExists(queryRunner, 'user_ai_consents', 'givenAt'))
    ) {
      await queryRunner.query(`
        ALTER TABLE "user_ai_consents"
          RENAME COLUMN "consentedAt" TO "givenAt"
      `);
    }
  }

  private async tableExists(
    queryRunner: QueryRunner,
    table: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema()
            AND table_name = $1
       ) AS exists`,
      [table],
    );
    return rows[0]?.exists === true;
  }

  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows: Array<{ exists: boolean }> = await queryRunner.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1
            AND column_name = $2
       ) AS exists`,
      [table, column],
    );
    return rows[0]?.exists === true;
  }
}
