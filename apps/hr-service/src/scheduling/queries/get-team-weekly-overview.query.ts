import type { ModuleScope } from '@aquaculture/shared-contracts';

export class GetTeamWeeklyOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly weekStartDate: string,
    public readonly departmentId?: string,
    public readonly siteId?: string,
    /**
     * The workforce scope the caller may see, decided on the server and already narrowed by the
     * client's moduleCode (common/workforce-scope.ts); absent means nothing (fail closed).
     */
    public readonly scope?: ModuleScope,
  ) {}
}
