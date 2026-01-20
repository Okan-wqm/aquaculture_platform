import { InputType, Field, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { CreateEmployeeInput } from './create-employee.input';
import { EmployeeStatus } from '../entities/employee.entity';

@InputType()
export class UpdateEmployeeInput extends PartialType(CreateEmployeeInput) {
  @Field()
  @IsUUID()
  id!: string;

  @Field(() => EmployeeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  terminationDate?: string;
}
