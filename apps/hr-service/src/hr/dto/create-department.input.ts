import { InputType, Field } from '@nestjs/graphql';

@InputType('CreateHRDepartmentInput')
export class CreateDepartmentInput {
  @Field()
  name!: string;

  @Field()
  code!: string;

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
