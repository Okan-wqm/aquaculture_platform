import { InputType, Field, Float } from '@nestjs/graphql';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  ValidateNested,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PayPeriodType } from '../entities/payroll.entity';

@InputType()
export class WorkHoursInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(744)
  regularHours!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(744)
  overtimeHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(744)
  holidayHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(744)
  sickLeaveHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(744)
  vacationHours?: number;
}

@InputType()
export class EarningsInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  @Max(10000000)
  baseSalary!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  overtime?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  bonus?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  commission?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  allowances?: number;
}

@InputType()
export class DeductionsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  tax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  socialSecurity?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  healthInsurance?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  retirement?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000000)
  otherDeductions?: number;
}

@InputType()
export class CreatePayrollInput {
  @Field()
  @IsUUID()
  employeeId!: string;

  @Field(() => PayPeriodType)
  @IsEnum(PayPeriodType)
  payPeriodType!: PayPeriodType;

  @Field()
  @IsDateString()
  payPeriodStart!: string;

  @Field()
  @IsDateString()
  payPeriodEnd!: string;

  @Field(() => WorkHoursInput)
  @ValidateNested()
  @Type(() => WorkHoursInput)
  workHours!: WorkHoursInput;

  @Field(() => EarningsInput)
  @ValidateNested()
  @Type(() => EarningsInput)
  earnings!: EarningsInput;

  @Field(() => DeductionsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeductionsInput)
  deductions?: DeductionsInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
