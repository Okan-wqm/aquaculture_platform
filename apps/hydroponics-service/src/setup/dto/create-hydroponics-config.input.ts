import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsOptional, MaxLength, IsObject } from 'class-validator';
import { GraphQLJSON } from 'graphql-scalars';

@InputType()
export class CreateHydroponicsConfigInput {
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
