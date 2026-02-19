import { InputType, Field, ID } from '@nestjs/graphql';
import { IsString, IsOptional, MaxLength, IsUUID, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class UpdateHydroponicsConfigInput {
  @Field(() => ID)
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  configName?: string;

  @Field(() => GraphQLJSON, { nullable: true })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
