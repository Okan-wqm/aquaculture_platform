import { HrModuleCode } from '../../common/enums';

export class GetDepartmentsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly siteId?: string,
    public readonly isDeleted?: boolean,
    public readonly moduleCode?: HrModuleCode,
  ) {}
}

export class GetDepartmentQuery {
  constructor(
    public readonly tenantId: string,
    public readonly id: string,
  ) {}
}
