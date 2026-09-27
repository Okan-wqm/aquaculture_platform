/**
 * ActAsTenantBanner — a SUPER_ADMIN acting on a tenant sees it and can leave
 * (FE-MEDIUM-092).
 *
 * The act-as context lives in the API client (session storage, so it survives
 * a reload) and rides every request as headers; nothing in the UI showed it
 * and nothing let the operator leave it. This banner subscribes to that store,
 * names the tenant, the reason and the ticket, and its exit clears the
 * context, returns the client to the operator's own tenant, drops the acted
 * tenant's cached queries and goes back to the tenant list.
 */

import {
  Button,
  createTenantInvalidationKey,
  setTenantId,
  useActAsContext,
  useAuthContext,
  useI18n,
  useTenantContext,
} from '@aquaculture/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { useNavigate } from 'react-router-dom';

export const ActAsTenantBanner = (): React.ReactElement | null => {
  const context = useActAsContext();
  const { user } = useAuthContext();
  const { tenant, clearTenant } = useTenantContext();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  if (!context || !user || user.role !== 'SUPER_ADMIN') return null;

  const tenantName = tenant && tenant.id === context.tenantId ? tenant.name : context.tenantId;

  const exit = (): void => {
    const actedTenantId = context.tenantId;
    clearTenant();
    setTenantId(user.tenantId ?? null);
    queryClient.removeQueries({ queryKey: createTenantInvalidationKey(actedTenantId) });
    navigate('/admin/tenants');
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning-300 bg-warning-50 px-4 py-2 text-sm text-warning-900 dark:border-warning-700 dark:bg-warning-900/40 dark:text-warning-100"
    >
      <span className="font-semibold">{t('actAs.banner', { tenant: tenantName })}</span>
      <span>
        {t('actAs.reason')}: {context.reason}
      </span>
      {context.ticket && (
        <span>
          {t('actAs.ticket')}: {context.ticket}
        </span>
      )}
      <Button variant="outline" size="sm" className="ml-auto" onClick={exit}>
        {t('actAs.exit')}
      </Button>
    </div>
  );
};
