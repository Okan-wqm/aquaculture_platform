import { SetMetadata } from '@nestjs/common';
import { IQuery } from '../query/query.interface';

/**
 * Metadata key for query handler registration
 */
export const QUERY_HANDLER_METADATA = 'QUERY_HANDLER_METADATA';

/**
 * Constructor type for queries
 */
type QueryConstructor = new (...args: unknown[]) => IQuery;

/**
 * Decorator to mark a class as a query handler
 * @param query The query class this handler processes
 */
export function QueryHandler(query: QueryConstructor): ClassDecorator {
  return (target: object) => {
    SetMetadata(QUERY_HANDLER_METADATA, {
      query,
      queryName: query.name,
    })(target as Function);
  };
}

/**
 * Get query handler metadata from a class
 */
export function getQueryHandlerMetadata(
  target: object,
): { query: QueryConstructor; queryName: string } | undefined {
  return Reflect.getMetadata(QUERY_HANDLER_METADATA, target);
}
