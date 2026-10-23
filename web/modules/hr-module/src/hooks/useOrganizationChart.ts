/**
 * useOrganizationChart — the data behind the organization chart page.
 *
 * The server derives everything the chart counts: each department arrives with
 * its head count and its manager's name (`DepartmentOrganization`), so the
 * browser never reads the roster to add people up. The people placed in no
 * department belong to no module, so only the Company view asks for them (the
 * tenant-wide `unplacedEmployees` statistic); a module workspace holds only
 * placed people.
 *
 * The module scope is resolved once and put in BOTH the request variables and
 * the query key (D4). The key sits under `departmentKeys.all`, so every
 * department mutation — and every employee mutation that moves someone —
 * refreshes the chart.
 */
import { useMemo } from 'react';
import { useTenantQuery } from '@aquaculture/shared-ui';
import { GET_ORGANIZATION_DEPARTMENTS } from '../graphql';
import { buildOrgTree, type OrgTree } from '../pages/organization/buildOrgTree';
import type { OrganizationDepartment } from '../types';
import { graphqlRequest, useGraphQLClient } from './useGraphQL';
import { departmentKeys, useHRDashboardStats } from './useEmployees';
import { useModuleScope } from './useModuleScope';

export interface OrganizationChart {
  /** Undefined until the departments are loaded. */
  tree: OrgTree | undefined;
  /** People who have not left but sit in no department; always 0 inside a module workspace. */
  unplacedHeadCount: number;
  isLoading: boolean;
  error: Error | null;
}

export function useOrganizationChart(): OrganizationChart {
  const client = useGraphQLClient();
  const moduleCode = useModuleScope();
  const isCompanyView = moduleCode === undefined;
  const variables = { moduleCode };

  const departments = useTenantQuery(
    departmentKeys.organization(variables),
    () =>
      graphqlRequest<{ hrDepartments: OrganizationDepartment[] }, unknown>(
        client,
        GET_ORGANIZATION_DEPARTMENTS,
        variables,
      ),
    { select: (data) => data.hrDepartments, keepPreviousData: false },
  );
  const stats = useHRDashboardStats({ enabled: isCompanyView });

  const departmentList = departments.data;
  const tree = useMemo(
    () => (departmentList ? buildOrgTree(departmentList) : undefined),
    [departmentList],
  );

  return {
    tree,
    unplacedHeadCount: isCompanyView ? (stats.data?.unplacedEmployees ?? 0) : 0,
    isLoading: departments.isLoading || stats.isLoading,
    error: departments.error ?? stats.error,
  };
}
