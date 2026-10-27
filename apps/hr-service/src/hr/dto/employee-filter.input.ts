import { InputType, Field } from '@nestjs/graphql';
import { IsOptional, IsEnum, IsUUID, IsBoolean } from 'class-validator';
import { EmployeeStatus, EmploymentType, PersonnelCategory } from '../entities/employee.entity';
import { StandardPaginationInput } from '@aquaculture/backend-common/pagination';
import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';
import { HR_MODULE_CODE_ENUM } from '../../common/enums';

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

  @Field({ nullable: true, description: 'Only employees placed in this department (departments_hr id)' })
  @IsOptional()
  @IsUUID('4')
  departmentHrId?: string;

  @Field(() => HR_MODULE_CODE_ENUM, {
    nullable: true,
    description: 'Only employees whose (live) department belongs to this module',
  })
  @IsOptional()
  @IsEnum(OWNER_MODULE)
  moduleCode?: OwnerModuleCode;

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
}

@InputType('EmployeePaginationInput')
export class EmployeePaginationInput extends StandardPaginationInput {}
