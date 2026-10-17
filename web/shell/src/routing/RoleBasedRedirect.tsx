/**
 * `/` → where the signed-in user starts (console/nav rootLanding): the admin
 * consoles for the admins, the first module workspace's dashboard for anyone
 * holding a module workspace, the company dashboard for everyone else.
 */
import { PageLoading, useAuthContext } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

import { rootLanding } from '../console/nav/rootLanding';

export function RoleBasedRedirect(): ReactElement {
  const { user, modules, isLoading, isAuthenticated } = useAuthContext();

  if (isLoading) {
    return <PageLoading text="Redirecting..." />;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }

  const landing = rootLanding(
    user.role,
    modules.map((module) => module.code),
  );
  return <Navigate to={landing} replace />;
}
