/**
 * ApplyParameterTemplate Input DTO
 */
import { InputType, Field } from '@nestjs/graphql';
import { IsString, IsBoolean } from 'class-validator';

@InputType()
export class ApplyParameterTemplateInput {
  @Field({ description: 'Template identifier to apply' })
  @IsString()
  templateId!: string;

  @Field({ defaultValue: false, description: 'Overwrite existing parameter configs with same code' })
  @IsBoolean()
  overwrite!: boolean;
}
