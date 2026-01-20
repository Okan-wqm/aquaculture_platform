/**
 * Import Type from command interface to avoid duplicate exports
 */
import { Type } from '../command/command.interface';

/**
 * Base Query Interface
 * Queries represent read operations that don't modify state
 * Empty interface - queries are identified by their class type
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IQuery {}

/**
 * Tenant-scoped query interface
 */
export interface ITenantQuery extends IQuery {
  /**
   * Tenant context for multi-tenancy
   */
  readonly tenantId: string;
}

/**
 * Paginated query interface
 */
export interface IPaginatedQuery extends IQuery {
  /**
   * Page number (1-based)
   */
  readonly page?: number;

  /**
   * Items per page
   */
  readonly limit?: number;

  /**
   * Sort field
   */
  readonly sortBy?: string;

  /**
   * Sort order
   */
  readonly sortOrder?: 'ASC' | 'DESC';
}

/**
 * Query Handler Interface
 * Implements the logic for processing queries
 */
export interface IQueryHandler<TQuery extends IQuery = IQuery, TResult = unknown> {
  /**
   * Execute the query and return results
   */
  execute(query: TQuery): Promise<TResult>;
}

/**
 * Query Bus Interface
 * Routes queries to their handlers
 */
export interface IQueryBus {
  /**
   * Execute a query through the bus
   */
  execute<TQuery extends IQuery, TResult = unknown>(
    query: TQuery,
  ): Promise<TResult>;

  /**
   * Register a handler for a query type
   */
  register<TQuery extends IQuery, TResult = unknown>(
    queryType: new (...args: any[]) => TQuery,
    handler: Type<IQueryHandler<TQuery, TResult>>,
  ): void;
}

/**
 * Query result with pagination metadata
 */
export interface PaginatedQueryResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}

/**
 * Create a paginated query result
 */
export function createPaginatedQueryResult<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): PaginatedQueryResult<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}
