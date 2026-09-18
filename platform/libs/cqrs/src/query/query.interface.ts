import {
  derivePaginationMetadataV1,
  type PaginationMetadataV1,
} from '@platform/pagination-contracts';

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
 * Query result with pagination metadata.
 *
 * The coordinates come from `@platform/pagination-contracts` rather than being
 * re-declared here: a query handler's page and the page that reaches the wire
 * must be the same contract, or `totalPages` means one thing inside the service
 * and another outside it.
 */
export interface PaginatedQueryResult<T> {
  data: T[];
  pagination: PaginationMetadataV1;
}

/**
 * Create a paginated query result.
 *
 * Page arithmetic is delegated to the authority, so an empty result is page 1
 * of 1 here exactly as it is at the transport boundary.
 */
export function createPaginatedQueryResult<T>(
  data: T[],
  page: number,
  limit: number,
  total: number,
): PaginatedQueryResult<T> {
  return {
    data,
    pagination: derivePaginationMetadataV1(total, page, limit),
  };
}
