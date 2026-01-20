export * from './get-work-areas.handler';
export * from './get-work-rotations.handler';
export * from './get-currently-offshore.handler';

import { GetWorkAreasHandler } from './get-work-areas.handler';
import { GetWorkRotationsHandler } from './get-work-rotations.handler';
import { GetCurrentlyOffshoreHandler } from './get-currently-offshore.handler';

export const AquacultureQueryHandlers = [
  GetWorkAreasHandler,
  GetWorkRotationsHandler,
  GetCurrentlyOffshoreHandler,
];
