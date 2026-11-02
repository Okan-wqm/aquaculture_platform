import type { ModuleScope } from '@aquaculture/shared-contracts';

export class GetTeamLeaveCalendarQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId?: string,
    public readonly startDate: string = new Date().toISOString().split('T')[0] ?? '',
    public readonly endDate: string = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] ?? '',
    /**
     * The workforce scope the caller may see, decided on the server and already narrowed by the
     * client's moduleCode (common/workforce-scope.ts); absent means nothing (fail closed).
     */
    public readonly scope?: ModuleScope,
  ) {}
}
