/**
 * Shared Pagination DTOs
 *
 * Standard pagination pattern for the platform using offset/limit with hasMore.
 *
 * @module Pagination
 *
 * @example Input Usage:
 * ```typescript
 * @Query(() => PaginatedEmployeeResponse)
 * async employees(
 *   @Args('pagination', { nullable: true }) pagination?: PaginationInput,
 * ): Promise<PaginatedResult<Employee>> { ... }
 * ```
 *
 * @example Response Usage:
 * ```typescript
 * // Create a typed response class for your entity
 * @ObjectType()
 * export class PaginatedEmployeeResponse extends PaginatedResponse(Employee) {}
 * ```
 */
import { InputType, Field, Int, ObjectType } from '@nestjs/graphql';
import { IsOptional, IsInt, Min, Max, IsString, IsEnum, Matches } from 'class-validator';
import { Type } from '@nestjs/common';

/**
 * Sort order for pagination queries
 */
export type SortOrder = 'ASC' | 'DESC';

/**
 * Standard pagination input using offset/limit pattern.
 *
 * This is the preferred pagination pattern for the platform:
 * - offset: Number of items to skip (default: 0)
 * - limit: Maximum number of items to return (default: 20, max: 100)
 * - sortBy: Field to sort by (default: 'createdAt')
 * - sortOrder: Sort direction ASC or DESC (default: 'DESC')
 */
@InputType('PaginationInput')
export class PaginationInput {
  @Field(() => Int, { nullable: true, defaultValue: 0, description: 'Number of items to skip' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20, description: 'Maximum number of items to return (max: 100)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Field to sort by. Must be a valid identifier (alphanumeric + underscore).
   * Consumers MUST validate this against an allowlist of permitted fields
   * before using in query builders to prevent SQL injection via ORDER BY.
   */
  @Field({ nullable: true, defaultValue: 'createdAt', description: 'Field to sort by (must be a valid column name)' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z_][a-zA-Z0-9_]*$/, { message: 'sortBy must be a valid field name (alphanumeric and underscore only)' })
  sortBy?: string;

  @Field({ nullable: true, defaultValue: 'DESC', description: 'Sort direction (ASC or DESC)' })
  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: SortOrder;
}

/**
 * Interface for paginated results
 */
export interface IPaginatedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

/**
 * Creates a typed paginated response class for GraphQL.
 *
 * @param classRef - The entity class to paginate
 * @returns A new ObjectType class with typed items array
 *
 * @example
 * ```typescript
 * import { Employee } from './entities/employee.entity';
 * import { PaginatedResponse } from '@platform/backend-common';
 *
 * @ObjectType()
 * export class PaginatedEmployeeResponse extends PaginatedResponse(Employee) {}
 * ```
 */
export function PaginatedResponse<T>(classRef: Type<T>): Type<IPaginatedResult<T>> {
  @ObjectType({ isAbstract: true })
  abstract class PaginatedResponseClass implements IPaginatedResult<T> {
    @Field(() => [classRef], { description: 'Array of items' })
    items!: T[];

    @Field(() => Int, { description: 'Total count of items matching the query' })
    total!: number;

    @Field(() => Boolean, { description: 'Whether there are more items available' })
    hasMore!: boolean;
  }
  return PaginatedResponseClass as Type<IPaginatedResult<T>>;
}

/**
 * Helper function to calculate hasMore from pagination parameters
 *
 * @param total - Total count of items
 * @param offset - Current offset
 * @param limit - Current limit
 * @returns Whether there are more items available
 */
export function calculateHasMore(total: number, offset: number, limit: number): boolean {
  return offset + limit < total;
}

/**
 * Helper function to create a paginated result
 *
 * @param items - Array of items for current page
 * @param total - Total count of items
 * @param offset - Current offset
 * @param limit - Current limit
 * @returns Paginated result object
 */
export function createPaginatedResult<T>(
  items: T[],
  total: number,
  offset: number,
  limit: number,
): IPaginatedResult<T> {
  return {
    items,
    total,
    hasMore: calculateHasMore(total, offset, limit),
  };
}
