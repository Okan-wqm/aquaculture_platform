import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsEnum,
  IsNumber,
  IsString,
  IsDateString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { MobileCommandEnvelopeInput } from '@aquaculture/backend-common/mobile-command';
import { ClockMethod } from '../entities/attendance-record.entity';

@InputType()
export class GeoLocationInput {
  @Field(() => Float)
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @Field(() => Float)
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;

  @Field({ nullable: true })
  @IsNumber()
  @Min(0)
  @IsOptional()
  accuracy?: number;
}

@InputType()
export class ClockInInput extends MobileCommandEnvelopeInput {
  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @Field(() => ClockMethod, { defaultValue: ClockMethod.WEB })
  @IsEnum(ClockMethod)
  method!: ClockMethod;

  @Field(() => GeoLocationInput, { nullable: true })
  @IsOptional()
  location?: GeoLocationInput;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  remarks?: string;

  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  workAreaId?: string;
}

@InputType()
export class ClockOutInput extends MobileCommandEnvelopeInput {
  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  employeeId?: string;

  @Field(() => ClockMethod, { defaultValue: ClockMethod.WEB })
  @IsEnum(ClockMethod)
  method!: ClockMethod;

  @Field(() => GeoLocationInput, { nullable: true })
  @IsOptional()
  location?: GeoLocationInput;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  remarks?: string;

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  breakStartTime?: Date;

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  breakEndTime?: Date;
}

@InputType()
export class ManualAttendanceInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field()
  @IsDateString()
  date!: string; // YYYY-MM-DD

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  clockIn?: string; // ISO datetime

  @Field({ nullable: true })
  @IsDateString()
  @IsOptional()
  clockOut?: string; // ISO datetime

  @Field()
  @IsString()
  @MaxLength(500)
  reason!: string;

  @Field({ nullable: true })
  @IsUUID()
  @IsOptional()
  shiftId?: string;
}
