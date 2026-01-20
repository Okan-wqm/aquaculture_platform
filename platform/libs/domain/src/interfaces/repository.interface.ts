/**
 * Repository Interface - Data access abstraction for aggregates
 * Supports multi-tenant queries and pagination
 */
export interface IRepository<TAggregate, TId = string> {
  /**
   * Find an aggregate by ID
   */
  findById(id: TId): Promise<TAggregate | null>;

  /**
   * Find an aggregate by ID within a tenant context
   */
  findByIdAndTenant(id: TId, tenantId: string): Promise<TAggregate | null>;

  /**
   * Find all aggregates (with pagination)
   */
  findAll(options?: FindAllOptions): Promise<PaginatedResult<TAggregate>>;

  /**
   * Find all aggregates for a specific tenant
   */
  findAllByTenant(
    tenantId: string,
    options?: FindAllOptions,
  ): Promise<PaginatedResult<TAggregate>>;

  /**
   * Save an aggregate (create or update)
   */
  save(aggregate: TAggregate): Promise<TAggregate>;

  /**
   * Delete an aggregate by ID
   */
  delete(id: TId): Promise<void>;

  /**
   * Delete an aggregate by ID within tenant context
   */
  deleteByIdAndTenant(id: TId, tenantId: string): Promise<void>;

  /**
   * Check if an aggregate exists
   */
  exists(id: TId): Promise<boolean>;

  /**
   * Count aggregates matching criteria
   */
  count(criteria?: FilterCriteria): Promise<number>;
}

/**
 * Options for findAll queries
 */
export interface FindAllOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
  filters?: FilterCriteria;
}

/**
 * Filter criteria for queries
 */
export interface FilterCriteria {
  [key: string]: unknown;
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Create a paginated result
 */
export function createPaginatedResult<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/**
 * Unit of Work interface for transaction management
 */
export interface IUnitOfWork {
  /**
   * Start a transaction
   */
  beginTransaction(): Promise<void>;

  /**
   * Commit the transaction
   */
  commit(): Promise<void>;

  /**
   * Rollback the transaction
   */
  rollback(): Promise<void>;

  /**
   * Execute work within a transaction
   */
  executeInTransaction<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Event Store interface for event sourcing
 */
export interface IEventStore {
  /**
   * Append events for an aggregate
   */
  appendEvents(
    aggregateId: string,
    events: unknown[],
    expectedVersion: number,
  ): Promise<void>;

  /**
   * Get events for an aggregate
   */
  getEvents(aggregateId: string, fromVersion?: number): Promise<unknown[]>;

  /**
   * Get events for an aggregate within tenant context
   */
  getEventsByTenant(
    aggregateId: string,
    tenantId: string,
    fromVersion?: number,
  ): Promise<unknown[]>;
}
