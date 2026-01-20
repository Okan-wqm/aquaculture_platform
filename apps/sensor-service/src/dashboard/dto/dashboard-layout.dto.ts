import { InputType, Field, ID } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { IsNotEmpty, IsOptional, IsString, IsBoolean, IsArray } from 'class-validator';

@InputType()
export class SaveDashboardLayoutInput {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  id?: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON)
  @IsArray()
  widgets: any[];

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  processBackground?: {
    processId: string | null;
    position: { x: number; y: number };
    scale: number;
    opacity: number;
  };

  @Field(() => GraphQLJSON, { nullable: true })
  @IsOptional()
  gridConfig?: {
    columns: number;
    cellHeight: number;
    margin: number;
  };

  @Field({ nullable: true })
  @IsOptional()
  gridVersion?: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

@InputType()
export class CreateSystemDefaultLayoutInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string;

  @Field(() => GraphQLJSON)
  @IsArray()
  widgets: any[];
}
