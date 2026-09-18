/**
 * Platform-wide tenant-schema totals (ADMIN-HIGH-121 / CONTRACT-CRITICAL-003).
 *
 * `DatabaseManagementPage` showed four platform totals — schemas, active
 * schemas, total size, total tables — and computed all four in the browser by
 * reducing over `getSchemas({ page: 1, limit: 100 })`. On a platform with more
 * than a hundred tenants that is not a total: it is the first page's subtotal,
 * rendered under the word "Total". The server owns these numbers now, over
 * every row.
 *
 * A class in a `*.dto.ts` file, not an inline return-type annotation, because
 * the `@nestjs/swagger` plugin can only describe classes. The handler's old
 * inline `Promise<{ totalSchemas: number; … }>` produced `"200": {}` in
 * `openapi.json` — a route the contract said nothing about — which is exactly
 * how the admin-panel's hand-written `{ total, active, suspended, deleted }`
 * came to disagree with the server on all four field names without anything
 * failing. That client method had no caller; the first page to adopt it would
 * have read four `undefined`s.
 */
export class SchemaSummaryDto {
  /** Every tracked tenant schema, whatever its status. */
  totalSchemas!: number;
  activeSchemas!: number;
  suspendedSchemas!: number;
  /** Sum of `size_bytes` over every tracked schema. */
  totalSizeBytes!: number;
  /** Sum of `table_count` over every tracked schema. */
  totalTableCount!: number;
  /** `totalSizeBytes / totalSchemas`, rounded; 0 when there are no schemas. */
  avgSizeBytes!: number;
}
