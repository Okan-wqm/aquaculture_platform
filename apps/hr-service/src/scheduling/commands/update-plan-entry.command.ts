import { WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';

export class UpdatePlanEntryCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly entryId: string,
    public readonly shiftId?: string,
    public readonly isOffDay?: boolean,
    public readonly plannedStartTime?: string,
    public readonly plannedEndTime?: string,
    public readonly entryType?: WeeklyPlanEntryType,
    public readonly notes?: string,
  ) {}
}
