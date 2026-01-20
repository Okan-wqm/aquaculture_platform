import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsDateString,
  IsOptional,
  IsBoolean,
  IsEnum,
  IsString,
  Min,
  MaxLength,
} from 'class-validator';
import { HalfDayPeriod } from '../entities/leave-request.entity';

@InputType()
export class CreateLeaveRequestInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field()
  @IsUUID()
  leaveTypeId!: string;

  @Field()
  @IsDateString()
  startDate!: string;

  @Field()
  @IsDateString()
  endDate!: string;

  @Field(() => Float)
  @Min(0.5)
  totalDays!: number;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isHalfDayStart?: boolean;

  @Field({ defaultValue: false })
  @IsBoolean()
  @IsOptional()
  isHalfDayEnd?: boolean;

  @Field(() => HalfDayPeriod, { nullable: true })
  @IsEnum(HalfDayPeriod)
  @IsOptional()
  halfDayPeriod?: HalfDayPeriod;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  reason?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  contactDuringLeave?: string;
}

@InputType()
export class UpdateLeaveRequestInput {
  @Field()
  @IsUUID()
  id!: string;

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  startDate?: string;

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  endDate?: string;

  @Field(() => Float, { nullable: true })
  @Min(0.5)
  @IsOptional()
  totalDays?: number;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isHalfDayStart?: boolean;

  @Field({ nullable: true })
  @IsBoolean()
  @IsOptional()
  isHalfDayEnd?: boolean;

  @Field(() => HalfDayPeriod, { nullable: true })
  @IsEnum(HalfDayPeriod)
  @IsOptional()
  halfDayPeriod?: HalfDayPeriod;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  reason?: string;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  contactDuringLeave?: string;
}
