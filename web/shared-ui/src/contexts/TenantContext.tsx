/**
 * Tenant Context
 * Multi-tenant uygulama için tenant durumu yönetimi
 */

import React, { createContext, useContext, useReducer, useCallback } from 'react';
import type { Tenant } from '../types';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

interface TenantState {
  tenant: Tenant | null;
  isLoading: boolean;
  error: string | null;
}

type TenantAction =
  | { type: 'TENANT_LOADING' }
  | { type: 'TENANT_LOADED'; payload: Tenant }
  | { type: 'TENANT_ERROR'; payload: string }
  | { type: 'CLEAR_TENANT' };

interface TenantContextValue extends TenantState {
  switchTenant: (tenantId: string) => Promise<void>;
  clearTenant: () => void;
}

// ============================================================================
// Reducer
// ============================================================================

const initialState: TenantState = {
  tenant: null,
  isLoading: false,
  error: null,
};

function tenantReducer(state: TenantState, action: TenantAction): TenantState {
  switch (action.type) {
    case 'TENANT_LOADING':
      return { ...state, isLoading: true, error: null };

    case 'TENANT_LOADED':
      return { ...state, tenant: action.payload, isLoading: false, error: null };

    case 'TENANT_ERROR':
      return { ...state, isLoading: false, error: action.payload };

    case 'CLEAR_TENANT':
      return { ...state, tenant: null, isLoading: false, error: null };

    default:
      return state;
  }
}

// ============================================================================
// Context
// ============================================================================

const TenantContext = createContext<TenantContextValue | undefined>(undefined);

// ============================================================================
// Provider
// ============================================================================

export interface TenantProviderProps {
  children: React.ReactNode;
  initialTenant?: Tenant;
}

export const TenantProvider: React.FC<TenantProviderProps> = ({
  children,
  initialTenant,
}) => {
  const [state, dispatch] = useReducer(tenantReducer, {
    ...initialState,
    tenant: initialTenant ?? null,
  });

  // CRIT-5/BUG-004/PERF-008: switchTenant is not yet implemented.
  // Throw a clear error rather than silently returning fabricated mock data.
  // When implementing: make a real API call, dispatch TENANT_LOADED with real data.
  const switchTenant = useCallback(async (_tenantId: string): Promise<void> => {
    throw new Error('switchTenant: not implemented. Provide a real tenant fetch before calling this.');
  }, []);

  const clearTenant = useCallback(() => {
    dispatch({ type: 'CLEAR_TENANT' });
  }, []);

  const value: TenantContextValue = {
    ...state,
    switchTenant,
    clearTenant,
  };

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
};

// ============================================================================
// Hook
// ============================================================================

export function useTenantContext(): TenantContextValue {
  const context = useContext(TenantContext);

  if (context === undefined) {
    throw new Error('useTenantContext must be used within a TenantProvider');
  }

  return context;
}

export default TenantContext;
