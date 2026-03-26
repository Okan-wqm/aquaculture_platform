import { InputType, Field, ID, Float } from '@nestjs/graphql';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsNumber,
  IsArray,
  ValidateNested,
  IsDate,
} from 'class-validator';
import { Type } from 'class-transformer';

@InputType('VfdChangeSetItemInput')
export class ChangeSetItemInput {
  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  parameterName!: string;

  @Field(() => Float)
  @IsNumber()
  requestedValue!: number;
}

@InputType('CreateVfdChangeSetInput')
export class CreateChangeSetInput {
  @Field(() => ID)
  @IsUUID()
  vfdDeviceId!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  description!: string;

  @Field(() => [ChangeSetItemInput], { nullable: true })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChangeSetItemInput)
  items?: ChangeSetItemInput[];

  @Field(() => Date, { nullable: true })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  scheduledAt?: Date;
}

@InputType('RejectVfdChangeSetInput')
export class RejectChangeSetInput {
  @Field(() => ID)
  @IsUUID()
  changeSetId!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  reason!: string;
}

@InputType('RollbackVfdChangeSetInput')
export class RollbackChangeSetInput {
  @Field(() => ID)
  @IsUUID()
  changeSetId!: string;

  @Field(() => String)
  @IsNotEmpty()
  @IsString()
  reason!: string;
}
