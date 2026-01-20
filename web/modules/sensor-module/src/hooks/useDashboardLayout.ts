/**
 * Dashboard Layout Hook
 *
 * Manages dashboard layouts - fetching, saving, deleting.
 * Persists widget configurations to database instead of localStorage.
 */

import { useState, useEffect, useCallback } from 'react';
import { WidgetConfig } from '../components/dashboard/types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// ============================================================================
// Types
// ============================================================================

/**
 * Process background configuration for dashboard
 */
export interface ProcessBackground {
  processId: string | null;
  position: { x: number; y: number };
  scale: number;
  opacity: number;  // 0.1 to 1.0
}

/**
 * Grid configuration for widget placement
 */
export interface GridConfig {
  columns: number;
  cellHeight: number;
  margin: number;
}

export interface DashboardLayout {
  id: string;
  tenantId: string;
  userId?: string;
  name: string;
  description?: string;
  widgets: WidgetConfig[];
  // Process background settings
  processBackground?: ProcessBackground;
  // Grid configuration
  gridConfig?: GridConfig;
  // Grid version for migration (1 = 12 cols, 2 = 24 cols)
  gridVersion?: number;
  isDefault: boolean;
  isSystemDefault: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

export interface SaveLayoutInput {
  id?: string;
  name: string;
  description?: string;
  widgets: WidgetConfig[];
  processBackground?: ProcessBackground;
  gridConfig?: GridConfig;
  gridVersion?: number;
  isDefault?: boolean;
}

// ============================================================================
// GraphQL Queries
// ============================================================================

const GET_LAYOUTS_QUERY = `
  query GetDashboardLayouts {
    dashboardLayouts {
      id
      tenantId
      userId
      name
      description
      widgets
      processBackground
      gridConfig
      gridVersion
      isDefault
      isSystemDefault
      createdAt
      updatedAt
      createdBy
    }
  }
`;

const GET_LAYOUT_QUERY = `
  query GetDashboardLayout($id: ID!) {
    dashboardLayout(id: $id) {
      id
      tenantId
      userId
      name
      description
      widgets
      processBackground
      gridConfig
      gridVersion
      isDefault
      isSystemDefault
      createdAt
      updatedAt
      createdBy
    }
  }
`;

const GET_MY_DEFAULT_LAYOUT_QUERY = `
  query GetMyDefaultLayout {
    myDefaultLayout {
      id
      tenantId
      userId
      name
      description
      widgets
      processBackground
      gridConfig
      gridVersion
      isDefault
      isSystemDefault
      createdAt
      updatedAt
      createdBy
    }
  }
`;

const SAVE_LAYOUT_MUTATION = `
  mutation SaveDashboardLayout($input: SaveDashboardLayoutInput!) {
    saveDashboardLayout(input: $input) {
      id
      tenantId
      userId
      name
      description
      widgets
      processBackground
      gridConfig
      gridVersion
      isDefault
      isSystemDefault
      createdAt
      updatedAt
      createdBy
    }
  }
`;

const DELETE_LAYOUT_MUTATION = `
  mutation DeleteDashboardLayout($id: ID!) {
    deleteDashboardLayout(id: $id)
  }
`;

const SET_AS_DEFAULT_MUTATION = `
  mutation SetLayoutAsDefault($id: ID!) {
    setLayoutAsDefault(id: $id) {
      id
      name
      isDefault
    }
  }
`;

// ============================================================================
// GraphQL Fetch Helper
// ============================================================================

async function graphqlFetch<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = localStorage.getItem('access_token');
  const tenantId = localStorage.getItem('tenant_id');

