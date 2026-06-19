export interface NormalizedQueryResult<T extends object> {
  rows: T[];
  rowCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsArrayFromResult(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) {
      return first;
    }
    return result;
  }

  if (isRecord(result) && Array.isArray(result['rows'])) {
    return result['rows'];
  }

  return [];
}

export function queryRowsNormalized<T extends object>(result: unknown): T[] {
  return rowsArrayFromResult(result).filter((row): row is T => isRecord(row));
}

export function queryRowCountNormalized(result: unknown): number {
  if (isRecord(result) && typeof result['rowCount'] === 'number') {
    return result['rowCount'];
  }

  if (!Array.isArray(result)) {
    return 0;
  }

  const first = result[0];
  if (Array.isArray(first)) {
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

export function queryResultNormalized<T extends object>(
  result: unknown,
): NormalizedQueryResult<T> {
  return {
    rows: queryRowsNormalized<T>(result),
    rowCount: queryRowCountNormalized(result),
  };
}
