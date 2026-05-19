import { MigrationInterface, QueryRunner } from 'typeorm';

export class EnsureSubscriptionActiveIndexPredicate1800200000000
  implements MigrationInterface
{
  name = 'EnsureSubscriptionActiveIndexPredicate1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_subscriptions_tenantId_active"
        ON "billing"."subscriptions" ("tenant_id")
        WHERE "is_deleted" = false
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only repair: preserves the canonical active-subscription index.
  }
}
