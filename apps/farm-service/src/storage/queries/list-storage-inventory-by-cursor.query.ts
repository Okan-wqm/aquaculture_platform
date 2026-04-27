import type { CursorPaginationInput } from '@aquaculture/backend-common/pagination';

/**
 * Cursor-paginated variant of the storage-inventory list query.
 *
 * Runs alongside `GetStorageInventoryQuery` (offset/limit) during the
 * 6-month deprecation window defined in the phase 5.1 plan. Clients
 * migrate at their own pace; once traffic drains off the offset API
 * the legacy query handler is removed.
 */
export class ListStorageInventoryByCursorQuery {
  constructor(
    public readonly tenantId: string,
    public readonly locationId: string | undefined,
    public readonly itemType: string | undefined,
    public readonly input: CursorPaginationInput | null,
  ) {}
}
