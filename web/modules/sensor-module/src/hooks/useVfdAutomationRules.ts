import { useState, useCallback } from 'react';
import {
  VfdAutomationRule,
  VfdParameterAuditLog,
  CreateAutomationRuleInput,
  UpdateAutomationRuleInput,
} from '../types/vfd.types';
import { graphqlFetch } from '../config/api';
import {
  VFD_AUTOMATION_RULES_QUERY,
  VFD_AUTOMATION_RULES_BY_DEVICE_QUERY,
  VFD_AUTOMATION_RULE_QUERY,
  VFD_AUTOMATION_RULE_HISTORY_QUERY,
  CREATE_VFD_AUTOMATION_RULE_MUTATION,
  UPDATE_VFD_AUTOMATION_RULE_MUTATION,
  DELETE_VFD_AUTOMATION_RULE_MUTATION,
  TOGGLE_VFD_AUTOMATION_RULE_MUTATION,
} from '../graphql/vfd-programming.operations';

interface UseVfdAutomationRulesReturn {
  rules: VfdAutomationRule[];
  selectedRule: VfdAutomationRule | null;
  loading: boolean;
  error: string | null;
  fetchRules: (vfdDeviceId?: string) => Promise<void>;
  fetchRule: (id: string) => Promise<VfdAutomationRule>;
  fetchExecutionHistory: (ruleId: string, limit?: number) => Promise<VfdParameterAuditLog[]>;
  createRule: (input: CreateAutomationRuleInput) => Promise<VfdAutomationRule>;
  updateRule: (id: string, input: UpdateAutomationRuleInput) => Promise<VfdAutomationRule>;
  deleteRule: (id: string) => Promise<boolean>;
  toggleRule: (id: string, isActive: boolean) => Promise<VfdAutomationRule>;
  getActiveRules: () => VfdAutomationRule[];
  getRulesByDevice: () => Map<string, VfdAutomationRule[]>;
}

/**
 * Hook for VFD automation rule CRUD, toggle, and execution history.
 */
export function useVfdAutomationRules(): UseVfdAutomationRulesReturn {
  const [rules, setRules] = useState<VfdAutomationRule[]>([]);
  const [selectedRule, setSelectedRule] = useState<VfdAutomationRule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRules = useCallback(async (vfdDeviceId?: string) => {
    setLoading(true);
    setError(null);

    try {
      if (vfdDeviceId) {
        const data = await graphqlFetch<{
          vfdAutomationRulesByDevice: VfdAutomationRule[];
        }>(VFD_AUTOMATION_RULES_BY_DEVICE_QUERY, { vfdDeviceId });

        setRules(data.vfdAutomationRulesByDevice);
      } else {
        const data = await graphqlFetch<{
          vfdAutomationRules: VfdAutomationRule[];
        }>(VFD_AUTOMATION_RULES_QUERY);

        setRules(data.vfdAutomationRules);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch automation rules';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRule = useCallback(async (id: string): Promise<VfdAutomationRule> => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{
        vfdAutomationRule: VfdAutomationRule;
      }>(VFD_AUTOMATION_RULE_QUERY, { id });

      setSelectedRule(data.vfdAutomationRule);
      return data.vfdAutomationRule;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch automation rule';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchExecutionHistory = useCallback(
    async (ruleId: string, limit = 50): Promise<VfdParameterAuditLog[]> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          vfdAutomationRuleHistory: VfdParameterAuditLog[];
        }>(VFD_AUTOMATION_RULE_HISTORY_QUERY, { ruleId, limit });

        return data.vfdAutomationRuleHistory;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch execution history';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const createRule = useCallback(
    async (input: CreateAutomationRuleInput): Promise<VfdAutomationRule> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          createVfdAutomationRule: VfdAutomationRule;
        }>(CREATE_VFD_AUTOMATION_RULE_MUTATION, { input });

        const created = data.createVfdAutomationRule;
        setRules((prev) => [created, ...prev]);
        setSelectedRule(created);
        return created;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create automation rule';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const updateRule = useCallback(
    async (id: string, input: UpdateAutomationRuleInput): Promise<VfdAutomationRule> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          updateVfdAutomationRule: VfdAutomationRule;
        }>(UPDATE_VFD_AUTOMATION_RULE_MUTATION, { id, input });

        const updated = data.updateVfdAutomationRule;
        setRules((prev) => prev.map((r) => (r.id === id ? updated : r)));
        setSelectedRule(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update automation rule';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const deleteRule = useCallback(async (id: string): Promise<boolean> => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{
        deleteVfdAutomationRule: boolean;
      }>(DELETE_VFD_AUTOMATION_RULE_MUTATION, { id });

      if (data.deleteVfdAutomationRule) {
        setRules((prev) => prev.filter((r) => r.id !== id));
        if (selectedRule?.id === id) {
          setSelectedRule(null);
        }
      }
      return data.deleteVfdAutomationRule;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete automation rule';
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [selectedRule]);

  const toggleRule = useCallback(
    async (id: string, isActive: boolean): Promise<VfdAutomationRule> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{
          toggleVfdAutomationRule: VfdAutomationRule;
        }>(TOGGLE_VFD_AUTOMATION_RULE_MUTATION, { id, isActive });

        const updated = data.toggleVfdAutomationRule;
        setRules((prev) => prev.map((r) => (r.id === id ? updated : r)));
        setSelectedRule(updated);
        return updated;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to toggle automation rule';
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const getActiveRules = useCallback(() => {
    return rules.filter((r) => r.isActive);
  }, [rules]);

  const getRulesByDevice = useCallback(() => {
    const grouped = new Map<string, VfdAutomationRule[]>();
    for (const rule of rules) {
      for (const deviceId of rule.targetVfdDeviceIds) {
        const existing = grouped.get(deviceId) ?? [];
        existing.push(rule);
        grouped.set(deviceId, existing);
      }
    }
    return grouped;
  }, [rules]);

  return {
    rules,
    selectedRule,
    loading,
    error,
    fetchRules,
    fetchRule,
    fetchExecutionHistory,
    createRule,
    updateRule,
    deleteRule,
    toggleRule,
    getActiveRules,
    getRulesByDevice,
  };
}
