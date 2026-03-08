import { InputType, Field, ID } from '@nestjs/graphql';
import { DepartmentType } from '../entities/department.entity';

@InputType()
export class UpdateDepartmentInput {
  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  code?: string;

  @Field(() => DepartmentType, { nullable: true })
  type?: DepartmentType;

  @Field({ nullable: true })
  description?: string;

  @Field({ nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  parentDepartmentId?: string;

  @Field({ nullable: true })
  managerId?: string;

  @Field({ nullable: true })
  budgetCode?: string;

  @Field({ nullable: true })
  costCenter?: string;

  @Field({ nullable: true })
  isActive?: boolean;

  @Field({ nullable: true })
  isDeleted?: boolean;
}
