/**
 * The company dashboard (/tenant), open to every tenant member.
 *
 * WHY two views: a tenant admin's dashboard is the account's — users, modules,
 * subscription, sessions — and stays exactly as it was (TenantDashboard). A
 * member who is not one sees only what is theirs to see (MemberCompanyHome):
 * none of the admin's cards is drawn and none of their admin-only queries is
 * sent; the backend refuses those reads to them regardless.
 */
import { useAuthContext } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import MemberCompanyHome from './companyHome/MemberCompanyHome';
import TenantDashboard from './TenantDashboard';

export default function CompanyHome(): ReactElement {
  const { hasRoleOrHigher } = useAuthContext();
  return hasRoleOrHigher('TENANT_ADMIN') ? <TenantDashboard /> : <MemberCompanyHome />;
}
