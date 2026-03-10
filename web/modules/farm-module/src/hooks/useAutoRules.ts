/**
 * Auto Rules hook for farm-module
 * Currently uses mock data as there is no backend for auto rules yet.
 * Will be migrated to GraphQL when the backend is available.
 */
import { useState, useCallback } from 'react';
import { AutoRule } from '../pages/tasks/types/task.types';
import { mockAutoRules } from '../pages/tasks/mock';

/**
 * Hook to manage auto rules (mock data for now)
 */
export function useAutoRules() {
  const [autoRules, setAutoRules] = useState<AutoRule[]>(mockAutoRules);

  const toggleActive = useCallback((ruleId: string) => {
    setAutoRules(prev => prev.map(r =>
      r.id === ruleId ? { ...r, isActive: !r.isActive } : r
    ));
  }, []);

  return {
    autoRules,
    loading: false,
    error: null,
    toggleActive,
  };
}
