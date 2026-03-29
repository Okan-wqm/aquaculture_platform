/**
 * @module ChannelFilterInput
 * @description Pagination and filter input DTO for channel list queries.
 * Enforces limit (1-100) and offset (>=0) constraints.
 * @see ADR-012 section 3.3 (Channel Queries)
 */
import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, IsInt, Min, Max } from 'class-validator';

/**
 * Pagination / filter input for channel list queries.
 */
@InputType()
export class ChannelFilterInput {
  @Field(() => Int, { defaultValue: 50, description: 'Maximum items to return (1-100)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 50;

  @Field(() => Int, { defaultValue: 0, description: 'Offset for pagination' })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset: number = 0;
}
