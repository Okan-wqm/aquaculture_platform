export interface StockMovementFilter {
  movementType?: string;
  itemType?: string;
  itemId?: string;
  locationId?: string;
  fromDate?: Date;
  toDate?: Date;
}

export interface StockMovementPagination {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export class ListStockMovementsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: StockMovementFilter,
    public readonly pagination?: StockMovementPagination,
  ) {}
}
