import type { OwnerModuleCode } from '@aquaculture/shared-contracts';

export class GetDepartmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly isDeleted?: boolean,
    public readonly moduleCode?: OwnerModuleCode,
  ) {}
}

export class GetDepartmentQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
