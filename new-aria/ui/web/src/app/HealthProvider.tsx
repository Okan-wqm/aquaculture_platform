// Health context: the one place the SPA learns `actionsEnabled` and the runtime profile.
//
// WHY: mutating controls (pause/resume, cycle run) must be invisible unless the
// server explicitly reports ARIA_UI_ALLOW_ACTIONS=1. Reading /health once at the
// root and sharing it by context means no page can forget the check. The runtime
// profile belongs here for the same reason: the shell shows it on every screen,
// so it is fetched once above the router rather than per page.
// WHAT: /health for version, tools dir and actions; /overview for the profile,
// requested only when a token exists so the login screen makes no 401 call.
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { HealthResponse, RuntimeProfile } from '../../../shared/api-contract.ts';
import { getHealth, getOverview } from '../api/client.ts';
import { useRequest, type RequestState } from '../api/use-request.ts';
import { useToken } from './RequireAuth.tsx';

export interface HealthContextValue {
  readonly state: RequestState<HealthResponse>;
  /** Re-reads health and the runtime profile. */
  readonly reload: () => void;
  /** False until health has loaded AND says actions are enabled. */
  readonly actionsEnabled: boolean;
  /** Current runtime profile, verbatim from the kernel; null before it is known. */
  readonly profile: RuntimeProfile | null;
}

const HealthContext = createContext<HealthContextValue | null>(null);

export function HealthProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const token = useToken();
  const { state, reload: reloadHealth } = useRequest(() => getHealth(), []);
  const { state: profileState, reload: reloadProfile } = useRequest<RuntimeProfile | null>(
    async (signal) => {
      if (token === null) {
        return null;
      }
      const overview = await getOverview(signal);
      return overview.profile.current;
    },
    [token],
  );

  const actionsEnabled = state.status === 'success' && state.data.actionsEnabled;
  const profile = profileState.status === 'success' ? profileState.data : null;
  const reload = useCallback(() => {
    reloadHealth();
    reloadProfile();
  }, [reloadHealth, reloadProfile]);

  return <HealthContext.Provider value={{ state, reload, actionsEnabled, profile }}>{children}</HealthContext.Provider>;
}

export function useHealth(): HealthContextValue {
  const value = useContext(HealthContext);
  if (value === null) {
    throw new Error('useHealth was called outside HealthProvider.');
  }
  return value;
}
