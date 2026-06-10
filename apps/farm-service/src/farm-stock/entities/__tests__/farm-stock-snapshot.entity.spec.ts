import { LazyMetadataStorage } from '@nestjs/graphql/dist/schema-builder/storages/lazy-metadata.storage';
import { getMetadataArgsStorage, type ColumnOptions } from 'typeorm';

import { FarmStockBatchSnapshot } from '../farm-stock-batch-snapshot.entity';
import { FarmStockContainerSnapshot } from '../farm-stock-container-snapshot.entity';

describe('farm stock snapshot entity metadata', () => {
  const snapshotEntityTypes = [
    FarmStockBatchSnapshot,
    FarmStockContainerSnapshot,
  ] as const;
  const snapshotEntities = new Set<unknown>(snapshotEntityTypes);

  const columns = getMetadataArgsStorage().columns.filter((column) =>
    snapshotEntities.has(column.target),
  );

  function findColumnOptions(
    target: unknown,
    propertyName: string,
  ): ColumnOptions | undefined {
    return columns.find(
      (column) => column.target === target && column.propertyName === propertyName,
    )?.options;
  }

  it('does not register reflected Object column types', () => {
    for (const column of columns) {
      const options: ColumnOptions = column.options;
      expect(options.type).not.toBe(Object);
    }
  });

  it('keeps batchNumber metadata aligned with farm_stock_batch_snapshots DDL', () => {
    const batchNumberOptions = findColumnOptions(
      FarmStockBatchSnapshot,
      'batchNumber',
    );

    expect(batchNumberOptions).toBeDefined();
    expect(batchNumberOptions).toMatchObject({
      type: 'varchar',
      length: 50,
      nullable: true,
    });
  });

  it('registers nullable GraphQL field metadata without reflected Object types', () => {
    expect(() => {
      LazyMetadataStorage.load([...snapshotEntityTypes]);
    }).not.toThrow();
  });
});
