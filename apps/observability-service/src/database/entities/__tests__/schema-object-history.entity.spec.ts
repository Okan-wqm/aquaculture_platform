import { getMetadataArgsStorage } from 'typeorm';

import { SchemaObjectHistoryEntity } from '../schema-object-history.entity';

describe('SchemaObjectHistoryEntity', () => {
  it('declares schema=observability and table=schema_object_history', () => {
    const tableArgs = getMetadataArgsStorage().tables.find(
      (t) => t.target === SchemaObjectHistoryEntity,
    );
    expect(tableArgs?.name).toBe('schema_object_history');
    expect(tableArgs?.schema).toBe('observability');
  });

  it('declares the expected 10-column shape', () => {
    const cols = getMetadataArgsStorage().columns.filter(
      (c) => c.target === SchemaObjectHistoryEntity,
    );
    const names = cols.map((c) => c.propertyName).sort();
    expect(names).toEqual([
      'action',
      'actor',
      'detail',
      'environment',
      'id',
      'objectName',
      'objectType',
      'observedAt',
      'schemaName',
      'schemaSnapshotHash',
    ]);
  });

  it('object_type enum matches the 6-variant production union', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === SchemaObjectHistoryEntity &&
        c.propertyName === 'objectType',
    );
    expect(col?.options.enum).toEqual([
      'table',
      'column',
      'index',
      'constraint',
      'enum',
      'policy',
    ]);
  });

  it('action enum has the 4 canonical DDL verbs', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === SchemaObjectHistoryEntity && c.propertyName === 'action',
    );
    expect(col?.options.enum).toEqual([
      'created',
      'altered',
      'dropped',
      'renamed',
    ]);
  });

  it('schema_snapshot_hash is nullable varchar(64) — fits sha256 hex', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === SchemaObjectHistoryEntity &&
        c.propertyName === 'schemaSnapshotHash',
    );
    expect(col?.options.nullable).toBe(true);
    expect(col?.options.length).toBe(64);
  });

  it('actor is NOT NULL varchar(256) — attribution is mandatory', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === SchemaObjectHistoryEntity && c.propertyName === 'actor',
    );
    expect(col?.options.nullable).toBeUndefined();
    expect(col?.options.length).toBe(256);
  });

  it('detail is jsonb + nullable', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) =>
        c.target === SchemaObjectHistoryEntity && c.propertyName === 'detail',
    );
    expect(col?.options.type).toBe('jsonb');
    expect(col?.options.nullable).toBe(true);
  });
});
