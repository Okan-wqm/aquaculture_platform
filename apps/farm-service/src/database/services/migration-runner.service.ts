import { createMigrationRunnerService } from '@aquaculture/backend-common';

/**
 * MigrationRunnerService for farm-service.
 *
 * Thin re-export of the shared factory in backend-common. The shared
 * implementation carries the full docblock explaining the
 * search_path-pin-per-migration invariant and the 2026-04-07 incident
 * that motivated it.
 *
 * @see createMigrationRunnerService at
 *      libs/backend-common/src/database/migration-runner/migration-runner.service.ts
 */
export const MigrationRunnerService = createMigrationRunnerService('farm');
