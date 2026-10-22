import { Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';

import { DepartmentHeadCountDataLoader } from './dataloaders/department-head-count.dataloader';
import { DepartmentManagerNameDataLoader } from './dataloaders/department-manager-name.dataloader';
import { DepartmentHR } from './entities/department.entity';

/**
 * Fields of `DepartmentHR` that are derived, not stored. They are resolved from
 * the department's own keys through request-scoped loaders, so a list of N
 * departments costs one query per field.
 *
 * Field resolvers run no guards here (the GraphQL module sets no
 * `fieldResolverEnhancers`): who may read these fields is decided by the
 * operation that returned the department, or the employee it hangs off. The
 * operations without a role gate of their own are tracked as HR-HIGH-056.
 */
@Resolver(() => DepartmentHR)
export class DepartmentFieldsResolver {
  constructor(
    private readonly headCounts: DepartmentHeadCountDataLoader,
    private readonly managerNames: DepartmentManagerNameDataLoader,
  ) {}

  /** People placed directly in this department who have not left. */
  @ResolveField(() => Int)
  headCount(@Parent() department: DepartmentHR): Promise<number> {
    return this.headCounts.load(department.id);
  }

  /** The manager's name; null when the department has no manager or that employee is gone. */
  @ResolveField(() => String, { nullable: true })
  async managerName(@Parent() department: DepartmentHR): Promise<string | null> {
    if (!department.managerId) return null;
    return this.managerNames.load(department.managerId);
  }
}
