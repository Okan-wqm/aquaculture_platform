/**
 * SUPER_ADMIN tenant switcher (ORPHAN-HIGH-159) — the operator-facing half of the
 * tenant-context SSoT fix.
 *
 * A SUPER_ADMIN has no tenant in their token, so tenant-scoped panels never had a
 * deterministic active tenant (every hook is gated on `useAuth().tenantId`),
 * producing the "data sometimes loads, sometimes not" symptom. Selecting a tenant
 * here calls the auth `switchTenant` mutation, which re-mints a TENANT-SCOPED
 * token (validated SUPER_ADMIN + tenant-ACTIVE + audited server-side); storing it
 * and reloading makes EVERY federated remote re-initialise from the same token,
 * so the whole app resolves to one deterministic tenant with no cross-remote race.
 *
 * To return to platform scope, log out and back in (a dedicated "exit to
 * platform" re-mint is tracked under ORPHAN-HIGH-159).
 */
import { graphqlClient, setTokens, useAuthContext } from '@aquaculture/shared-ui';
import React, { useCallback, useEffect, useState } from 'react';

interface TenantOption {
  id: string;
  name: string;
  status: string;
}

const TENANTS_QUERY = `
  query SwitchableTenants {
    tenants {
      id
      name
      status
    }
  }
`;

const SWITCH_TENANT_MUTATION = `
  mutation SwitchTenant($tenantId: String!) {
    switchTenant(tenantId: $tenantId) {
      accessToken
    }
  }
`;

export const TenantSwitcher: React.FC = () => {
  const { user } = useAuthContext();
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [switching, setSwitching] = useState(false);

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  useEffect(() => {
    if (!isSuperAdmin) return undefined;
    let active = true;
    void graphqlClient
      .request<{ tenants: TenantOption[] }>(TENANTS_QUERY)
      .then((data) => {
        if (active) {
          setTenants(data.tenants.filter((t) => t.status === 'ACTIVE'));
        }
      })
      .catch(() => {
        // Non-fatal: the switcher simply shows no options.
      });
    return () => {
      active = false;
    };
  }, [isSuperAdmin]);

  const handleChange = useCallback(
    async (tenantId: string): Promise<void> => {
      if (!tenantId || switching) return;
      setSwitching(true);
      try {
        const result = await graphqlClient.request<{
          switchTenant: { accessToken: string };
        }>(SWITCH_TENANT_MUTATION, { tenantId });
        setTokens(result.switchTenant.accessToken);
        // Full reload so every federated remote re-initialises from the new
        // tenant-scoped token deterministically (no cross-remote tenant race).
        window.location.reload();
      } catch {
        setSwitching(false);
      }
    },
    [switching],
  );

  if (!isSuperAdmin) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="hidden text-gray-500 sm:inline">Tenant:</span>
      <select
        aria-label="Görüntülenen tenant"
        disabled={switching}
        value={user?.tenantId ?? ''}
        onChange={(e) => void handleChange(e.target.value)}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:border-primary-500 focus:outline-none disabled:opacity-50"
      >
        <option value="" disabled>
          Platform — tenant seçin
        </option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  );
};

export default TenantSwitcher;
