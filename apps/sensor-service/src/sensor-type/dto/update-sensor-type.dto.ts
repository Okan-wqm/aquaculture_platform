import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  MaxLength,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * Update Sensor Type Definition Input DTO
 * typeKey is not updatable — all other fields are optional
 */
@InputType()
export class UpdateSensorTypeInput {
  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  displayName?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  description?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  icon?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  industry?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  defaultChannels?: unknown[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  metadata?: Record<string, unknown>;
}
