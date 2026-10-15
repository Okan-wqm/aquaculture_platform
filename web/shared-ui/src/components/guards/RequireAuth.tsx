/**
 * RequireAuth — the single module-level authentication gate (guard family).
 *
 * Defense-in-depth for Module Federation: a remote bundle can be fetched and
 * instantiated independently of the shell's route guard, so every federated
 * `Module.tsx` re-checks the session with THIS component instead of a local
 * copy. Auth state comes from `useAuthContext()` (AuthProvider in the shell,
 * published bridge snapshot when the remote runs standalone) — never from a
 * client-decoded JWT.
 *
 * The backend remains the real enforcement; this gate only decides what an
 * unauthenticated visitor can REACH in the SPA.
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthContext } from '../../contexts/AuthContext';
import { GuardLoading } from './GuardLoading';

export interface RequireAuthProps {
  children: React.ReactNode;
  /**
   * Rendered while the session check is in flight. Default: the family's
   * light inline spinner (`GuardLoading`). Pass a localized/custom node when
   * a module needs its own wording — the GATE logic stays here either way.
   */
  loadingFallback?: React.ReactNode;
}

export const RequireAuth: React.FC<RequireAuthProps> = ({ children, loadingFallback }) => {
  const { isAuthenticated, isLoading } = useAuthContext();

  if (isLoading) {
    return <>{loadingFallback ?? <GuardLoading />}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};
