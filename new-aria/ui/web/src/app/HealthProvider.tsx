// Health context: the one place the SPA learns `actionsEnabled`.
//
// WHY: mutating controls (pause/resume, cycle run) must be invisible unless the
// server explicitly reports ARIA_UI_ALLOW_ACTIONS=1. Reading /health once at the
// root and sharing it by context means no page can forget the check.
import { createContext, useContext, type ReactNode } from 'react';
import type { HealthResponse } from '../../../shared/api-contract.ts';
import { getHealth } from '../api/client.ts';
import { useRequest, type RequestState } from '../api/use-request.ts';

export interface HealthContextValue {
  readonly state: RequestState<HealthResponse>;
  readonly reload: () => void;
  /** False until health has loaded AND says actions are enabled. */
  readonly actionsEnabled: boolean;
}

const HealthContext = createContext<HealthContextValue | null>(null);

export function HealthProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const { state, reload } = useRequest(() => getHealth(), []);
  const actionsEnabled = state.status === 'success' && state.data.actionsEnabled;
  return <HealthContext.Provider value={{ state, reload, actionsEnabled }}>{children}</HealthContext.Provider>;
}

export function useHealth(): HealthContextValue {
  const value = useContext(HealthContext);
  if (value === null) {
    throw new Error('useHealth, HealthProvider dışında çağrıldı.');
  }
  return value;
}
