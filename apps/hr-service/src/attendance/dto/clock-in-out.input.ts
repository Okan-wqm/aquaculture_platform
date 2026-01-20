import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsUUID,
  IsOptional,
  IsEnum,
  IsNumber,
  IsString,
  MaxLength,
} from 'class-validator';
import { ClockMethod } from '../entities/attendance-record.entity';

@InputType()
export class GeoLocationInput {
  @Field(() => Float)
  @IsNumber()
  latitude!: number;

  @Field(() => Float)
  @IsNumber()
  longitude!: number;

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  address?: string;

  @Field({ nullable: true })
  @IsNumber()
  @IsOptional()
  accuracy?: number;
}

@InputType()
export class ClockInInput {
  @Field()
  @IsUUID()
  employeeId!: string;

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
export class ClockOutInput {
  @Field()
  @IsUUID()
  employeeId!: string;

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
}

@InputType()
export class ManualAttendanceInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field()
  @IsString()
  date!: string; // YYYY-MM-DD

  @Field({ nullable: true })
  @IsString()
  @IsOptional()
  clockIn?: string; // ISO datetime

  @Field({ nullable: true })
  @IsString()
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
