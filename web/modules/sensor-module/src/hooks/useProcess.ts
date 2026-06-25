import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@aquaculture/shared-ui';
import { graphqlFetch } from '../config/api';

// Types
export type ProcessStatus = 'draft' | 'active' | 'inactive' | 'archived';

export interface ProcessNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    equipmentId?: string;
    equipmentName: string;
    equipmentCode?: string;
    equipmentType?: string;
    equipmentCategory?: string;
    status?: string;
    sensorMappings?: SensorMapping[];
    connectionPoints?: Record<string, string>;
    metadata?: Record<string, unknown>;
  };
}

export interface ProcessEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface SensorMapping {
  sensorId: string;
  sensorName: string;
  channelId: string;
  channelName: string;
  dataPath: string;
  dataType: string;
  unit?: string;
}

export interface Process {
  id: string;
  name: string;
  description?: string;
  status: ProcessStatus;
  nodes: ProcessNode[];
  edges: ProcessEdge[];
  tenantId: string;
  siteId?: string;
  departmentId?: string;
  metadata?: Record<string, unknown>;
  isTemplate: boolean;
  templateName?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}

export interface ProcessFilter {
  status?: ProcessStatus;
  siteId?: string;
  departmentId?: string;
  isTemplate?: boolean;
  searchTerm?: string;
}

export interface ProcessListResult {
  items: Process[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ProcessResult {
  success: boolean;
  message?: string;
  process?: Process;
}

export interface CreateProcessInput {
  name: string;
  description?: string;
  status?: ProcessStatus;
  nodes?: ProcessNode[];
  edges?: ProcessEdge[];
  siteId?: string;
  departmentId?: string;
  metadata?: Record<string, unknown>;
  isTemplate?: boolean;
  templateName?: string;
}

export interface UpdateProcessInput {
  processId: string;
  name?: string;
  description?: string;
  status?: ProcessStatus;
  nodes?: ProcessNode[];
  edges?: ProcessEdge[];
  siteId?: string;
  departmentId?: string;
  metadata?: Record<string, unknown>;
  isTemplate?: boolean;
  templateName?: string;
}

// GraphQL Queries
const GET_PROCESS_QUERY = `
  query GetProcess($id: ID!) {
    process(id: $id) {
      id
      name
      description
      status
      nodes
      edges
      tenantId
      siteId
      departmentId
      metadata
      isTemplate
      templateName
      createdAt
      updatedAt
      createdBy
      updatedBy
    }
  }
`;

const GET_PROCESSES_QUERY = `
  query GetProcesses($filter: ProcessFilterInput, $pagination: ProcessPaginationInput) {
    processes(filter: $filter, pagination: $pagination) {
      items {
        id
        name
        description
        status
        nodes
        edges
        tenantId
        siteId
        departmentId
        metadata
        isTemplate
        templateName
        createdAt
        updatedAt
        createdBy
        updatedBy
      }
      total
      page
      limit
      totalPages
      hasNextPage
      hasPreviousPage
    }
  }
`;

const GET_ACTIVE_PROCESSES_QUERY = `
  query GetActiveProcesses($siteId: ID) {
    activeProcesses(siteId: $siteId) {
      id
      name
      description
      status
      nodes
      edges
      tenantId
      siteId
      departmentId
      metadata
      isTemplate
      templateName
      createdAt
      updatedAt
      createdBy
      updatedBy
    }
  }
`;

const GET_ALL_PROCESSES_QUERY = `
  query GetAllProcesses($filter: ProcessFilterInput) {
    processes(filter: $filter) {
      items {
        id
        name
        description
        status
        nodes
        edges
        tenantId
        siteId
        departmentId
        metadata
        isTemplate
        templateName
        createdAt
        updatedAt
        createdBy
        updatedBy
      }
      total
    }
  }
`;

const GET_PROCESS_TEMPLATES_QUERY = `
  query GetProcessTemplates {
    processTemplates {
      id
      name
      description
      status
      nodes
      edges
      tenantId
      siteId
      departmentId
      metadata
      isTemplate
      templateName
      createdAt
      updatedAt
      createdBy
      updatedBy
    }
  }
`;

// GraphQL Mutations
const CREATE_PROCESS_MUTATION = `
  mutation CreateProcess($input: CreateProcessInput!) {
    createProcess(input: $input) {
      success
      message
      process {
        id
        name
        description
        status
        nodes
        edges
        tenantId
        siteId
        departmentId
        metadata
        isTemplate
        templateName
        createdAt
        updatedAt
        createdBy
        updatedBy
      }
    }
  }
`;

const UPDATE_PROCESS_MUTATION = `
  mutation UpdateProcess($input: UpdateProcessInput!) {
    updateProcess(input: $input) {
      success
      message
      process {
        id
        name
        description
        status
        nodes
        edges
        tenantId
        siteId
        departmentId
        metadata
        isTemplate
        templateName
        createdAt
        updatedAt
        createdBy
        updatedBy
      }
    }
  }
`;

const DELETE_PROCESS_MUTATION = `
  mutation DeleteProcess($id: ID!) {
    deleteProcess(id: $id) {
      success
      message
      deletedId
    }
  }
`;

const DUPLICATE_PROCESS_MUTATION = `
  mutation DuplicateProcess($id: ID!, $newName: String!) {
    duplicateProcess(id: $id, newName: $newName) {
      success
      message
      process {
        id
        name
        description
        status
        nodes
        edges
        tenantId
        siteId
        departmentId
        metadata
        isTemplate
        templateName
        createdAt
        updatedAt
        createdBy
        updatedBy
      }
    }
  }
`;

// Hook for process CRUD operations
export function useProcess() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get a single process by ID
  const getProcess = useCallback(async (id: string): Promise<Process | null> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ process: Process | null }>(GET_PROCESS_QUERY, { id });
      return result.process;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Get active processes for SCADA view
  const getActiveProcesses = useCallback(async (siteId?: string): Promise<Process[]> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ activeProcesses: Process[] }>(GET_ACTIVE_PROCESSES_QUERY, { siteId });
      return result.activeProcesses;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // Get process templates
  const getProcessTemplates = useCallback(async (): Promise<Process[]> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ processTemplates: Process[] }>(GET_PROCESS_TEMPLATES_QUERY);
      return result.processTemplates;
    } catch (err) {
      setError((err as Error).message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  // List processes with filtering and pagination
  const listProcesses = useCallback(async (
    filter?: ProcessFilter,
    pagination?: { page?: number; limit?: number }
  ): Promise<ProcessListResult | null> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ processes: ProcessListResult }>(GET_PROCESSES_QUERY, {
        filter,
        pagination,
      });
      return result.processes;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Create a new process
  const createProcess = useCallback(async (input: CreateProcessInput): Promise<ProcessResult> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ createProcess: ProcessResult }>(CREATE_PROCESS_MUTATION, { input });
      return result.createProcess;
    } catch (err) {
      const errorMessage = (err as Error).message;
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  }, []);

