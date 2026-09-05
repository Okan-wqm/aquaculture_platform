// Health context: the one place the SPA learns what this console may do.
//
// WHY: mutating controls must be invisible unless the server says they may be
// used, and the server answers two different questions. Kernel control (pause,
// resume, cycle run) hangs off `actionsEnabled` — the environment-and-manifest
// switch. Case work hangs off /me: the instance's approval policy decides each
// action class for the authenticated principal, and a legal control shown from
// the kernel switch would be wrong in both directions (measured 2026-09-04: the
// shipped legal manifest turns kernel control off, so every case control was
// hidden while the policy that governed them was never asked). Reading both
// once at the root and sharing them by context means no page can pick the
// wrong switch. The runtime profile belongs here for the same reason.
// WHAT: /health for version, tools dir, kernel control and the legal adapter's
// readiness; /me only when a token exists, and /overview only after /me grants
// kernel_read. Legal principals never fetch the global runtime profile.
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { KERNEL_READ_PERMISSION } from '../../../shared/api-contract.ts';
import type { HealthResponse, RuntimeProfile, WhoAmIResponse } from '../../../shared/api-contract.ts';
import { getHealth, getMe, getOverview } from '../api/client.ts';
import { useRequest, type RequestState } from '../api/use-request.ts';
import { canPerform } from './permissions.ts';
import { useToken } from './RequireAuth.tsx';

export interface HealthContextValue {
  readonly state: RequestState<HealthResponse>;
  /** Re-reads health, the principal and the runtime profile. */
  readonly reload: () => void;
  /** False until health has loaded AND says kernel control is enabled. */
  readonly actionsEnabled: boolean;
  /** The authenticated principal; null before /me has answered or without a token. */
  readonly me: WhoAmIResponse | null;
  /** Whether the authenticated principal may perform an action class. False until /me has answered. */
  readonly can: (actionClass: string) => boolean;
  /** Current runtime profile, verbatim from the kernel; null before it is known. */
  readonly profile: RuntimeProfile | null;
}

const HealthContext = createContext<HealthContextValue | null>(null);

export function HealthProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const token = useToken();
  const { state, reload: reloadHealth } = useRequest(() => getHealth(), []);
  const { state: meState, reload: reloadMe } = useRequest<WhoAmIResponse | null>(
    async (signal) => {
      if (token === null) {
        return null;
      }
      return getMe(signal);
    },
    [token],
  );
  const me = meState.status === 'success' ? meState.data : null;
  const kernelRead = canPerform(me, KERNEL_READ_PERMISSION);
  const { state: profileState, reload: reloadProfile } = useRequest<RuntimeProfile | null>(
    async (signal) => {
      if (token === null || !kernelRead) {
        return null;
      }
      const overview = await getOverview(signal);
      return overview.profile.current;
    },
    [token, kernelRead],
  );

  const actionsEnabled = state.status === 'success' && state.data.actionsEnabled;
  const profile = kernelRead && profileState.status === 'success' ? profileState.data : null;
  const can = useCallback((actionClass: string) => canPerform(me, actionClass), [me]);
  const reload = useCallback(() => {
    reloadHealth();
    reloadMe();
    reloadProfile();
  }, [reloadHealth, reloadMe, reloadProfile]);

  return <HealthContext.Provider value={{ state, reload, actionsEnabled, me, can, profile }}>{children}</HealthContext.Provider>;
}

export function useHealth(): HealthContextValue {
  const value = useContext(HealthContext);
  if (value === null) {
    throw new Error('useHealth was called outside HealthProvider.');
  }
  return value;
}
