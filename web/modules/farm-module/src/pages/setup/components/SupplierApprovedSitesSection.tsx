/**
 * SupplierApprovedSitesSection — frontend surface for
 * setSupplierApprovedSites (Scope A 4.4.2).
 *
 * Symmetric to SiteContactsSection (PR #155). Embedded inside the
 * supplier edit form (SuppliersTab) when editing an existing
 * supplier; renders an explanatory placeholder in CREATE mode
 * because the mutation requires a `supplierId`.
 *
 * UI shape: a multi-select checklist of all active sites in the
 * tenant, with a single "preferred" radio across the selected
 * subset. Set semantics — submit replaces the full approved list
 * with the current checkbox state. Empty selection = "clear all
 * approvals" (the backend treats this as a valid command).
 *
 * Architectural rationale — same as SiteContactsSection:
 *   - Standalone "Save" button distinct from the supplier form's
 *     main submit. Folding into the form would require either
 *     backend createSupplier/updateSupplier to gain inline
 *     `approvedSiteIds[]` (Phase 4.4.2 follow-up note, out of
 *     this PR's scope) OR two sequential mutations with manual
 *     rollback.
 *   - Preferred site MUST be a member of the selected set — the
 *     handler rejects orphan preferences. UI mirrors this by
 *     auto-clearing the preferred flag when its site is
 *     unchecked.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  formatErrorForToast,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';

import {
  useSetSupplierApprovedSites,
  useSupplierSites,
} from '../../../hooks/useSuppliers';
import { useSiteList } from '../../../hooks/useSites';

interface SupplierApprovedSitesSectionProps {
  /**
   * The supplier whose approvals are being edited. Undefined in
   * CREATE mode → component renders a placeholder.
   */
  supplierId: string | undefined;
}

