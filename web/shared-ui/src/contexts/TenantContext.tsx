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

  const switchTenant = useCallback(async (tenantId: string): Promise<void> => {
    dispatch({ type: 'TENANT_LOADING' });

    try {
      // API çağrısı - şimdilik mock
      const mockTenant: Tenant = {
        id: tenantId,
        name: 'Mock Tenant',
        slug: 'mock-tenant',
        tier: 'professional',
        status: 'active',
        settings: {
          timezone: 'Europe/Istanbul',
          locale: 'tr-TR',
          currency: 'TRY',
          dateFormat: 'DD.MM.YYYY',
          measurementSystem: 'metric',
        },
        limits: {
          maxUsers: 50,
          maxFarms: 10,
          maxPonds: 100,
          maxSensors: 500,
          maxAlertRules: 50,
          dataRetentionDays: 365,
          apiRateLimit: 1000,
        },
        createdAt: new Date(),
      };

      dispatch({ type: 'TENANT_LOADED', payload: mockTenant });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tenant yüklenemedi';
      dispatch({ type: 'TENANT_ERROR', payload: message });
    }
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
