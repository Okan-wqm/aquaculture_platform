export * from './get-work-areas.handler';
export * from './get-work-rotations.handler';
export * from './get-currently-offshore.handler';
export * from './get-crew-assignments.handler';

import { GetWorkAreasHandler } from './get-work-areas.handler';
import { GetWorkRotationsHandler } from './get-work-rotations.handler';
import { GetCurrentlyOffshoreHandler } from './get-currently-offshore.handler';
import { GetCrewAssignmentsHandler } from './get-crew-assignments.handler';

export const AquacultureQueryHandlers = [
  GetWorkAreasHandler,
  GetWorkRotationsHandler,
  GetCurrentlyOffshoreHandler,
  GetCrewAssignmentsHandler,
];
