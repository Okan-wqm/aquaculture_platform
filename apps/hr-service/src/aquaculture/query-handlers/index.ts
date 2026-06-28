export * from './get-work-areas.handler';
export * from './get-work-rotations.handler';
export * from './get-currently-offshore.handler';
export * from './get-crew-assignments.handler';
export * from './get-work-area.handler';
export * from './get-work-rotation.handler';
export * from './get-work-area-occupancy.handler';
export * from './get-all-work-area-occupancies.handler';
export * from './get-current-rotation.handler';
export * from './get-upcoming-rotations.handler';
export * from './get-rotation-calendar.handler';
export * from './get-rotation-changeovers.handler';

import { GetWorkAreasHandler } from './get-work-areas.handler';
import { GetWorkRotationsHandler } from './get-work-rotations.handler';
import { GetCurrentlyOffshoreHandler } from './get-currently-offshore.handler';
import { GetCrewAssignmentsHandler } from './get-crew-assignments.handler';
import { GetWorkAreaHandler } from './get-work-area.handler';
import { GetWorkRotationHandler } from './get-work-rotation.handler';
import { GetWorkAreaOccupancyHandler } from './get-work-area-occupancy.handler';
import { GetAllWorkAreaOccupanciesHandler } from './get-all-work-area-occupancies.handler';
import { GetCurrentRotationHandler } from './get-current-rotation.handler';
import { GetUpcomingRotationsHandler } from './get-upcoming-rotations.handler';
import { GetRotationCalendarHandler } from './get-rotation-calendar.handler';
import { GetRotationChangeoversHandler } from './get-rotation-changeovers.handler';

export const AquacultureQueryHandlers = [
  GetWorkAreasHandler,
  GetWorkRotationsHandler,
  GetCurrentlyOffshoreHandler,
  GetCrewAssignmentsHandler,
  GetWorkAreaHandler,
  GetWorkRotationHandler,
  GetWorkAreaOccupancyHandler,
  GetAllWorkAreaOccupanciesHandler,
  GetCurrentRotationHandler,
  GetUpcomingRotationsHandler,
  GetRotationCalendarHandler,
  GetRotationChangeoversHandler,
];
