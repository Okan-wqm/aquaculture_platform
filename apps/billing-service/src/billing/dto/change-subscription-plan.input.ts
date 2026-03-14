import { InputType, Field, ID } from '@nestjs/graphql';
import {
  IsString,
  IsUUID,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';

@InputType()
export class ChangeSubscriptionPlanInput {
  @Field(() => ID)
  @IsUUID()
  newPlanId!: string;

  @Field({ nullable: true, defaultValue: false })
  @IsOptional()
  @IsBoolean()
  immediate?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
