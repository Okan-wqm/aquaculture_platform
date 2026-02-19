import { InputType, Field, Int } from '@nestjs/graphql';
import { IsOptional, IsEnum, IsUUID, IsInt, IsBoolean, Min, Max } from 'class-validator';
import { EmployeeStatus, EmploymentType, Department, PersonnelCategory } from '../entities/employee.entity';

@InputType()
export class EmployeeFilterInput {
  @Field(() => EmployeeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @Field(() => EmploymentType, { nullable: true })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @Field(() => Department, { nullable: true })
  @IsOptional()
  @IsEnum(Department)
  department?: Department;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  farmId?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsUUID()
  supervisorId?: string;

  @Field(() => PersonnelCategory, { nullable: true, description: 'Filter by personnel category (OFFSHORE/ONSHORE/HYBRID)' })
  @IsOptional()
  @IsEnum(PersonnelCategory)
  personnelCategory?: PersonnelCategory;

  @Field({ nullable: true, description: 'Filter by sea-worthiness certification status' })
  @IsOptional()
  @IsBoolean()
  seaWorthy?: boolean;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
