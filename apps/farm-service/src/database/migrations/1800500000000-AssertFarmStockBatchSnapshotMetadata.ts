import { MigrationInterface, QueryRunner } from 'typeorm';

export class AssertFarmStockBatchSnapshotMetadata1800500000000
  implements MigrationInterface
{
  name = 'AssertFarmStockBatchSnapshotMetadata1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        column_type text;
        column_length integer;
      BEGIN
        SELECT data_type, character_maximum_length
          INTO column_type, column_length
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'farm_stock_batch_snapshots'
           AND column_name = 'batchNumber';

        IF column_type IS DISTINCT FROM 'character varying'
           OR column_length IS DISTINCT FROM 50 THEN
          RAISE EXCEPTION
            'farm_stock_batch_snapshots.batchNumber must be VARCHAR(50), got %(%)',
            column_type,
            column_length;
        END IF;
      END
      $$;
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only metadata witness. DDL is owned by CreateFarmStockReadModel1800400000000.
  }
}
