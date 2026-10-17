/**
 * The fourteen sections of Platform architecture v4, in document order.
 */
import type { ArchitectureSection } from '../../types';

import { section01 } from './s01-facility';
import { section02 } from './s02-data-acquisition';
import { section03 } from './s03-people-access';
import { section04 } from './s04-production';
import { section05 } from './s05-maintenance';
import { section06 } from './s06-energy-finance';
import { section07 } from './s07-alarms';
import { section08 } from './s08-reporting';
import { section09 } from './s09-traceability';
import { section10 } from './s10-batch-story';
import { section11 } from './s11-control';
import { section12 } from './s12-stock-parties';
import { section13 } from './s13-time-audit';
import { section14 } from './s14-together';

export const ARCHITECTURE_SECTIONS: readonly ArchitectureSection[] = [
  section01,
  section02,
  section03,
  section04,
  section05,
  section06,
  section07,
  section08,
  section09,
  section10,
  section11,
  section12,
  section13,
  section14,
];
