import type { MobileCommandEnvelope } from '@aquaculture/backend-common/mobile-command';

import { ClockMethod, GeoLocation } from '../entities/attendance-record.entity';

export class ClockInCommand {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly employeeId: string,
    public readonly method: ClockMethod,
    public readonly location?: GeoLocation,
    public readonly remarks?: string,
    public readonly workAreaId?: string,
    /**
     * IANA timezone string for the employee's local timezone (e.g., 'Asia/Manila')
     * Used to properly calculate shift times and store timezone context
     */
    public readonly timezone?: string,
    public readonly mobileCommand?: MobileCommandEnvelope,
  ) {}
}
