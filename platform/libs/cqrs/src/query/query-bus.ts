import { Injectable, Type, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IQuery, IQueryBus, IQueryHandler } from './query.interface';
import { QUERY_HANDLER_METADATA } from '../decorators/query-handler.decorator';

/**
 * Query Bus Implementation
 * Routes queries to their respective handlers
 * Supports caching and performance monitoring
 */
@Injectable()
export class QueryBus implements IQueryBus {
  private readonly logger = new Logger(QueryBus.name);
  private readonly handlers = new Map<
    string,
    Type<IQueryHandler<IQuery, unknown>>
  >();

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Execute a query through the bus
   * @param query The query to execute
   * @returns The result from the handler
   */
  async execute<TQuery extends IQuery, TResult = unknown>(
    query: TQuery,
  ): Promise<TResult> {
    const queryName = query.constructor.name;
    const startTime = Date.now();

    this.logger.debug(`Executing query: ${queryName}`);

    const handlerType = this.handlers.get(queryName);
    if (!handlerType) {
      const error = `No handler registered for query: ${queryName}`;
      this.logger.error(error);
      throw new Error(error);
    }

    try {
      const handler = this.moduleRef.get(handlerType, { strict: false });
      if (!handler) {
        throw new Error(`Handler instance not found for: ${queryName}`);
      }

      const result = await handler.execute(query);

      const duration = Date.now() - startTime;
      this.logger.debug(
        `Query ${queryName} executed successfully in ${duration}ms`,
      );

      return result as TResult;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.logger.error(
        `Query ${queryName} failed after ${duration}ms`,
        error instanceof Error ? error.stack : error,
      );
      throw error;
    }
  }

  /**
   * Register a handler for a query type
   */
  register<TQuery extends IQuery, TResult = unknown>(
    queryType: new (...args: any[]) => TQuery,
    handler: Type<IQueryHandler<TQuery, TResult>>,
  ): void {
    const queryName = queryType.name;
    if (this.handlers.has(queryName)) {
      this.logger.warn(`Overwriting handler for query: ${queryName}`);
    }
    this.handlers.set(queryName, handler as Type<IQueryHandler<IQuery, unknown>>);
    this.logger.log(`Registered handler for query: ${queryName}`);
  }

  /**
   * Register a handler by query name
   */
  registerByName(
    queryName: string,
    handler: Type<IQueryHandler<IQuery, unknown>>,
  ): void {
    if (this.handlers.has(queryName)) {
      this.logger.warn(`Overwriting handler for query: ${queryName}`);
    }
    this.handlers.set(queryName, handler);
    this.logger.log(`Registered handler for query: ${queryName}`);
  }

  /**
   * Check if a handler is registered for a query
   */
  hasHandler(queryName: string): boolean {
    return this.handlers.has(queryName);
  }

  /**
   * Get all registered query types
   */
  getRegisteredQueries(): string[] {
    return Array.from(this.handlers.keys());
  }
}
