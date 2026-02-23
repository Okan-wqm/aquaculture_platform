import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsArray,
  IsObject,
  MaxLength,
  Matches,
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
  @Matches(/^[a-z][a-z0-9_]{1,99}$/, {
    message: 'typeKey must be lowercase alphanumeric with underscores, starting with a letter',
  })
  typeKey!: string;

  @Field()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  displayName!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
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
  @IsArray()
  defaultChannels?: unknown[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
