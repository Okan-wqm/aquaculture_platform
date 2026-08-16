import { Batch } from './batch.entity';
interface DataSource {
  query(sql: string, args: unknown[]): Promise<unknown>;
}
export class RawQueryService {
  constructor(private readonly marker?: Batch) {}
  load(dataSource: DataSource, tenantId: string) {
    return dataSource.query('select * from batches where id = $1', ['1']);
  }
}
