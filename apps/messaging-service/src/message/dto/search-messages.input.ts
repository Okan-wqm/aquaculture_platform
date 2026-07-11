import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
} from 'class-validator';

/**
 * Input for full-text search across messages.
 */
@InputType()
export class SearchMessagesInput {
  @Field(() => String, {
    description: 'Full-text search query (2-200 chars)',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  query!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Optional channel filter',
  })
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @Field(() => Int, {
    defaultValue: 20,
    description: 'Max results (max 50)',
  })
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;
}
