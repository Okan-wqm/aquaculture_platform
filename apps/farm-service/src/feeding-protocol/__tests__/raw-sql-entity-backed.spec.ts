import { join } from 'path';

import {
  FEEDING_FORECAST_GENERATION_AUTHORITY,
  FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1,
} from '@aquaculture/feeding-contracts';

import {
  auditQueryBuilderFixtureV1,
  auditRawSqlFixtureV1,
  compileFeedingSqlAuthorityV1,
  FEEDING_SQL_AUTHORITY_SCAN_ROOTS_V1,
  type FeedingSqlAuthorityReportV1,
  type SqlRelationAuthorityV1,
} from '../../__tests__/support/feeding-sql-schema-tenant.compiler';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

type ProjectionKey = keyof typeof FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1.projectionSchemas;

function historicalProvenanceRelations(): readonly SqlRelationAuthorityV1[] {
  const authority = FEEDING_HISTORICAL_PROVENANCE_CATALOG_V1;
  const projections = Object.keys(authority.projectionSchemas).map((candidate) => {
    const key = candidate as ProjectionKey;
    const schema = authority.projectionSchemas[key];
    return {
      relation: authority.projections[key],
      ...('columns' in schema
        ? { columns: schema.columns }
        : { columnSourceRelation: schema.columnSourceRelation }),
      tenantColumn: 'tenantId',
      tenantIsolation: 'FORCED_RLS' as const,
    };
  });
  return [
    {
      relation: authority.journal.relation,
      columns: authority.journal.columns.map((column) => column.name),
      tenantColumn: 'tenantId',
      tenantIsolation: 'FORCED_RLS',
    },
    ...projections,
  ];
}

function forecastGenerationRelations(): readonly SqlRelationAuthorityV1[] {
  const authority = FEEDING_FORECAST_GENERATION_AUTHORITY;
  return [
    {
      relation: authority.generationRelation,
      columns: [
        'id',
        'tenantId',
        'operationId',
        'state',
        'catalogRevision',
        'catalogDigest',
        'sourceWatermark',
        'exactSetDigest',
        'membershipDigest',
        'snapshotCount',
        'previousActiveGenerationId',
        'createdAt',
        'qualifiedAt',
        'activatedAt',
        'retiredAt',
      ],
      tenantColumn: 'tenantId',
    },
    {
      relation: authority.activePointer.relation,
      columns: ['tenantId', 'generationId', 'revision', 'activatedAt'],
      tenantColumn: 'tenantId',
    },
    {
      relation: authority.activeProjection,
      columnSourceRelation: authority.snapshotRelation,
      tenantColumn: 'tenantId',
    },
  ];
}

function violationReport(report: FeedingSqlAuthorityReportV1): string {
  return report.violations
    .map(
      (violation) => `${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`,
    )
    .join('\n');
}

describe('feeding SQL schema + tenant compiler authority v1', () => {
  let report: FeedingSqlAuthorityReportV1;

  beforeAll(() => {
    report = compileFeedingSqlAuthorityV1({
      repoRoot: REPO_ROOT,
      extraRelations: [...historicalProvenanceRelations(), ...forecastGenerationRelations()],
    });
  });

  it('discovers the complete governed source surface and cannot silently scan an empty subset', () => {
    expect(FEEDING_SQL_AUTHORITY_SCAN_ROOTS_V1).toEqual([
      'apps/farm-service/src/feeding-protocol',
      'apps/farm-service/src/feeding',
      'apps/farm-service/src/storage',
    ]);
    expect(report.sourceFiles).toBeGreaterThan(100);
    expect(report.entityRelations).toBeGreaterThan(75);
    expect(report.rawQueryCalls).toBeGreaterThan(40);
    expect(report.rawRelations).toBeGreaterThan(45);
    expect(report.rawColumnReferences).toBeGreaterThan(100);
    expect(report.queryBuilderCalls).toBeGreaterThan(30);
    expect(report.queryBuilderReferences).toBeGreaterThan(100);
    expect(report.tenantBoundRelations).toBeGreaterThan(40);
  });

  it('compiles raw mutation columns and QueryBuilder predicates instead of regex allowlisting', () => {
    const relation: SqlRelationAuthorityV1 = {
      relation: 'storage_inventory',
      columns: ['tenant_id', 'item_id', 'quantity'],
      tenantColumn: 'tenant_id',
    };
    expect(
      auditRawSqlFixtureV1(
        'INSERT INTO storage_inventory (item_id, imaginary_quantity) VALUES ($1, $2)',
        relation,
      ),
    ).toEqual(['UNBOUND_TENANT_RELATION', 'UNKNOWN_RAW_COLUMN']);
    expect(
      auditRawSqlFixtureV1(
        'INSERT INTO storage_inventory (tenant_id, item_id, quantity) VALUES ($1, $2, $3)',
        relation,
      ),
    ).toEqual([]);
    expect(
      auditQueryBuilderFixtureV1({
        alias: 'inventory',
        properties: ['tenantId', 'itemType'],
        physicalColumns: ['tenant_id', 'item_type'],
        expression: 'inventory.item_type = :itemType',
      }),
    ).toEqual(['UNKNOWN_QUERY_BUILDER_COLUMN']);
    expect(
      auditQueryBuilderFixtureV1({
        alias: 'inventory',
        properties: ['tenantId', 'itemType'],
        physicalColumns: ['tenant_id', 'item_type'],
        expression: 'inventory.itemType = :itemType',
      }),
    ).toEqual([]);
  });

  it('binds every discovered relation and column to entity/catalog metadata and tenant authority', () => {
    expect(violationReport(report)).toBe('');
  });
});
