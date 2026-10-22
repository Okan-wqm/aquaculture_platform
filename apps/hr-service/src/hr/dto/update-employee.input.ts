import { InputType, Field, OmitType, PartialType } from '@nestjs/graphql';
import { IsUUID, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { CreateEmployeeInput } from './create-employee.input';
import { EmployeeStatus } from '../entities/employee.entity';

// `departmentHrId` is redeclared below: on update, null is a meaningful value
// (take the employee out of any department), which the create input never needs.
@InputType()
export class UpdateEmployeeInput extends PartialType(
  OmitType(CreateEmployeeInput, ['departmentHrId'] as const),
) {
  @Field()
  @IsUUID()
  id!: string;

  /**
   * The department to move the employee into. Omitted = unchanged; an explicit
   * null = no department. A department is only accepted if it is live in the
   * tenant (`assertAssignableDepartment`).
   */
  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsUUID('4', { message: 'Department ID must be a valid UUID' })
  departmentHrId?: string | null;

  @Field(() => EmployeeStatus, { nullable: true })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @Field({ nullable: true })
  @IsOptional()
  @IsDateString()
  terminationDate?: string;
}
