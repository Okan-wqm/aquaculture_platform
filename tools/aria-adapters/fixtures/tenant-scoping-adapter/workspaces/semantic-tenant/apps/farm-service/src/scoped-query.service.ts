import { Batch } from './batch.entity';
interface DataSource {
  query(sql: string, args: unknown[]): Promise<unknown>;
}
// FP-trap: the predicate IS present — a scanner keying only on query()
// inside a tenant-aware scope fires here wrongly.
export class ScopedQueryService {
  constructor(private readonly marker?: Batch) {}
  load(dataSource: DataSource, tenantId: string) {
    return dataSource.query('select * from batches where tenant_id = $1', [tenantId]);
  }
}