const SupplierApprovedSitesSection: React.FC<SupplierApprovedSitesSectionProps> = ({
  supplierId,
}) => {
  const { toast } = useToast();
  const canEdit = useCanMutate('setSupplierApprovedSites');

  // Fetch all active sites in the tenant — checkbox source.
  const sitesQuery = useSiteList({ isActive: true });
  // Fetch existing approvals — checkbox initial state.
  const approvalsQuery = useSupplierSites(supplierId);
  const setApprovalsMutation = useSetSupplierApprovedSites();

  const [selectedSiteIds, setSelectedSiteIds] = useState<Set<string>>(new Set());
  const [preferredSiteId, setPreferredSiteId] = useState<string | null>(null);

  // Sync local checkbox state from server data when the modal
  // re-opens against a different supplier OR the server data
  // refetches. The operator's pending edits are NOT preserved
  // across server-data resets — close+reopen is the "discard"
  // contract.
  useEffect(() => {
    if (approvalsQuery.data) {
      const ids = new Set(approvalsQuery.data.map((a) => a.siteId));
      setSelectedSiteIds(ids);
      const preferred = approvalsQuery.data.find((a) => a.isPreferred);
      setPreferredSiteId(preferred?.siteId ?? null);
    }
  }, [approvalsQuery.data, supplierId]);

  const allSites = useMemo(
    () => sitesQuery.data?.items ?? [],
    [sitesQuery.data],
  );

  if (!supplierId) {
    return (
      <div className="mt-6 p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg">
        <h3 className="text-sm font-semibold text-gray-700">Onaylı Siteler</h3>
        <p className="mt-1 text-xs text-gray-500">
          Tedarikçi oluşturulduktan sonra onaylı site listesi
          düzenlenebilir. Önce yukarıdaki "Kaydet" butonu ile
          tedarikçiyi oluşturun.
        </p>
      </div>
    );
  }

  if (!canEdit) {
    // Read-only render for users without edit permission.
    return (
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-gray-700">Onaylı Siteler</h3>
        {approvalsQuery.isLoading ? (
          <p className="mt-1 text-xs text-gray-500">Yükleniyor…</p>
        ) : (approvalsQuery.data ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-gray-500">Onaylı site yok.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {(approvalsQuery.data ?? []).map((a) => {
              const site = allSites.find((s) => s.id === a.siteId);
              return (
                <li key={a.id}>
                  <span className="font-medium">
                    {site?.name ?? a.siteId}
                  </span>
                  {site?.code && (
                    <span className="text-gray-500"> · {site.code}</span>
                  )}
                  {a.isPreferred && (
                    <span className="ml-2 px-1.5 py-0.5 text-xs bg-blue-100 text-blue-700 rounded">
                      Tercih edilen
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  const handleToggle = (siteId: string) => {
    setSelectedSiteIds((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) {
        next.delete(siteId);
        // Auto-clear preferred when its site is deselected — the
        // backend rejects orphan preferences before the transaction
        // starts, so we mirror that gate at the UI level.
        if (preferredSiteId === siteId) {
          setPreferredSiteId(null);
        }
      } else {
        next.add(siteId);
      }
      return next;
    });
  };

  const handleSetPreferred = (siteId: string | null) => {
    if (siteId === null) {
      setPreferredSiteId(null);
      return;
    }
    if (!selectedSiteIds.has(siteId)) {
      // Defense in depth: shouldn't be reachable through the UI
      // (the radio is rendered next to checked rows only) but if
      // a future change exposes it, refuse the orphan-preferred state.
      return;
    }
    setPreferredSiteId(siteId);
  };

  const handleSubmit = async () => {
    if (setApprovalsMutation.isPending) return;
    try {
      await setApprovalsMutation.mutateAsync({
        supplierId,
        siteIds: Array.from(selectedSiteIds),
        preferredSiteId,
      });
      toast({
        title: 'Onaylı siteler güncellendi',
        description: `${selectedSiteIds.size} site kayıtlı.`,
        variant: 'success',
      });
    } catch (err) {
      toast({
        title: 'Onay listesi kaydedilemedi',
        description: formatErrorForToast(err),
        variant: 'error',
      });
    }
  };

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Onaylı Siteler</h3>
        <p className="text-xs text-gray-500">
          {selectedSiteIds.size} / {allSites.length} site seçili
        </p>
      </div>
      <p className="mt-1 text-xs text-gray-500">
        Bu tedarikçinin teslimat yapabileceği siteler. En fazla bir
        site "tercih edilen" olarak işaretlenebilir.
      </p>

      {sitesQuery.isLoading || approvalsQuery.isLoading ? (
        <p className="mt-3 text-sm text-gray-500">Yükleniyor…</p>
      ) : allSites.length === 0 ? (
        <div className="mt-3 p-3 bg-gray-50 border border-dashed border-gray-300 rounded text-sm text-gray-500 text-center">
          Aktif site yok. Önce Sites sekmesinden bir site oluşturun.
        </div>
      ) : (
        <div className="mt-3 max-h-64 overflow-y-auto border border-gray-200 rounded">
          <ul className="divide-y divide-gray-200">
            {allSites.map((site) => {
              const checked = selectedSiteIds.has(site.id);
              const isPreferred = preferredSiteId === site.id;
              return (
                <li
                  key={site.id}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToggle(site.id)}
                    className="h-4 w-4"
                    id={`approved-site-${site.id}`}
                  />
                  <label
                    htmlFor={`approved-site-${site.id}`}
                    className="flex-1 cursor-pointer"
                  >
                    <span className="font-medium text-gray-900">
                      {site.name}
                    </span>
                    {site.code && (
                      <span className="ml-2 text-xs text-gray-500">
                        {site.code}
                      </span>
                    )}
                  </label>
                  {checked && (
                    <label className="flex items-center gap-1 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="radio"
                        name="preferredSupplierSite"
                        checked={isPreferred}
                        onChange={() => handleSetPreferred(site.id)}
                        className="h-3 w-3"
                      />
                      Tercih
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => handleSetPreferred(null)}
          disabled={preferredSiteId === null}
          className="text-xs text-gray-600 hover:text-gray-800 disabled:opacity-40"
        >
          Tercihten kaldır
        </button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={setApprovalsMutation.isPending}
          isLoading={setApprovalsMutation.isPending}
        >
          Onayları Kaydet
        </Button>
      </div>
    </div>
  );
};

export default SupplierApprovedSitesSection;
