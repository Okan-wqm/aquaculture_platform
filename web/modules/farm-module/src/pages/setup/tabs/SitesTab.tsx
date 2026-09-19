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
  Spinner,
  Button,
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
import {
  Building2,
  MapPin,
  Maximize,
  Pencil,
  Plus,
  Search as SearchIcon,
  Trash2,
  User,
} from 'lucide-react';

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  INACTIVE: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
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
            className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <SearchIcon
            className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
        </div>
        {canCreateSite && (
          <Button variant="primary" onClick={handleCreate}>
            <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
            Add Site
          </Button>
        )}
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load sites. Please try again.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Sites Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSites.map((site) => (
            <div
              key={site.id}
              className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {site.name}
                      </h3>
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[site.status]}`}
                      >
                        {site.status}
                      </span>
                    </div>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{site.code}</p>
                  </div>
                  {(canUpdateSite || canDeleteSite) && (
                    <div className="flex items-center space-x-2">
                      {canUpdateSite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEdit(site)}
                          title="Edit"
                        >
                          <Pencil className="w-5 h-5" aria-hidden="true" />
                        </Button>
                      )}
                      {canDeleteSite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(site)}
                          title="Delete"
                        >
                          <Trash2 className="w-5 h-5" aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                    <MapPin
                      className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                      aria-hidden="true"
                    />
                    {site.region}, {site.country}
                  </div>
                  <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                    <Maximize
                      className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                      aria-hidden="true"
                    />
                    {site.totalArea?.toLocaleString()} m²
                  </div>
                  {site.contactEmail && (
                    <div className="flex items-center text-sm text-gray-600 dark:text-gray-400">
                      <User
                        className="w-4 h-4 mr-2 text-gray-400 dark:text-gray-500"
                        aria-hidden="true"
                      />
                      {site.contactEmail}
                    </div>
                  )}
                </div>
              </div>

              <div className="px-6 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-b-lg">
                <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
                  <span>Created: {new Date(site.createdAt).toLocaleDateString()}</span>
                  <Button variant="ghost" onClick={() => navigate(`/sites/${site.id}`)}>
                    View Details →
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSites.length === 0 && (
        <div className="text-center py-12">
          <Building2
            className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No sites found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {searchTerm
              ? 'Try adjusting your search terms.'
              : 'Get started by creating a new site.'}
          </p>
          {!searchTerm && canCreateSite && (
            <Button variant="primary" className="mt-4" onClick={handleCreate}>
              <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
              Add Site
            </Button>
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
