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
} from 'class-validator';
import { Type } from 'class-transformer';
import { PayPeriodType } from '../entities/payroll.entity';

@InputType()
export class WorkHoursInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  regularHours!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  overtimeHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  holidayHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  sickLeaveHours?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  vacationHours?: number;
}

@InputType()
export class EarningsInput {
  @Field(() => Float)
  @IsNumber()
  @Min(0)
  baseSalary!: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  overtime?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  bonus?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  commission?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowances?: number;
}

@InputType()
export class DeductionsInput {
  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  tax?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  socialSecurity?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  healthInsurance?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  retirement?: number;

  @Field(() => Float, { nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
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
  currency?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  notes?: string;
}
