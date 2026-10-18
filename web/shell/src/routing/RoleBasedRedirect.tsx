/**
 * `/` → where the signed-in user starts (console/nav rootLanding): the admin
 * consoles for the admins, the first module workspace's dashboard for anyone
 * holding a module workspace, the company dashboard for everyone else.
 */
import { BrandLoader, useAuthContext } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';

import { rootLanding } from '../console/nav/rootLanding';

export function RoleBasedRedirect(): ReactElement {
  const { user, modules, isLoading, isAuthenticated } = useAuthContext();

  // Inside the layout, so the loader takes the outlet's area, not the screen.
  if (isLoading) {
    return <BrandLoader />;
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
