/**
 * ReorderParameterConfigs Input DTO
 */
import { InputType, Field, ID } from '@nestjs/graphql';
import { IsArray, IsUUID } from 'class-validator';

@InputType()
export class ReorderParameterConfigsInput {
  @Field(() => [ID], { description: 'Parameter config IDs in desired display order' })
  @IsArray()
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}