  const response = await fetch(API_URL, {
    method: 'POST',
    mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useDashboardLayout() {
  const [layouts, setLayouts] = useState<DashboardLayout[]>([]);
  const [currentLayout, setCurrentLayout] = useState<DashboardLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch all user layouts
   */
  const fetchLayouts = useCallback(async () => {
    try {
      const result = await graphqlFetch<{ dashboardLayouts: DashboardLayout[] }>(
        GET_LAYOUTS_QUERY
      );
      setLayouts(result.dashboardLayouts || []);
    } catch (err) {
      console.error('Failed to fetch layouts:', err);
      setLayouts([]);
    }
  }, []);

  /**
   * Fetch user's default layout (or system default)
   */
  const loadMyDefault = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ myDefaultLayout: DashboardLayout | null }>(
        GET_MY_DEFAULT_LAYOUT_QUERY
      );

      if (result.myDefaultLayout) {
        setCurrentLayout(result.myDefaultLayout);
      } else {
        // No layout found - start with empty
        setCurrentLayout(null);
      }
    } catch (err) {
      setError((err as Error).message);
      setCurrentLayout(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Load a specific layout by ID
   */
  const loadLayout = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ dashboardLayout: DashboardLayout }>(
        GET_LAYOUT_QUERY,
        { id }
      );

      if (result.dashboardLayout) {
        setCurrentLayout(result.dashboardLayout);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Save current layout (create or update)
   */
  const saveLayout = useCallback(async (input: SaveLayoutInput): Promise<DashboardLayout | null> => {
    setSaving(true);
    setError(null);

    try {
      const result = await graphqlFetch<{ saveDashboardLayout: DashboardLayout }>(
        SAVE_LAYOUT_MUTATION,
        { input }
      );

      const savedLayout = result.saveDashboardLayout;
      setCurrentLayout(savedLayout);

      // Refresh layouts list
      await fetchLayouts();

      return savedLayout;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setSaving(false);
    }
  }, [fetchLayouts]);

  /**
   * Quick save - updates current layout with new widgets
   */
  const quickSave = useCallback(async (widgets: WidgetConfig[]): Promise<boolean> => {
    if (!currentLayout?.id) {
      setError('No layout to save. Please save as a new layout first.');
      return false;
    }

    const result = await saveLayout({
      id: currentLayout.id,
      name: currentLayout.name,
      description: currentLayout.description,
      widgets,
      isDefault: currentLayout.isDefault,
    });

    return result !== null;
  }, [currentLayout, saveLayout]);

  /**
   * Delete a layout
   */
  const deleteLayout = useCallback(async (id: string): Promise<boolean> => {
    try {
      await graphqlFetch<{ deleteDashboardLayout: boolean }>(
        DELETE_LAYOUT_MUTATION,
        { id }
      );

      // If deleted layout was current, clear it
      if (currentLayout?.id === id) {
        setCurrentLayout(null);
      }

      // Refresh layouts list
      await fetchLayouts();

      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, [currentLayout, fetchLayouts]);

  /**
   * Set a layout as the user's default
   */
  const setAsDefault = useCallback(async (id: string): Promise<boolean> => {
    try {
      await graphqlFetch<{ setLayoutAsDefault: DashboardLayout }>(
        SET_AS_DEFAULT_MUTATION,
        { id }
      );

      // Refresh layouts list to update isDefault flags
      await fetchLayouts();

      // Update current layout if it's the one being set as default
      if (currentLayout?.id === id) {
        setCurrentLayout((prev) =>
          prev ? { ...prev, isDefault: true } : null
        );
      }

      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }, [currentLayout, fetchLayouts]);

  /**
   * Update widgets in current layout (local state only)
   */
  const updateWidgets = useCallback((widgets: WidgetConfig[]) => {
    setCurrentLayout((prev) =>
      prev ? { ...prev, widgets } : null
    );
  }, []);

  /**
   * Clear error
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Load default layout on mount
  useEffect(() => {
    loadMyDefault();
    fetchLayouts();
  }, [loadMyDefault, fetchLayouts]);

  return {
    // State
    layouts,
    currentLayout,
    loading,
    saving,
    error,

    // Actions
    loadMyDefault,
    loadLayout,
    fetchLayouts,
    saveLayout,
    quickSave,
    deleteLayout,
    setAsDefault,
    updateWidgets,
    setCurrentLayout,
    clearError,
  };
}

export default useDashboardLayout;
