import { Baseline1800000000000 } from './1800000000000-Baseline';

/**
 * Canonical farm-service migration class list.
 *
 * Faz 3 of the day-one baseline reset: pre-reset chain (~45 migrations)
 * archived to .archive/<timestamp>/. A single consolidated baseline now
 * represents the complete farm schema. Forward-only migration discipline
 * resumes from this point.
 */
export const FARM_MIGRATIONS = [Baseline1800000000000] as const;
