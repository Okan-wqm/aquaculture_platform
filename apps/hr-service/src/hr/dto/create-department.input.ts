import { InputType, Field } from '@nestjs/graphql';
import { DepartmentType } from '../entities/department.entity';

@InputType()
export class CreateDepartmentInput {
  @Field()
  name!: string;

  @Field()
  code!: string;

  @Field(() => DepartmentType, { nullable: true, defaultValue: DepartmentType.GENERAL })
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
}
