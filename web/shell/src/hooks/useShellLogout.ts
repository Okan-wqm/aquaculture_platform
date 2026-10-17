/**
 * useShellLogout — sign out of the shell, both consoles (SUPER_ADMIN header,
 * tenant console user menu).
 *
 * WHY the cache purge: the tenant-scoped query cache is destroyed before
 * /login, so a different user signing in on the same tab never sees the
 * previous tenant's data. SECURITY: removeQueries, not invalidateQueries — the
 * data must be gone, not refetched with credentials that may no longer be
 * valid (FE-CRITICAL-014/015/016). The tenant id is captured before logout
 * clears it from state.
 *
 * WHAT: the sign-out action the headers' menus call; it runs to /login
 * whether or not the server acknowledged the logout.
 */
import { createTenantInvalidationKey, useAuthContext } from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

export function useShellLogout(): () => void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, logout } = useAuthContext();
  const tenantId = user?.tenantId;

  return useCallback((): void => {
    const currentTenantId = tenantId;
    const signOut = async (): Promise<void> => {
      try {
        await logout();
      } finally {
        if (currentTenantId) {
          queryClient.removeQueries({ queryKey: createTenantInvalidationKey(currentTenantId) });
        }
        navigate('/login');
      }
    };
    void signOut();
  }, [logout, navigate, queryClient, tenantId]);
}
