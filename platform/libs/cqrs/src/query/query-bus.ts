import { Injectable, Type, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IQuery, IQueryBus, IQueryHandler } from './query.interface';
import { QUERY_HANDLER_METADATA } from '../decorators/query-handler.decorator';

/**
 * Query Bus Implementation
 * Routes queries to their respective handlers
 * Supports caching and performance monitoring
 */
/**
 * Mirror of CommandBus's PLAT-HIGH-002 cure for the query side —
 * see command-bus.ts for the full rationale. Class-reference Map
 * is the primary lookup; string-name Map preserved as secondary
 * index for hasHandler(name) + getRegisteredQueries() output.
 */
@Injectable()
export class QueryBus implements IQueryBus {
  private readonly logger = new Logger(QueryBus.name);
  /** Primary: keyed by class reference (minification-proof). */
  private readonly typeHandlers = new Map<
    Type<IQuery>,
    Type<IQueryHandler<IQuery, unknown>>
  >();
  /** Secondary: keyed by string name. */
  private readonly nameHandlers = new Map<
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
    const queryType = query.constructor as Type<IQuery>;
    const queryName = queryType.name; // for logging only
    const startTime = Date.now();

    this.logger.debug(`Executing query: ${queryName}`);

    let handlerType = this.typeHandlers.get(queryType);
    if (!handlerType) {
      handlerType = this.nameHandlers.get(queryName);
    }
    if (!handlerType) {
      const error = `No handler registered for query: ${queryName} (class ref ${queryType.name})`;
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
   * Register a handler for a query type.
   *
   * Stores the binding in BOTH Maps so dispatch via class-reference
   * AND string-name resolves. Class-reference is primary.
   */
  register<TQuery extends IQuery, TResult = unknown>(
    queryType: new (...args: any[]) => TQuery,
    handler: Type<IQueryHandler<TQuery, TResult>>,
  ): void {
    const queryName = queryType.name;
    const typed = queryType as unknown as Type<IQuery>;
    const typedHandler = handler as Type<IQueryHandler<IQuery, unknown>>;
    if (this.typeHandlers.has(typed)) {
      this.logger.warn(`Overwriting handler for query: ${queryName}`);
    }
    this.typeHandlers.set(typed, typedHandler);
    this.nameHandlers.set(queryName, typedHandler);
    this.logger.log(`Registered handler for query: ${queryName}`);
  }

  /**
   * Register a handler by query name (legacy / dynamic registration).
   * Only populates the name-keyed Map.
   */
  registerByName(
    queryName: string,
    handler: Type<IQueryHandler<IQuery, unknown>>,
  ): void {
    if (this.nameHandlers.has(queryName)) {
      this.logger.warn(`Overwriting handler for query: ${queryName}`);
    }
    this.nameHandlers.set(queryName, handler);
    this.logger.log(`Registered handler for query (by name): ${queryName}`);
  }

  /**
   * Check if a handler is registered for a query name.
   */
  hasHandler(queryName: string): boolean {
    return this.nameHandlers.has(queryName);
  }

  /**
   * Get all registered query names.
   */
  getRegisteredQueries(): string[] {
    return Array.from(this.nameHandlers.keys());
  }
}
