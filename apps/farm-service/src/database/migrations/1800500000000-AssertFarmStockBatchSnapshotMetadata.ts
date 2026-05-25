import { MigrationInterface, QueryRunner } from 'typeorm';

import { CreateFarmStockReadModel1800400000000 } from './1800400000000-CreateFarmStockReadModel';

export class AssertFarmStockBatchSnapshotMetadata1800500000000
  implements MigrationInterface
{
  name = 'AssertFarmStockBatchSnapshotMetadata1800500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Tenant-relative contract alignment.
    const readModelRows: Array<{ complete: boolean }> = await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.farm_stock_container_snapshots') IS NOT NULL
        AND to_regclass(current_schema() || '.farm_stock_batch_snapshots') IS NOT NULL
        AS complete
    `);

    if (readModelRows[0]?.complete !== true) {
      await new CreateFarmStockReadModel1800400000000().up(queryRunner);
    }

    await queryRunner.query(`
      DO $$
      DECLARE
        column_type text;
        column_length integer;
        max_batch_number_length integer;
      BEGIN
        ALTER TABLE farm_stock_batch_snapshots
          ADD COLUMN IF NOT EXISTS "batchNumber" VARCHAR(50) NULL;

        SELECT data_type, character_maximum_length
          INTO column_type, column_length
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'farm_stock_batch_snapshots'
           AND column_name = 'batchNumber';

        IF column_type IS DISTINCT FROM 'character varying'
           OR column_length IS DISTINCT FROM 50 THEN
          SELECT MAX(length("batchNumber"::text))
            INTO max_batch_number_length
            FROM farm_stock_batch_snapshots
           WHERE "batchNumber" IS NOT NULL;

          IF COALESCE(max_batch_number_length, 0) > 50 THEN
            RAISE EXCEPTION
              'farm_stock_batch_snapshots.batchNumber has values longer than VARCHAR(50): max length %',
              max_batch_number_length;
          END IF;

          ALTER TABLE farm_stock_batch_snapshots
            ALTER COLUMN "batchNumber" TYPE VARCHAR(50)
            USING "batchNumber"::VARCHAR(50);
        END IF;

        ALTER TABLE farm_stock_batch_snapshots
          ALTER COLUMN "batchNumber" DROP NOT NULL;

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
    // Forward-only contract witness. DDL is owned by CreateFarmStockReadModel1800400000000.
  }
}
