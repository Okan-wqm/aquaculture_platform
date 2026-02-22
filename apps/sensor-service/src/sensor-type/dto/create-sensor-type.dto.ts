import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  MaxLength,
} from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

/**
 * Create Sensor Type Definition Input DTO
 */
@InputType()
export class CreateSensorTypeInput {
  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  typeKey!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  displayName!: string;

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
