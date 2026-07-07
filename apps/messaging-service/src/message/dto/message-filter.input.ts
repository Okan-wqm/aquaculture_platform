import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, IsString, IsInt, Max, Min, IsDate } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Cursor-based pagination filter for message listing.
 * Uses keyset pagination on (createdAt, id) for stable ordering.
 */
@InputType()
export class MessageFilterInput {
  @Field(() => String, {
    nullable: true,
    description: 'Opaque cursor for keyset pagination',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @Field(() => Int, {
    defaultValue: 50,
    description: 'Number of messages to return (max 100)',
  })
  @IsInt()
  @Min(1)
  @Max(100)
  limit!: number;

  @Field(() => Date, {
    nullable: true,
    description: 'Return messages created before this timestamp',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  before?: Date;

  @Field(() => Date, {
    nullable: true,
    description: 'Return messages created after this timestamp',
  })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  after?: Date;
}
