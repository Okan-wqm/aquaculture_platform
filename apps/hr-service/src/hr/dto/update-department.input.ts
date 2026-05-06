import { InputType, Field, ID } from '@nestjs/graphql';

@InputType('UpdateHRDepartmentInput')
export class UpdateDepartmentInput {
  @Field(() => ID)
  id!: string;

  @Field({ nullable: true })
  name?: string;

  @Field({ nullable: true })
  code?: string;

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
