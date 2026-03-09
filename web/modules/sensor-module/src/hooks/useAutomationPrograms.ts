import { useQuery } from '@tanstack/react-query';
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
      id
      programCode
      programName
      status
      variableCount
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
  return useQuery({
    queryKey: ['automationProgramsForBinding'],
    queryFn: () =>
      graphqlFetch<{ automationPrograms: AutomationProgramSummary[] }>(
        PROGRAMS_LIST_QUERY,
        {
          filter: {
            status: [ProgramStatus.APPROVED, ProgramStatus.DEPLOYED],
          },
        },
      ),
    staleTime: 30_000,
  });
}

export function useAutomationProgramVariables(programId: string | null) {
  return useQuery({
    queryKey: ['automationProgramVariables', programId],
    queryFn: () =>
      graphqlFetch<{
        automationProgram: Omit<ProgramWithVariables, 'variables'>;
        programVariables: ProgramVariableSummary[];
      }>(PROGRAM_VARIABLES_QUERY, { id: programId }),
    enabled: !!programId,
  });
}
