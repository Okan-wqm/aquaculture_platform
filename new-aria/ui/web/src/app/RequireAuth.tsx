// Auth guard: no token in sessionStorage → login, remembering where the operator wanted to go.
import { useSyncExternalStore, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { getToken, subscribeToken } from '../api/token-store.ts';
import { ROUTES } from './routes.ts';

function getServerSnapshot(): string | null {
  return null;
}

export function useToken(): string | null {
  return useSyncExternalStore(subscribeToken, getToken, getServerSnapshot);
}

export function RequireAuth(): ReactNode {
  const token = useToken();
  const location = useLocation();
  if (token === null) {
    return <Navigate to={ROUTES.login} replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
}
