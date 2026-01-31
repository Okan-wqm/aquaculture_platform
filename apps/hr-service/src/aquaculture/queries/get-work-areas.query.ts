import { WorkAreaType } from '../entities/work-area.entity';

export class GetWorkAreasQuery {
  constructor(
    public readonly tenantId: string,
    public readonly workAreaType?: WorkAreaType,
    public readonly isOffshore?: boolean,
    public readonly isActive?: boolean,
    public readonly limit: number = 20,
    public readonly offset: number = 0,
  ) {}
}
