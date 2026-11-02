import type { ModuleScope } from '@aquaculture/shared-contracts';

import { EmployeeFilterInput } from '../dto/employee-filter.input';

export class GetEmployeesQuery {
  constructor(
    public readonly tenantId: string,
    public readonly filter?: EmployeeFilterInput,
    public readonly pagination?: { page?: number; limit?: number; sortBy?: string; sortOrder?: 'ASC' | 'DESC' },
    /**
     * The workforce scope the caller may see, decided on the server and already narrowed by the
     * client's moduleCode (common/workforce-scope.ts); absent means nothing (fail closed).
     */
    public readonly scope?: ModuleScope,
  ) {}
}