  // Update an existing process
  const updateProcess = useCallback(async (input: UpdateProcessInput): Promise<ProcessResult> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ updateProcess: ProcessResult }>(UPDATE_PROCESS_MUTATION, { input });
      return result.updateProcess;
    } catch (err) {
      const errorMessage = (err as Error).message;
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  }, []);

  // Delete (archive) a process
  const deleteProcess = useCallback(async (id: string): Promise<{ success: boolean; message?: string }> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ deleteProcess: { success: boolean; message?: string } }>(
        DELETE_PROCESS_MUTATION,
        { id }
      );
      return result.deleteProcess;
    } catch (err) {
      const errorMessage = (err as Error).message;
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  }, []);

  // Duplicate a process
  const duplicateProcess = useCallback(async (id: string, newName: string): Promise<ProcessResult> => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ duplicateProcess: ProcessResult }>(DUPLICATE_PROCESS_MUTATION, {
        id,
        newName,
      });
      return result.duplicateProcess;
    } catch (err) {
      const errorMessage = (err as Error).message;
      setError(errorMessage);
      return { success: false, message: errorMessage };
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    loading,
    error,
    getProcess,
    getActiveProcesses,
    getProcessTemplates,
    listProcesses,
    createProcess,
    updateProcess,
    deleteProcess,
    duplicateProcess,
  };
}

// Hook for fetching active processes list (for SCADA page)
// Now fetches all non-archived processes (draft, active, inactive)
export function useActiveProcesses(siteId?: string) {
  const { token, tenantId } = useAuth();
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProcesses = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // BUG-009: do not pass an archived status filter to avoid archived processes from coming over the wire.
      // The schema only supports a single ProcessStatus filter, so we fetch non-template processes and
      // filter archived items client-side (but the backend still skips template entries).
      const filter: ProcessFilter = {
        isTemplate: false,
        ...(siteId ? { siteId } : {}),
      };
      const result = await graphqlFetch<{ processes: ProcessListResult }>(GET_ALL_PROCESSES_QUERY, { filter });
      // BUG-009: keep only non-archived processes (lowercase status from API)
      const nonArchivedProcesses = result.processes.items.filter(
        (p) => p.status !== 'archived'
      );
      setProcesses(nonArchivedProcesses);
    } catch (err) {
      console.error('Failed to fetch processes:', err);
      setError((err as Error).message);
      setProcesses([]);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    // AUTH-READINESS GATE: do not query before tenant context (token + tenantId)
    // is ready, otherwise the mount fetch races the auth lifecycle and queries
    // with a null tenant (401/empty). Re-runs when the tenant becomes ready/changes.
    if (!token || !tenantId) {
      setProcesses([]);
      setLoading(false);
      return;
    }
    fetchProcesses();
  }, [fetchProcesses, token, tenantId]);

  const refetch = useCallback(() => {
    fetchProcesses();
  }, [fetchProcesses]);

  return {
    processes,
    loading,
    error,
    refetch,
  };
}

// Hook for fetching a single process by ID
export function useProcessById(processId: string | undefined) {
  const { token, tenantId } = useAuth();
  const [process, setProcess] = useState<Process | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProcess = useCallback(async () => {
    if (!processId) {
      setProcess(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ process: Process | null }>(GET_PROCESS_QUERY, { id: processId });
      setProcess(result.process);
    } catch (err) {
      setError((err as Error).message);
      setProcess(null);
    } finally {
      setLoading(false);
    }
  }, [processId]);

  useEffect(() => {
    // AUTH-READINESS GATE: do not query before tenant context (token + tenantId)
    // is ready, otherwise the mount fetch races the auth lifecycle and queries
    // with a null tenant (401/empty). Re-runs when the tenant becomes ready/changes.
    if (!token || !tenantId) {
      setProcess(null);
      setLoading(false);
      return;
    }
    fetchProcess();
  }, [fetchProcess, token, tenantId]);

  const refetch = useCallback(() => {
    fetchProcess();
  }, [fetchProcess]);

  return {
    process,
    loading,
    error,
    refetch,
  };
}
