/**
 * Tenant Context
 * Multi-tenant uygulama için tenant durumu yönetimi
 */

import React, { createContext, useContext, useReducer, useCallback } from 'react';
import type { Tenant } from '../types';
import { clearActAsContext, setActAsContext, setTenantId } from '../utils/api-client';

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

/** Why a SUPER_ADMIN is acting on a tenant that is not their own (ADR-0007). */
export interface ActAsJustification {
  reason: string;
  ticket?: string;
}

interface TenantContextValue extends TenantState {
  /**
   * Act on `tenant` as a SUPER_ADMIN. The kernel refuses a cross-tenant act-as
   * without a reason, so the justification is part of the call, not optional
   * follow-up state. The caller supplies the tenant it already holds (a list
   * row, a detail page) — nothing is fetched or fabricated here.
   */
  switchTenant: (tenant: Tenant, justification: ActAsJustification) => Promise<void>;
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

  const switchTenant = useCallback(
    async (tenant: Tenant, justification: ActAsJustification): Promise<void> => {
      dispatch({ type: 'TENANT_LOADING' });
      try {
        // Order matters: the active tenant must be set BEFORE the justification
        // is bound to it, because getActAsContext() drops a context whose
        // tenant is not the active one.
        setTenantId(tenant.id);
        setActAsContext({ tenantId: tenant.id, reason: justification.reason, ticket: justification.ticket });
        dispatch({ type: 'TENANT_LOADED', payload: tenant });
      } catch (error) {
        clearActAsContext();
        dispatch({ type: 'TENANT_ERROR', payload: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    [],
  );

  const clearTenant = useCallback(() => {
    clearActAsContext();
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
