import { useQuery } from '@tanstack/react-query';
import { useAuth, createTenantQueryKey } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';
import { ProgramStatus } from '../utils/automation.utils';

export interface ProgramVariableSummary {
  id: string;
  varName: string;
  dataType: string;
  scope: string;
  ioTagName?: string;
  ioConfigId?: string;
}

export interface AutomationProgramSummary {
  id: string;
  programCode: string;
  programName: string;
  status: ProgramStatus;
  variableCount: number;
}

interface ProgramWithVariables {
  id: string;
  programCode: string;
  programName: string;
  status: ProgramStatus;
  variables: ProgramVariableSummary[];
}

const PROGRAMS_LIST_QUERY = `
  query AutomationProgramsForBinding($filter: ProgramFilterInput) {
    automationPrograms(filter: $filter, limit: 100) {
      items {
        id
        programCode
        programName
        status
        variableCount
      }
      total
    }
  }
`;

const PROGRAM_VARIABLES_QUERY = `
  query ProgramVariablesForBinding($id: ID!) {
    automationProgram(id: $id) {
      id
      programCode
      programName
      status
    }
    programVariables(programId: $id) {
      id
      varName
      dataType
      scope
      ioTagName
      ioConfigId
    }
  }
`;

export function useAutomationPrograms() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'automationProgramsForBinding'),
    queryFn: async () => {
      const result = await graphqlFetch<{ automationPrograms: { items: AutomationProgramSummary[] } }>(
        PROGRAMS_LIST_QUERY,
        { filter: {} },
      );
      return {
        automationPrograms: result.automationPrograms.items,
      };
    },
    staleTime: 30_000,
    enabled: !!tenantId,
  });
}

export function useAutomationProgramVariables(programId: string | null) {
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'automationProgramVariables', programId),
    queryFn: () =>
      graphqlFetch<{
        automationProgram: Omit<ProgramWithVariables, 'variables'>;
        programVariables: ProgramVariableSummary[];
      }>(PROGRAM_VARIABLES_QUERY, { id: programId }),
    enabled: !!programId,
  });
}
