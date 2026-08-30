import type { QueryRunner } from 'typeorm';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_NULL_PREDICATE =
  /^"[A-Za-z_][A-Za-z0-9_]*"\s+IS\s+(?:NOT\s+)?NULL(?:\s+AND\s+"[A-Za-z_][A-Za-z0-9_]*"\s+IS\s+(?:NOT\s+)?NULL)*$/iu;

export interface ConcurrentBtreeIndexContract {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly predicate?: string;
}

interface IndexCatalogRow {
  readonly columns: Array<string | null>;
  readonly predicate: string | null;
  readonly isUnique: boolean;
  readonly isValid: boolean;
  readonly isReady: boolean;
  readonly hasExpressions: boolean;
  readonly method: string;
}

function quotedIdentifier(value: string, field: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`[concurrent-index] Unsafe ${field}: ${value}`);
  }
  return `"${value}"`;
}

function validateContract(contract: ConcurrentBtreeIndexContract): void {
  quotedIdentifier(contract.schema, 'schema');
  quotedIdentifier(contract.table, 'table');
  quotedIdentifier(contract.name, 'index name');
  if (contract.columns.length === 0) {
    throw new Error(`[concurrent-index] ${contract.name} must declare at least one column`);
  }
  const seen = new Set<string>();
  for (const column of contract.columns) {
    quotedIdentifier(column, 'column');
    if (seen.has(column)) {
      throw new Error(`[concurrent-index] ${contract.name} repeats column ${column}`);
    }
    seen.add(column);
  }
  if (contract.predicate !== undefined && !SAFE_NULL_PREDICATE.test(contract.predicate)) {
    throw new Error(
      `[concurrent-index] ${contract.name} predicate must be a conjunction of quoted NULL checks`,
    );
  }
}

function normalizedPredicate(predicate: string | null | undefined): string | null {
  if (predicate === null || predicate === undefined) {
    return null;
  }
  return predicate.replace(/[\s()"]+/gu, '').toLowerCase();
}

function matchesDefinition(row: IndexCatalogRow, contract: ConcurrentBtreeIndexContract): boolean {
  return (
    row.isUnique === contract.unique &&
    row.method === 'btree' &&
    row.hasExpressions === false &&
    row.columns.length === contract.columns.length &&
    row.columns.every((column, index) => column === contract.columns[index]) &&
    normalizedPredicate(row.predicate) === normalizedPredicate(contract.predicate)
  );
}

async function readIndex(
  queryRunner: QueryRunner,
  contract: ConcurrentBtreeIndexContract,
): Promise<IndexCatalogRow | null> {
  const rows: IndexCatalogRow[] = await queryRunner.query(
    `
      SELECT
        ARRAY(
          SELECT attribute.attname::text
            FROM unnest(index_state.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
            LEFT JOIN pg_attribute attribute
              ON attribute.attrelid = table_class.oid
             AND attribute.attnum = keys.attnum
           WHERE keys.ordinality <= index_state.indnkeyatts
           ORDER BY keys.ordinality
        ) AS "columns",
        pg_get_expr(index_state.indpred, index_state.indrelid) AS "predicate",
        index_state.indisunique AS "isUnique",
        index_state.indisvalid AS "isValid",
        index_state.indisready AS "isReady",
        index_state.indexprs IS NOT NULL AS "hasExpressions",
        access_method.amname AS "method"
      FROM pg_class index_class
      JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
      JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
      JOIN pg_class table_class ON table_class.oid = index_state.indrelid
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_am access_method ON access_method.oid = index_class.relam
      WHERE index_namespace.nspname = $1
        AND index_class.relname = $2
        AND table_namespace.nspname = $1
        AND table_class.relname = $3
    `,
    [contract.schema, contract.name, contract.table],
  );
  if (rows.length > 1) {
    throw new Error(`[concurrent-index] ${contract.schema}.${contract.name} is not unique`);
  }
  return rows[0] ?? null;
}

function assertOutsideTransaction(queryRunner: QueryRunner, indexName: string): void {
  if (queryRunner.isTransactionActive) {
    throw new Error(
      `[concurrent-index] ${indexName} requires transaction=false for PostgreSQL CONCURRENTLY`,
    );
  }
}

export async function ensureConcurrentBtreeIndex(
  queryRunner: QueryRunner,
  contract: ConcurrentBtreeIndexContract,
): Promise<void> {
  validateContract(contract);
  assertOutsideTransaction(queryRunner, contract.name);

  const existing = await readIndex(queryRunner, contract);
  if (existing && !matchesDefinition(existing, contract)) {
    throw new Error(
      `[concurrent-index] ${contract.schema}.${contract.name} schema drift; refusing to replace it`,
    );
  }

  if (existing && (!existing.isValid || !existing.isReady)) {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY IF EXISTS ${quotedIdentifier(contract.schema, 'schema')}.${quotedIdentifier(contract.name, 'index name')}`,
    );
  }

  if (!existing || !existing.isValid || !existing.isReady) {
    const uniqueness = contract.unique ? 'UNIQUE ' : '';
    const columns = contract.columns.map((column) => quotedIdentifier(column, 'column')).join(', ');
    const predicate = contract.predicate ? ` WHERE ${contract.predicate}` : '';
    await queryRunner.query(
      `CREATE ${uniqueness}INDEX CONCURRENTLY IF NOT EXISTS ${quotedIdentifier(contract.name, 'index name')} ON ${quotedIdentifier(contract.schema, 'schema')}.${quotedIdentifier(contract.table, 'table')} USING btree (${columns})${predicate}`,
    );
  }

  const verified = await readIndex(queryRunner, contract);
  if (
    !verified ||
    !matchesDefinition(verified, contract) ||
    !verified.isValid ||
    !verified.isReady
  ) {
    throw new Error(
      `[concurrent-index] ${contract.schema}.${contract.name} did not reach its declared catalog state`,
    );
  }
}

export async function dropConcurrentIndex(
  queryRunner: QueryRunner,
  schema: string,
  indexName: string,
): Promise<void> {
  assertOutsideTransaction(queryRunner, indexName);
  await queryRunner.query(
    `DROP INDEX CONCURRENTLY IF EXISTS ${quotedIdentifier(schema, 'schema')}.${quotedIdentifier(indexName, 'index name')}`,
  );
}
