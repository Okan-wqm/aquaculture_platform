/**
 * Whether the Today page speaks about farm sites in a workspace.
 *
 * Sites (farm-service `activeSites`, `Employee.farmId`) are farm-module objects.
 * Production and the all-modules Company view show them; the Greenhouse and
 * Control & sensors rosters are not organised by farm site, so a site filter or
 * an unassigned-sites panel there would list farm sites beside people who do not
 * belong to them. A module added later defaults to "no sites" until it says
 * otherwise here.
 */
import type { HrModuleCode } from '@platform/shared-ui/generated/graphql-types';

export function showsFarmSites(scope: HrModuleCode | undefined): boolean {
  return scope === undefined || scope === 'FARM';
}
