import { InputType, Field } from '@nestjs/graphql';
import {
  IsString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsUUID,
  IsDateString,
  IsNumber,
  ValidateNested,
  IsArray,
  Min,
  Max,
  MaxLength,
  MinLength,
  Matches,
  IsNotEmpty,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { EmploymentType, Department } from '../entities/employee.entity';

@InputType()
export class ContactInfoInput {
  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255, { message: 'Email must be at most 255 characters' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;

  @Field()
  @IsString()
  @Matches(/^[\d\s\-+()]+$/, { message: 'Phone must contain only valid phone characters' })
  @MaxLength(30, { message: 'Phone must be at most 30 characters' })
  @Transform(({ value }) => value?.trim())
  phone!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Emergency contact name must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  emergencyContact?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^[\d\s\-+()]*$/, { message: 'Emergency phone must contain only valid phone characters' })
  @MaxLength(30, { message: 'Emergency phone must be at most 30 characters' })
  @Transform(({ value }) => value?.trim())
  emergencyPhone?: string;
}

@InputType()
export class AddressInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Street address is required' })
  @MaxLength(255, { message: 'Street address must be at most 255 characters' })
  @Transform(({ value }) => value?.trim())
  street!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'City is required' })
  @MaxLength(100, { message: 'City must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  city!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'State is required' })
  @MaxLength(100, { message: 'State must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  state!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Postal code is required' })
  @MaxLength(20, { message: 'Postal code must be at most 20 characters' })
  @Transform(({ value }) => value?.trim())
  postalCode!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Country is required' })
  @MaxLength(100, { message: 'Country must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  country!: string;
}

@InputType()
export class BankDetailsInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Bank name is required' })
  @MaxLength(100, { message: 'Bank name must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  bankName!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Account number is required' })
  @MaxLength(34, { message: 'Account number must be at most 34 characters' })
  @Matches(/^[A-Za-z0-9]+$/, { message: 'Account number must be alphanumeric' })
  accountNumber!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Routing number is required' })
  @MaxLength(20, { message: 'Routing number must be at most 20 characters' })
  @Matches(/^[A-Za-z0-9]+$/, { message: 'Routing number must be alphanumeric' })
  routingNumber!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(34, { message: 'IBAN must be at most 34 characters' })
  @Matches(/^[A-Z]{2}[0-9]{2}[A-Za-z0-9]+$/, { message: 'Invalid IBAN format' })
  iban?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(11, { message: 'SWIFT code must be at most 11 characters' })
  @Matches(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, { message: 'Invalid SWIFT code format' })
  swiftCode?: string;
}

@InputType()
export class CreateEmployeeInput {
  @Field()
  @IsString()
  @IsNotEmpty({ message: 'First name is required' })
  @MinLength(1, { message: 'First name must be at least 1 character' })
  @MaxLength(100, { message: 'First name must be at most 100 characters' })
  @Matches(/^[a-zA-Z\s\-']+$/, { message: 'First name can only contain letters, spaces, hyphens and apostrophes' })
  @Transform(({ value }) => value?.trim())
  firstName!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Last name is required' })
  @MinLength(1, { message: 'Last name must be at least 1 character' })
  @MaxLength(100, { message: 'Last name must be at most 100 characters' })
  @Matches(/^[a-zA-Z\s\-']+$/, { message: 'Last name can only contain letters, spaces, hyphens and apostrophes' })
  @Transform(({ value }) => value?.trim())
  lastName!: string;

  @Field()
  @IsEmail({}, { message: 'Invalid email format' })
  @MaxLength(255, { message: 'Email must be at most 255 characters' })
  @Transform(({ value }) => value?.toLowerCase().trim())
  email!: string;

  @Field(() => ContactInfoInput)
  @ValidateNested()
  @Type(() => ContactInfoInput)
  contactInfo!: ContactInfoInput;

  @Field(() => AddressInput)
  @ValidateNested()
  @Type(() => AddressInput)
  address!: AddressInput;

  @Field()
  @IsDateString({}, { message: 'Date of birth must be a valid ISO date string' })
  dateOfBirth!: string;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'National ID is required' })
  @MaxLength(50, { message: 'National ID must be at most 50 characters' })
  @Transform(({ value }) => value?.trim())
  nationalId!: string;

  @Field(() => EmploymentType)
  @IsEnum(EmploymentType, { message: 'Invalid employment type' })
  employmentType!: EmploymentType;

  @Field(() => Department)
  @IsEnum(Department, { message: 'Invalid department' })
  department!: Department;

  @Field()
  @IsString()
  @IsNotEmpty({ message: 'Position is required' })
  @MaxLength(100, { message: 'Position must be at most 100 characters' })
  @Transform(({ value }) => value?.trim())
  position!: string;

  @Field()
  @IsDateString({}, { message: 'Hire date must be a valid ISO date string' })
  hireDate!: string;

  @Field()
  @IsNumber({}, { message: 'Base salary must be a number' })
  @Min(0, { message: 'Base salary must be non-negative' })
  @Max(100000000, { message: 'Base salary exceeds maximum allowed value' })
  baseSalary!: number;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3, { message: 'Currency code must be at most 3 characters' })
  @Matches(/^[A-Z]{3}$/, { message: 'Currency must be a valid 3-letter ISO currency code' })
  currency?: string;

  @Field(() => BankDetailsInput, { nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => BankDetailsInput)
  bankDetails?: BankDetailsInput;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Farm ID must be a valid UUID' })
  farmId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Supervisor ID must be a valid UUID' })
  supervisorId?: string;

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true, message: 'Each certification must be at most 100 characters' })
  certifications?: string[];

  @Field(() => [String], { nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true, message: 'Each skill must be at most 100 characters' })
  skills?: string[];
}
