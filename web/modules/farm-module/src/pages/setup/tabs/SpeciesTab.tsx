/**
 * Species Tab Component
 * Complete species management with CRUD operations
 * Manages aquaculture species with optimal conditions, supplier, and feed relationships
 */
import React, { useState } from 'react';
import {
  useSpeciesList,
  useCreateSpecies,
  useUpdateSpecies,
  useDeleteSpecies,
  Species,
  SpeciesCategory,
  SpeciesWaterType,
  SpeciesStatus,
  CreateSpeciesInput,
  OptimalConditions,
  speciesCategoryLabels,
  speciesWaterTypeLabels,
  speciesStatusLabels,
  speciesStatusColors,
  speciesCategoryColors,
  waterTypeColors,
} from '../../../hooks/useSpecies';
// ARCH-NOTE: Always use SupplierType enum, never hardcode string values. GraphQL enums are case-sensitive.
import { useSupplierList, SupplierType } from '../../../hooks/useSuppliers';
import { useFeedList } from '../../../hooks/useFeeds';
import {
  Button,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  ToggleButton,
  useConfirm,
} from '@aquaculture/shared-ui';
import {
  Box,
  ChartColumn,
  ChevronDown,
  CircleX,
  Monitor,
  Plus,
  Search as SearchIcon,
  Sun,
  SwatchBook,
  X,
} from 'lucide-react';

// Predefined species tags
const PREDEFINED_TAGS = [
  'smolt',
  'cleaner-fish',
  'broodstock',
  'fry',
  'fingerling',
  'grower',
  'market-size',
  'organic',
  'certified',
];

interface SpeciesFormData {
  // Basic Info
  commonName: string;
  scientificName: string;
  code: string;
  officialCode: string;
  localName: string;
  description: string;
  // Tags
  tags: string[];
  customTag: string;
  // Classification
  category: SpeciesCategory | '';
  waterType: SpeciesWaterType | '';
  family: string;
  genus: string;
  // Supplier
  supplierId: string;
  // Optimal Conditions
  tempMin: number | '';
  tempMax: number | '';
  tempOptimal: number | '';
  phMin: number | '';
  phMax: number | '';
  oxygenMin: number | '';
  oxygenOptimal: number | '';
  ammoniaMax: number | '';
  co2Min: number | '';
  co2Max: number | '';
  lightHours: number | '';
  darkHours: number | '';
  // Feeds
  feedIds: string[];
  // Status
  status: SpeciesStatus;
  notes: string;
}

const initialFormData: SpeciesFormData = {
  commonName: '',
  scientificName: '',
  code: '',
  officialCode: '',
  localName: '',
  description: '',
  tags: [],
  customTag: '',
  category: '',
  waterType: '',
  family: '',
  genus: '',
  supplierId: '',
  tempMin: '',
  tempMax: '',
  tempOptimal: '',
  phMin: '',
  phMax: '',
  oxygenMin: '',
  oxygenOptimal: '',
  ammoniaMax: '',
  co2Min: '',
  co2Max: '',
  lightHours: '',
  darkHours: '',
  feedIds: [],
  status: SpeciesStatus.ACTIVE,
  notes: '',
};

// Collapsible Section Component
const CollapsibleSection: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, isOpen, onToggle, children }) => (
  <div className="border border-gray-200 dark:border-gray-700 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg"
    >
      <span className="font-medium text-gray-700 dark:text-gray-300">{title}</span>
      <ChevronDown
        className={`w-5 h-5 text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'transform rotate-180' : ''}`}
        aria-hidden="true"
      />
    </button>
    {isOpen && <div className="p-4 border-t border-gray-200 dark:border-gray-700">{children}</div>}
  </div>
);

/**
 * Server-side page size for the species list. The backend caps a single page at
 * 100 (SpeciesFilterInput @Max), which comfortably covers a setup catalog; if a
 * tenant ever exceeds it the banner below discloses the truncation rather than
 * silently dropping rows (the old default-20 bug, where >20 species vanished).
 */
