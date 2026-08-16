export interface NormalizedQueryResult<T extends object> {
  rows: T[];
  rowCount: number;
}

/**
 * Narrow query authority shared by TypeORM DataSource and QueryRunner.
 * Their public `query()` methods return `any`; this port converts that unsafe
 * driver boundary to `unknown` once so callers must consume a normalized
 * result instead of spreading driver-specific shapes through domain code.
 */
export interface QueryResultExecutor {
  query(query: string, parameters?: unknown[]): Promise<unknown>;
}

export type StringColumnRow<K extends string> = Record<K, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function rowsArrayFromResult(result: unknown): unknown[] {
  if (isUnknownArray(result)) {
    const first = result[0];
    if (isUnknownArray(first)) {
      return first;
    }
    return result;
  }

  if (isRecord(result) && isUnknownArray(result['rows'])) {
    return result['rows'];
  }

  return [];
}

export function queryRowsNormalized<T extends object>(result: unknown): T[] {
  return rowsArrayFromResult(result).map((row, index): T => {
    if (!isRecord(row)) {
      throw new Error(`Database query returned a non-object row at index ${index}.`);
    }
    return row as T;
  });
}

export function queryRowCountNormalized(result: unknown): number {
  if (isRecord(result) && typeof result['rowCount'] === 'number') {
    return result['rowCount'];
  }

  if (!isUnknownArray(result)) {
    return 0;
  }

  const first = result[0];
  if (isUnknownArray(first)) {
    const metadata = result[1];
    if (typeof metadata === 'number') {
      return metadata;
    }
    if (isRecord(metadata) && typeof metadata['rowCount'] === 'number') {
      return metadata['rowCount'];
    }
    return first.length;
  }

  return result.length;
}

export function queryRowsWithStringColumn<K extends string>(
  result: unknown,
  columnName: K,
  context: string,
): Array<StringColumnRow<K>> {
  return queryRowsNormalized<Record<string, unknown>>(result).map((row, index) => {
    const value = row[columnName];
    if (typeof value !== 'string') {
      throw new Error(`${context} returned row ${index} without string column "${columnName}".`);
    }
    return { [columnName]: value } as StringColumnRow<K>;
  });
}

export function querySingleStringColumn<K extends string>(
  result: unknown,
  columnName: K,
  context: string,
): string {
  const rows = queryRowsWithStringColumn(result, columnName, context);
  if (rows.length !== 1) {
    throw new Error(`${context} returned ${rows.length} rows; expected exactly 1.`);
  }
  const row = rows[0];
  if (!row) {
    throw new Error(`${context} returned no row after cardinality validation.`);
  }
  return row[columnName];
}

export function queryResultNormalized<T extends object>(result: unknown): NormalizedQueryResult<T> {
  return {
    rows: queryRowsNormalized<T>(result),
    rowCount: queryRowCountNormalized(result),
  };
}

export async function executeQueryRowsNormalized<T extends object>(
  executor: QueryResultExecutor,
  query: string,
  parameters?: unknown[],
): Promise<T[]> {
  const result = await executor.query(query, parameters);
  return queryRowsNormalized<T>(result);
}

export async function executeQueryResultNormalized<T extends object>(
  executor: QueryResultExecutor,
  query: string,
  parameters?: unknown[],
): Promise<NormalizedQueryResult<T>> {
  const result = await executor.query(query, parameters);
  return queryResultNormalized<T>(result);
}
