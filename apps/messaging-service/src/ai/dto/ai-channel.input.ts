/**
 * @module AiChannelInput
 * @description GraphQL input types for AI channel operations including
 * sentiment trend queries and semantic similarity search.
 * @see ADR-012 section 12.2 (Sentiment Analysis)
 * @see ADR-012 section 12.1 (Embedding Pipeline)
 */
import { InputType, Field, ID, Int } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';

/**
 * Input for querying weekly sentiment trends per channel.
 * Accessible only to TENANT_ADMIN role.
 */
@InputType()
export class SentimentTrendsInput {
  @Field(() => ID, {
    nullable: true,
    description: 'Filter by specific channel. Omit for all channels.',
  })
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @Field(() => Int, {
    defaultValue: 4,
    description: 'Number of weeks to look back (1-52)',
  })
  @IsInt()
  @Min(1)
  @Max(52)
  weeks!: number;
}

/**
 * Input for semantic similarity search across messages using vector embeddings.
 * Results are scoped to the requesting user's channels.
 */
@InputType()
export class SimilarMessagesInput {
  @Field(() => String, {
    description: 'Natural language search query (max 1000 chars)',
  })
  @IsString()
  @MaxLength(1000)
  query!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Restrict search to a specific channel',
  })
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @Field(() => Int, {
    defaultValue: 10,
    description: 'Maximum number of results (1-50)',
  })
  @IsInt()
  @Min(1)
  @Max(50)
  limit!: number;
}