const SPECIES_LIST_LIMIT = 100;

export const SpeciesTab: React.FC = () => {
  // API hooks
  const {
    data: speciesData,
    isLoading,
    error,
    refetch,
  } = useSpeciesList({ limit: SPECIES_LIST_LIMIT });
  const createSpecies = useCreateSpecies();
  const updateSpecies = useUpdateSpecies();
  const deleteSpeciesMutation = useDeleteSpecies();
  // BUG-08: Show all active suppliers (FRY + OTHER types) instead of only FRY
  // Suppliers may be categorized as FRY, FEED, EQUIPMENT, etc. but fry/egg
  // sources are not always typed as FRY. Remove type filter to show all.
  const { data: suppliersData } = useSupplierList();
  const { data: feedsData } = useFeedList();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedWaterType, setSelectedWaterType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<SpeciesFormData>(initialFormData);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Collapsible sections state
  const [openSections, setOpenSections] = useState({
    basic: true,
    tags: true,
    classification: true,
    supplier: false,
    optimalConditions: true,
    feeds: false,
    status: false,
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Get data from API
  const speciesList = speciesData?.items || [];
  const suppliers = suppliersData?.items || [];
  const feeds = feedsData?.items || [];

  const filteredSpecies = speciesList.filter((species) => {
    const matchesSearch =
      species.commonName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      species.scientificName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      species.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (species.localName?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    const matchesCategory = selectedCategory === 'all' || species.category === selectedCategory;
    const matchesWaterType = selectedWaterType === 'all' || species.waterType === selectedWaterType;
    const matchesStatus = selectedStatus === 'all' || species.status === selectedStatus;
    return matchesSearch && matchesCategory && matchesWaterType && matchesStatus;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    try {
      // Build optimal conditions object
      const optimalConditions: OptimalConditions = {};

      if (formData.tempMin !== '' || formData.tempMax !== '') {
        optimalConditions.temperature = {
          min: Number(formData.tempMin) || 0,
          max: Number(formData.tempMax) || 0,
          optimal: formData.tempOptimal !== '' ? Number(formData.tempOptimal) : undefined,
          unit: 'celsius',
        };
      }

      if (formData.phMin !== '' || formData.phMax !== '') {
        optimalConditions.ph = {
          min: Number(formData.phMin) || 0,
          max: Number(formData.phMax) || 14,
        };
      }

      if (formData.oxygenMin !== '' || formData.oxygenOptimal !== '') {
        optimalConditions.dissolvedOxygen = {
          min: Number(formData.oxygenMin) || 0,
          optimal: Number(formData.oxygenOptimal) || 0,
          unit: 'mg/L',
        };
      }

      if (formData.ammoniaMax !== '') {
        optimalConditions.ammonia = {
          max: Number(formData.ammoniaMax),
        };
      }

      if (formData.co2Min !== '' || formData.co2Max !== '') {
        optimalConditions.co2 = {
          min: Number(formData.co2Min) || 0,
          max: Number(formData.co2Max) || 0,
        };
      }

      if (formData.lightHours !== '' || formData.darkHours !== '') {
        optimalConditions.lightRegime = {
          lightHours: Number(formData.lightHours) || 0,
          darkHours: Number(formData.darkHours) || 0,
        };
      }

      const input: CreateSpeciesInput = {
        commonName: formData.commonName,
        scientificName: formData.scientificName,
        code: formData.code,
        officialCode: formData.officialCode || undefined,
        localName: formData.localName || undefined,
        description: formData.description || undefined,
        category: formData.category as SpeciesCategory,
        waterType: formData.waterType as SpeciesWaterType,
        family: formData.family || undefined,
        genus: formData.genus || undefined,
        supplierId: formData.supplierId || undefined,
        optimalConditions:
          Object.keys(optimalConditions).length > 0 ? optimalConditions : undefined,
        feedIds: formData.feedIds.length > 0 ? formData.feedIds : undefined,
        tags: formData.tags.length > 0 ? formData.tags : undefined,
        status: formData.status,
        notes: formData.notes || undefined,
      };

      if (editingId) {
        await updateSpecies.mutateAsync({
          id: editingId,
          ...input,
        });
      } else {
        await createSpecies.mutateAsync(input);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save species:', err);
      const message =
        err instanceof Error ? err.message : 'Failed to save species. Please try again.';
      setFormError(message);
    }
  };

  const handleEdit = (species: Species) => {
    setEditingId(species.id);
    setFormData({
      commonName: species.commonName,
      scientificName: species.scientificName,
      code: species.code,
      officialCode: species.officialCode || '',
      localName: species.localName || '',
      description: species.description || '',
      tags: species.tags || [],
      customTag: '',
      category: species.category,
      waterType: species.waterType,
      family: species.family || '',
      genus: species.genus || '',
      supplierId: species.supplierId || '',
      tempMin: species.optimalConditions?.temperature?.min ?? '',
      tempMax: species.optimalConditions?.temperature?.max ?? '',
      tempOptimal: species.optimalConditions?.temperature?.optimal ?? '',
      phMin: species.optimalConditions?.ph?.min ?? '',
      phMax: species.optimalConditions?.ph?.max ?? '',
      oxygenMin: species.optimalConditions?.dissolvedOxygen?.min ?? '',
      oxygenOptimal: species.optimalConditions?.dissolvedOxygen?.optimal ?? '',
      ammoniaMax: species.optimalConditions?.ammonia?.max ?? '',
      co2Min: species.optimalConditions?.co2?.min ?? '',
      co2Max: species.optimalConditions?.co2?.max ?? '',
      lightHours: species.optimalConditions?.lightRegime?.lightHours ?? '',
      darkHours: species.optimalConditions?.lightRegime?.darkHours ?? '',
      feedIds: [], // TODO: Load from species-feed relationships
      status: species.status,
      notes: species.notes || '',
    });
    // Open all sections when editing
    setOpenSections({
      basic: true,
      tags: true,
      classification: true,
      supplier: true,
      optimalConditions: true,
      feeds: true,
      status: true,
    });
    setIsModalOpen(true);
  };

  const confirm = useConfirm();
  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Delete this species?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
      setDeleteError(null);
      try {
        await deleteSpeciesMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete species:', err);
        const message =
          err instanceof Error ? err.message : 'Failed to delete species. Please try again.';
        setDeleteError(message);
      }
    }
  };

  const openAddModal = () => {
    setEditingId(null);
    setFormData(initialFormData);
    setOpenSections({
      basic: true,
      tags: true,
      classification: true,
      supplier: false,
      optimalConditions: true,
      feeds: false,
      status: false,
    });
    setIsModalOpen(true);
  };

  // Tag handling functions
  const handleTagToggle = (tag: string) => {
    setFormData((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag],
    }));
  };

  const handleAddCustomTag = () => {
    const tag = formData.customTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !formData.tags.includes(tag)) {
      setFormData((prev) => ({
        ...prev,
        tags: [...prev.tags, tag],
        customTag: '',
      }));
    }
  };

  const handleCustomTagKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddCustomTag();
    }
  };

  const handleFeedToggle = (feedId: string) => {
    setFormData((prev) => ({
      ...prev,
      feedIds: prev.feedIds.includes(feedId)
        ? prev.feedIds.filter((id) => id !== feedId)
        : [...prev.feedIds, feedId],
    }));
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder="Search species..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent"
            />
            <SearchIcon
              className="absolute left-3 top-2.5 w-5 h-5 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
          </div>
          <Select
            aria-label="Category filter"
            fullWidth={false}
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            options={[
              { value: 'all', label: 'All Categories' },
              ...Object.entries(speciesCategoryLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            aria-label="Water type filter"
            fullWidth={false}
            value={selectedWaterType}
            onChange={(e) => setSelectedWaterType(e.target.value)}
            options={[
              { value: 'all', label: 'All Water Types' },
              ...Object.entries(speciesWaterTypeLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
          <Select
            aria-label="Status filter"
            fullWidth={false}
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            options={[
              { value: 'all', label: 'All Statuses' },
              ...Object.entries(speciesStatusLabels).map(([value, label]) => ({ value, label })),
            ]}
          />
        </div>
        <Button variant="primary" onClick={openAddModal}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Species
        </Button>
      </div>

      {/* Loading State */}
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12 bg-error-50 dark:bg-error-900/20 rounded-lg border border-error-200 dark:border-error-800">
          <p className="text-error-600 dark:text-error-400">
            Failed to load species. Please try again.
          </p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* WHY: the species list previously used the server's default limit:20, so a
          tenant with >20 species silently lost the rest after a refetch/focus. We
          now request an explicit page (SPECIES_LIST_LIMIT); when MORE exist, disclose
          it instead of silently truncating. */}
      {!isLoading && !error && speciesData?.hasNextPage && (
        <div className="mb-6 px-4 py-3 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg text-sm text-warning-800 dark:text-warning-200">
          Showing the first {SPECIES_LIST_LIMIT} species; this catalog has more.
        </div>
      )}

      {/* Species Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSpecies.map((species) => (
            <div
              key={species.id}
              className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow"
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {species.commonName}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      {species.scientificName}
                    </p>
                    {species.localName && (
                      <p className="text-sm text-gray-400 dark:text-gray-500">
                        ({species.localName})
                      </p>
                    )}
                    <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                      Code: {species.code}
                      {species.officialCode ? ` · Artskode: ${species.officialCode}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${speciesCategoryColors[species.category] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {speciesCategoryLabels[species.category] || species.category}
                    </span>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${waterTypeColors[species.waterType] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {speciesWaterTypeLabels[species.waterType] || species.waterType}
                    </span>
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${speciesStatusColors[species.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                    >
                      {speciesStatusLabels[species.status] || species.status}
                    </span>
                  </div>
                </div>

                {/* Tags */}
                {species.tags && species.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-3">
                    {species.tags.map((tag) => (
                      <span
                        key={tag}
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          PREDEFINED_TAGS.includes(tag)
                            ? 'bg-info-50 dark:bg-info-900/20 text-info-700 dark:text-info-300 border border-info-200 dark:border-info-800'
                            : 'bg-success-50 dark:bg-success-900/20 text-success-700 dark:text-success-300 border border-success-200 dark:border-success-800'
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Optimal Conditions Summary */}
                {species.optimalConditions && (
                  <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400 border-t border-gray-100 dark:border-gray-700 pt-3 mt-3">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-2">
                      Optimal Conditions
                    </p>

                    {species.optimalConditions.temperature && (
                      <div className="flex items-center">
                        <ChartColumn className="w-4 h-4 mr-2 text-accent-500" aria-hidden="true" />
                        <span>
                          Temp: {species.optimalConditions.temperature.min}-
                          {species.optimalConditions.temperature.max}°C
                        </span>
                      </div>
                    )}

                    {species.optimalConditions.ph && (
                      <div className="flex items-center">
                        <SwatchBook className="w-4 h-4 mr-2 text-accent-500" aria-hidden="true" />
                        <span>
                          pH: {species.optimalConditions.ph.min}-{species.optimalConditions.ph.max}
                        </span>
                      </div>
                    )}

                    {species.optimalConditions.dissolvedOxygen && (
                      <div className="flex items-center">
                        <Box className="w-4 h-4 mr-2 text-info-500" aria-hidden="true" />
                        <span>O2: min {species.optimalConditions.dissolvedOxygen.min} mg/L</span>
                      </div>
                    )}

                    {species.optimalConditions.co2 && (
                      <div className="flex items-center">
                        <Monitor className="w-4 h-4 mr-2 text-success-500" aria-hidden="true" />
                        <span>
                          CO2: {species.optimalConditions.co2.min}-
                          {species.optimalConditions.co2.max} mg/L
                        </span>
                      </div>
                    )}

                    {species.optimalConditions.lightRegime && (
                      <div className="flex items-center">
                        <Sun className="w-4 h-4 mr-2 text-warning-500" aria-hidden="true" />
                        <span>
                          Light: {species.optimalConditions.lightRegime.lightHours}h / Dark:{' '}
                          {species.optimalConditions.lightRegime.darkHours}h
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {/* Description */}
                {species.description && (
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-3 line-clamp-2">
                    {species.description}
                  </p>
                )}
              </div>

              <div className="px-6 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {species.family && species.genus
                    ? `${species.family} / ${species.genus}`
                    : species.family || species.genus || ''}
                </span>
                <div className="flex space-x-2">
                  <Button variant="ghost" onClick={() => handleEdit(species)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => handleDelete(species.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Error */}
      {deleteError && (
        <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-md">
          <div className="flex items-center justify-between">
            <div className="flex">
              <CircleX className="h-5 w-5 text-error-400 mr-2 flex-shrink-0" aria-hidden="true" />
              <p className="text-sm text-error-700 dark:text-error-300">{deleteError}</p>
            </div>
            <Button variant="ghost" type="button" onClick={() => setDeleteError(null)}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSpecies.length === 0 && (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <Box className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500" aria-hidden="true" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No species found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Add your first species to get started.
          </p>
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Species' : 'Add Species'}
        size="xl"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            {formError && (
              <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-md">
                <div className="flex">
                  <CircleX
                    className="h-5 w-5 text-error-400 mr-2 flex-shrink-0"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-error-700 dark:text-error-300">{formError}</p>
                </div>
              </div>
            )}

            {/* Section 1: Basic Info */}
            <CollapsibleSection
              title="Basic Information"
              isOpen={openSections.basic}
              onToggle={() => toggleSection('basic')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Common Name"
                  fullWidth
                  type="text"
                  required
                  value={formData.commonName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, commonName: e.target.value }))}
                  placeholder="e.g., European Seabass"
                />
                <Input
                  label="Scientific Name"
                  fullWidth
                  type="text"
                  required
                  value={formData.scientificName}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, scientificName: e.target.value }))
                  }
                  placeholder="e.g., Dicentrarchus labrax"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <Input
                  label="Code"
                  className="uppercase"
                  fullWidth
                  type="text"
                  required
                  value={formData.code}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))
                  }
                  placeholder="e.g., SEABASS"
                />
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Official Code (artskode)
                  </label>
                  <Input
                    className="uppercase"
                    fullWidth
                    type="text"
                    value={formData.officialCode}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        officialCode: e.target.value.toUpperCase(),
                      }))
                    }
                    placeholder="e.g., SAL (FAO 3-alpha / USB-BER-GRO-BNB)"
                    maxLength={16}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Required for Norwegian regulatory reports — submissions fail closed without it.
                  </p>
                </div>
                <Input
                  label="Local Name"
                  fullWidth
                  type="text"
                  value={formData.localName}
                  onChange={(e) => setFormData((prev) => ({ ...prev, localName: e.target.value }))}
                  placeholder="e.g., Levrek"
                />
              </div>
              <Textarea
                label="Description"
                className="mt-4"
                fullWidth
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                rows={2}
                placeholder="Brief description of the species..."
              />
            </CollapsibleSection>

            {/* Section: Tags */}
            <CollapsibleSection
              title="Tags"
              isOpen={openSections.tags}
              onToggle={() => toggleSection('tags')}
            >
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  Select tags to categorize this species for filtering and reporting
                </p>

                {/* Predefined Tags */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {PREDEFINED_TAGS.map((tag) => (
                    <ToggleButton
                      key={tag}
                      type="button"
                      onClick={() => handleTagToggle(tag)}
                      pressed={formData.tags.includes(tag)}
                      className="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
                      pressedClassName="bg-info-500 text-white"
                      idleClassName="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
                    >
                      {tag}
                    </ToggleButton>
                  ))}
                </div>

                {/* Custom Tag Input */}
                <div className="flex gap-2">
                  <Input
                    type="text"
                    value={formData.customTag}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, customTag: e.target.value }))
                    }
                    onKeyDown={handleCustomTagKeyDown}
                    placeholder="Add custom tag..."
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomTag}
                    disabled={!formData.customTag.trim()}
                    className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                </div>

                {/* Selected Custom Tags (non-predefined) */}
                {formData.tags.filter((t) => !PREDEFINED_TAGS.includes(t)).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Custom tags:</p>
                    <div className="flex flex-wrap gap-2">
                      {formData.tags
                        .filter((t) => !PREDEFINED_TAGS.includes(t))
                        .map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300"
                          >
                            {tag}
                            <Button
                              variant="ghost"
                              className="ml-2"
                              type="button"
                              onClick={() => handleTagToggle(tag)}
                            >
                              ×
                            </Button>
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                {formData.tags.length > 0 && (
                  <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    {formData.tags.length} tag(s) selected
                  </p>
                )}
              </div>
            </CollapsibleSection>

            {/* Section 2: Classification */}
            <CollapsibleSection
              title="Classification"
              isOpen={openSections.classification}
              onToggle={() => toggleSection('classification')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label="Category"
                  required
                  placeholder="Select Category"
                  value={formData.category}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      category: e.target.value as SpeciesCategory,
                    }))
                  }
                  options={Object.entries(speciesCategoryLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                <Select
                  label="Water Type"
                  required
                  placeholder="Select Water Type"
                  value={formData.waterType}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      waterType: e.target.value as SpeciesWaterType,
                    }))
                  }
                  options={Object.entries(speciesWaterTypeLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                <Input
                  label="Family"
                  fullWidth
                  type="text"
                  value={formData.family}
                  onChange={(e) => setFormData((prev) => ({ ...prev, family: e.target.value }))}
                  placeholder="e.g., Moronidae"
                />
                <Input
                  label="Genus"
                  fullWidth
                  type="text"
                  value={formData.genus}
                  onChange={(e) => setFormData((prev) => ({ ...prev, genus: e.target.value }))}
                  placeholder="e.g., Dicentrarchus"
                />
              </div>
            </CollapsibleSection>

            {/* Section 3: Supplier */}
            <CollapsibleSection
              title="Supplier (Fry/Egg Source)"
              isOpen={openSections.supplier}
              onToggle={() => toggleSection('supplier')}
            >
              <Select
                label="Supplier"
                value={formData.supplierId}
                onChange={(e) => setFormData((prev) => ({ ...prev, supplierId: e.target.value }))}
                helperText="Optional: Select the primary supplier for fry/eggs of this species"
                options={[
                  { value: '', label: 'Select Supplier (Optional)' },
                  ...suppliers.map((supplier) => ({ value: supplier.id, label: supplier.name })),
                ]}
              />
            </CollapsibleSection>

            {/* Section 4: Optimal Conditions */}
            <CollapsibleSection
              title="Optimal Water Conditions"
              isOpen={openSections.optimalConditions}
              onToggle={() => toggleSection('optimalConditions')}
            >
              {/* Temperature */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Temperature (°C)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <Input
                    label="Min"
                    fullWidth
                    type="number"
                    step="0.1"
                    value={formData.tempMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        tempMin: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="18"
                  />
                  <Input
                    label="Max"
                    fullWidth
                    type="number"
                    step="0.1"
                    value={formData.tempMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        tempMax: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="28"
                  />
                  <Input
                    label="Optimal"
                    fullWidth
                    type="number"
                    step="0.1"
                    value={formData.tempOptimal}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        tempOptimal: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="24"
                  />
                </div>
              </div>

              {/* pH */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  pH
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Min"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    max="14"
                    value={formData.phMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        phMin: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="7.0"
                  />
                  <Input
                    label="Max"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    max="14"
                    value={formData.phMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        phMax: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="8.5"
                  />
                </div>
              </div>

              {/* Dissolved Oxygen */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Dissolved Oxygen (mg/L)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Min"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    value={formData.oxygenMin}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        oxygenMin: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="5.0"
                  />
                  <Input
                    label="Optimal"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    value={formData.oxygenOptimal}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        oxygenOptimal: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="7.0"
                  />
                </div>
              </div>

              {/* Ammonia */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Ammonia (mg/L)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Max Tolerable"
                    fullWidth
                    type="number"
                    step="0.01"
                    min="0"
                    value={formData.ammoniaMax}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        ammoniaMax: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="0.02"
                  />
                </div>
              </div>

              {/* CO2 */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  CO2 (mg/L)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Min"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    value={formData.co2Min}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        co2Min: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="0"
                  />
                  <Input
                    label="Max"
                    fullWidth
                    type="number"
                    step="0.1"
                    min="0"
                    value={formData.co2Max}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        co2Max: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder="20"
                  />
                </div>
              </div>

              {/* Light Regime */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Light Regime (hours/day)
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Input
                    label="Light Hours"
                    fullWidth
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={formData.lightHours}
                    onChange={(e) => {
                      const light = e.target.value === '' ? '' : Number(e.target.value);
                      const dark = light !== '' ? 24 - light : '';
                      setFormData((prev) => ({ ...prev, lightHours: light, darkHours: dark }));
                    }}
                    placeholder="14"
                  />
                  <Input
                    label="Dark Hours"
                    fullWidth
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={formData.darkHours}
                    onChange={(e) => {
                      const dark = e.target.value === '' ? '' : Number(e.target.value);
                      const light = dark !== '' ? 24 - dark : '';
                      setFormData((prev) => ({ ...prev, darkHours: dark, lightHours: light }));
                    }}
                    placeholder="10"
                  />
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Light + Dark hours should equal 24
                </p>
              </div>
            </CollapsibleSection>

            {/* Section 5: Feeds */}
            <CollapsibleSection
              title="Compatible Feeds"
              isOpen={openSections.feeds}
              onToggle={() => toggleSection('feeds')}
            >
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                  Select feeds that are suitable for this species
                </p>
                <div className="max-h-60 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-md p-2">
                  {feeds.length === 0 ? (
                    <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
                      No feeds available. Add feeds in the Feeds tab first.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {feeds.map((feed) => (
                        <label
                          key={feed.id}
                          className="flex items-center p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={formData.feedIds.includes(feed.id)}
                            onChange={() => handleFeedToggle(feed.id)}
                            className="h-4 w-4 text-info-600 focus:ring-info-500 border-gray-300 dark:border-gray-600 rounded"
                          />
                          <span className="ml-3 text-sm text-gray-700 dark:text-gray-300">
                            {feed.name}
                          </span>
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            ({feed.code})
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {formData.feedIds.length > 0 && (
                  <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                    {formData.feedIds.length} feed(s) selected
                  </p>
                )}
              </div>
            </CollapsibleSection>

            {/* Section 6: Status & Notes */}
            <CollapsibleSection
              title="Status & Notes"
              isOpen={openSections.status}
              onToggle={() => toggleSection('status')}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label="Status"
                  value={formData.status}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, status: e.target.value as SpeciesStatus }))
                  }
                  options={Object.entries(speciesStatusLabels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
              </div>
              <Textarea
                label="Notes"
                className="mt-4"
                fullWidth
                value={formData.notes}
                onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Additional notes about this species..."
              />
            </CollapsibleSection>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 sm:flex sm:flex-row-reverse">
            <Button
              variant="primary"
              size="lg"
              className="justify-center sm:ml-3 sm:w-auto sm:text-sm"
              type="submit"
              disabled={createSpecies.isPending || updateSpecies.isPending}
            >
              {(createSpecies.isPending || updateSpecies.isPending) && (
                <Spinner size="sm" color="white" className="-ml-1 mr-2" />
              )}
              {editingId ? 'Update' : 'Create'}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="mt-3 justify-center sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
              type="button"
              onClick={() => setIsModalOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default SpeciesTab;
