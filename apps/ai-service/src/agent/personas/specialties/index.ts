import type { AiSpecialtyId } from '@aquaculture/shared-contracts';
import type { AgentSpecialty } from '../types';
import { GENERAL_SPECIALTY } from './general.specialty';
import { FARM_WATER_HEALTH_SPECIALTY } from './farm-water-health.specialty';
import { FARM_PRODUCTION_SPECIALTY } from './farm-production.specialty';
import { FARM_OPERATIONS_SPECIALTY } from './farm-operations.specialty';

/** Every specialty, keyed by the shared-contracts specialty id. */
export const SPECIALTIES: Readonly<Record<AiSpecialtyId, AgentSpecialty>> = Object.freeze({
  general: GENERAL_SPECIALTY,
  'farm-water-health': FARM_WATER_HEALTH_SPECIALTY,
  'farm-production': FARM_PRODUCTION_SPECIALTY,
  'farm-operations': FARM_OPERATIONS_SPECIALTY,
});

export {
  GENERAL_SPECIALTY,
  FARM_WATER_HEALTH_SPECIALTY,
  FARM_PRODUCTION_SPECIALTY,
  FARM_OPERATIONS_SPECIALTY,
};
