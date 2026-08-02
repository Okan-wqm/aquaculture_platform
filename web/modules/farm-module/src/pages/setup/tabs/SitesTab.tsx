/**
 * Sites Tab Component
 * Displays list of sites with CRUD operations
 */
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DeleteConfirmationDialog,
  DeletePreviewData,
  AffectedItemGroup,
  useCanMutate,
  useToast,
} from '@aquaculture/shared-ui';
import { SiteFormModal, type SiteFormData } from '../components/SiteFormModal';
import {
  useSiteList,
  useCreateSite,
  useUpdateSite,
  useDeleteSite,
  useSiteDeletePreview,
  Site,
  CreateSiteInput,
  UpdateSiteInput,
} from '../../../hooks/useSites';

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  INACTIVE: 'bg-gray-100 text-gray-800',
  CLOSED: 'bg-blue-100 text-blue-800',
};

const emptyToUndefined = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const emptyToNull = (value: string): string | null => {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

type SiteUpdateFields = Omit<UpdateSiteInput, 'id'>;

export function buildSiteMutationInput(
  formData: SiteFormData,
  includeClearedFields: false,
): CreateSiteInput;
export function buildSiteMutationInput(
  formData: SiteFormData,
  includeClearedFields: true,
): SiteUpdateFields;
export function buildSiteMutationInput(
  formData: SiteFormData,
  includeClearedFields: boolean,
): CreateSiteInput | SiteUpdateFields {
  if (typeof formData.monitoringRadiusM !== 'number') {
    throw new RangeError('A validated monitoring radius is required');
  }

  const common = {
    name: formData.name,
    code: formData.code,
    type: formData.type,
    status: formData.status,
    timezone: formData.timezone,
    monitoringRadiusM: formData.monitoringRadiusM,
  };

  const { latitude, longitude, altitude } = formData.location;
  const location =
    typeof latitude === 'number' && typeof longitude === 'number'
      ? {
          latitude,
          longitude,
          ...(typeof altitude === 'number' ? { altitude } : {}),
        }
      : null;
  const address = formData.address;
  const hasAddress =
    address.street.trim().length > 0 ||
    address.city.trim().length > 0 ||
    address.state.trim().length > 0 ||
    address.postalCode.trim().length > 0 ||
    formData.country.trim().length > 0;

  if (includeClearedFields) {
    const input: SiteUpdateFields = {
      ...common,
      lokalitetsnummer:
        typeof formData.lokalitetsnummer === 'number' ? formData.lokalitetsnummer : null,
      organisationNumberOverride: emptyToNull(formData.organisationNumberOverride),
      description: emptyToNull(formData.description),
      country: emptyToNull(formData.country),
      region: emptyToNull(formData.region),
      totalArea: typeof formData.totalArea === 'number' ? formData.totalArea : null,
      siteManager: emptyToNull(formData.siteManager),
      contactEmail: emptyToNull(formData.contactEmail),
      contactPhone: emptyToNull(formData.contactPhone),
      location,
      address: hasAddress
        ? {
            street: emptyToUndefined(address.street),
            city: emptyToUndefined(address.city),
            state: emptyToUndefined(address.state),
            postalCode: emptyToUndefined(address.postalCode),
            country: emptyToUndefined(formData.country),
          }
        : null,
      monitoringArea: formData.monitoringArea,
    };
    return input;
  }

  const input: CreateSiteInput = {
    ...common,
    lokalitetsnummer:
      typeof formData.lokalitetsnummer === 'number' ? formData.lokalitetsnummer : undefined,
    organisationNumberOverride: emptyToUndefined(formData.organisationNumberOverride),
    country: emptyToUndefined(formData.country),
    region: emptyToUndefined(formData.region),
    totalArea: typeof formData.totalArea === 'number' ? formData.totalArea : undefined,
    contactEmail: emptyToUndefined(formData.contactEmail),
    contactPhone: emptyToUndefined(formData.contactPhone),
    siteManager: emptyToUndefined(formData.siteManager),
    description: emptyToUndefined(formData.description),
  };
  if (location) {
    input.location = location;
  }
  if (hasAddress) {
    input.address = {
      street: emptyToUndefined(address.street),
      city: emptyToUndefined(address.city),
      state: emptyToUndefined(address.state),
      postalCode: emptyToUndefined(address.postalCode),
      country: emptyToUndefined(formData.country),
    };
  }
  if (formData.monitoringArea !== null) {
    input.monitoringArea = formData.monitoringArea;
  }

  return input;
}

export const SitesTab: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const canCreateSite = useCanMutate('createSite');
  const canUpdateSite = useCanMutate('updateSite');
  const canDeleteSite = useCanMutate('deleteSite');

  // API hooks
  const { data: sitesData, isLoading, error, refetch } = useSiteList();
  const createSite = useCreateSite();
  const updateSite = useUpdateSite();
  const deleteSiteMutation = useDeleteSite();

  // Local state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [siteToDelete, setSiteToDelete] = useState<Site | null>(null);

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useSiteDeletePreview(
    siteToDelete?.id ?? null,
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

    if (deletePreview.affectedItems.departments.length > 0) {
      affectedItems.push({
        type: 'departments',
        label: 'Departmanlar',
        items: deletePreview.affectedItems.departments.map((d) => ({
          id: d.id,
          name: d.name,
          code: d.code,
          status: `${d.equipmentCount} ekipman, ${d.tankCount} tank`,
        })),
      });
    }

    if (deletePreview.affectedItems.systems.length > 0) {
      affectedItems.push({
        type: 'systems',
        label: 'Sistemler',
        items: deletePreview.affectedItems.systems.map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          status: `${s.equipmentCount} ekipman`,
        })),
      });
    }

    if (deletePreview.affectedItems.equipment.length > 0) {
      affectedItems.push({
        type: 'equipment',
        label: 'Ekipmanlar',
        items: deletePreview.affectedItems.equipment.map((e) => ({
          id: e.id,
          name: e.name,
          code: e.code,
          status: e.status,
        })),
      });
    }

    if (deletePreview.affectedItems.tanks.length > 0) {
      affectedItems.push({
        type: 'tanks',
        label: 'Tanklar',
        items: deletePreview.affectedItems.tanks.map((t) => ({
          id: t.id,
          name: t.name,
          code: t.code,
          hasBlocker: t.hasActiveBiomass,
          blockerReason: t.hasActiveBiomass ? `${t.currentBiomass} kg biyokütle` : undefined,
        })),
      });
    }

    return {
      canDelete: deletePreview.canDelete,
      blockers: deletePreview.blockers,
      affectedItems,
      totalCount: deletePreview.affectedItems.totalCount,
    };
  }, [deletePreview]);

  // Get sites from API
  const sites = sitesData?.items || [];

  const filteredSites = sites.filter(
    (site) =>
      site.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      site.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (site.region?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false),
  );

  const handleCreate = () => {
    if (!canCreateSite) return;
    setEditingSite(null);
    setIsModalOpen(true);
  };

  const handleEdit = (site: Site) => {
    if (!canUpdateSite) return;
    setEditingSite(site);
    setIsModalOpen(true);
  };

  const handleDelete = (site: Site) => {
    if (!canDeleteSite) return;
    setSiteToDelete(site);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!siteToDelete || !canDeleteSite) return;
    try {
      await deleteSiteMutation.mutateAsync({ id: siteToDelete.id, cascade: true });
      setDeleteDialogOpen(false);
      setSiteToDelete(null);
    } catch {
      toast({
        title: 'Site could not be deleted',
        description: 'The server rejected the delete request. Please try again.',
        variant: 'error',
      });
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setSiteToDelete(null);
  };

  const handleSave = async (formData: SiteFormData) => {
    try {
      if (editingSite) {
        if (!canUpdateSite) return;
        const updateInput: UpdateSiteInput = {
          id: editingSite.id,
          ...buildSiteMutationInput(formData, true),
        };
        await updateSite.mutateAsync(updateInput);
      } else {
        if (!canCreateSite) return;
        await createSite.mutateAsync(buildSiteMutationInput(formData, false));
      }
      setIsModalOpen(false);
    } catch {
      toast({
        title: 'Site could not be saved',
        description: 'Review the site details and try again.',
        variant: 'error',
      });
    }
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            placeholder="Search sites..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <svg
            className="absolute left-3 top-2.5 w-5 h-5 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>
        {canCreateSite && (
          <button
            onClick={handleCreate}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
          >
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
              />
            </svg>
            Add Site
          </button>
        )}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load sites. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
        </div>
      )}

      {/* Sites Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSites.map((site) => (
            <div
              key={site.id}
              className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-gray-900">{site.name}</h3>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[site.status]}`}
                      >
                        {site.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 mt-1">{site.code}</p>
                  </div>
                  {(canUpdateSite || canDeleteSite) && (
                    <div className="flex items-center space-x-2">
                      {canUpdateSite && (
                        <button
                          onClick={() => handleEdit(site)}
                          className="p-1 text-gray-400 hover:text-blue-600 transition-colors"
                          title="Edit"
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                            />
                          </svg>
                        </button>
                      )}
                      {canDeleteSite && (
                        <button
                          onClick={() => handleDelete(site)}
                          className="p-1 text-gray-400 hover:text-red-600 transition-colors"
                          title="Delete"
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center text-sm text-gray-600">
                    <svg
                      className="w-4 h-4 mr-2 text-gray-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    {site.region}, {site.country}
                  </div>
                  <div className="flex items-center text-sm text-gray-600">
                    <svg
                      className="w-4 h-4 mr-2 text-gray-400"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"
                      />
                    </svg>
                    {site.totalArea?.toLocaleString()} m²
                  </div>
                  {site.contactEmail && (
                    <div className="flex items-center text-sm text-gray-600">
                      <svg
                        className="w-4 h-4 mr-2 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                        />
                      </svg>
                      {site.contactEmail}
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 rounded-b-lg">
                <div className="flex justify-between items-center text-xs text-gray-500">
                  <span>Created: {new Date(site.createdAt).toLocaleDateString()}</span>
                  <button
                    className="text-blue-600 hover:text-blue-800 font-medium"
                    onClick={() => navigate(`/sites/${site.id}`)}
                  >
                    View Details →
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSites.length === 0 && (
        <div className="text-center py-12">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No sites found</h3>
          <p className="mt-1 text-sm text-gray-500">
            {searchTerm
              ? 'Try adjusting your search terms.'
              : 'Get started by creating a new site.'}
          </p>
          {!searchTerm && canCreateSite && (
            <button
              onClick={handleCreate}
              className="mt-4 inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              Add Site
            </button>
          )}
        </div>
      )}

      {/* Modal */}
      <SiteFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSave}
        site={editingSite}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isOpen={deleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        onConfirm={handleConfirmDelete}
        title="Site Silme Onayı"
        entityName={siteToDelete?.name ?? ''}
        entityType="Site"
        preview={dialogPreview}
        isLoading={isPreviewLoading}
        isDeleting={deleteSiteMutation.isPending}
      />
    </div>
  );
};

export default SitesTab;
