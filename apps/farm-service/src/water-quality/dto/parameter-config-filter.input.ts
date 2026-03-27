/**
 * ParameterConfigFilter Input DTO
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { ParameterGroup } from '../entities/water-quality-parameter-config.entity';

@InputType()
export class ParameterConfigFilterInput {
  @Field(() => ParameterGroup, { nullable: true, description: 'Filter by parameter group' })
  @IsOptional()
  @IsEnum(ParameterGroup)
  group?: ParameterGroup;

  @Field({ nullable: true, description: 'Filter by active status' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Field({ nullable: true, description: 'Filter by visibility' })
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;
}
