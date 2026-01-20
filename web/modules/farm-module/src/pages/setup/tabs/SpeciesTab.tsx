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
import { useSupplierList } from '../../../hooks/useSuppliers';
import { useFeedList } from '../../../hooks/useFeeds';

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
  <div className="border border-gray-200 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-t-lg"
    >
      <span className="font-medium text-gray-700">{title}</span>
      <svg
        className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? 'transform rotate-180' : ''}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      </svg>
    </button>
    {isOpen && <div className="p-4 border-t border-gray-200">{children}</div>}
  </div>
);

export const SpeciesTab: React.FC = () => {
  // API hooks
  const { data: speciesData, isLoading, error, refetch } = useSpeciesList();
  const createSpecies = useCreateSpecies();
  const updateSpecies = useUpdateSpecies();
  const deleteSpeciesMutation = useDeleteSpecies();
  const { data: suppliersData } = useSupplierList({ type: 'fry' as any });
  const { data: feedsData } = useFeedList();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedWaterType, setSelectedWaterType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<SpeciesFormData>(initialFormData);

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
    setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Get data from API
  const speciesList = speciesData?.items || [];
  const suppliers = suppliersData?.items || [];
  const feeds = feedsData?.items || [];

  const filteredSpecies = speciesList.filter(species => {
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
        localName: formData.localName || undefined,
        description: formData.description || undefined,
        category: formData.category as SpeciesCategory,
        waterType: formData.waterType as SpeciesWaterType,
        family: formData.family || undefined,
        genus: formData.genus || undefined,
        supplierId: formData.supplierId || undefined,
        optimalConditions: Object.keys(optimalConditions).length > 0 ? optimalConditions : undefined,
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
      alert('Failed to save species. Please try again.');
    }
  };

  const handleEdit = (species: Species) => {
    setEditingId(species.id);
    setFormData({
      commonName: species.commonName,
      scientificName: species.scientificName,
      code: species.code,
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

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this species?')) {
      try {
        await deleteSpeciesMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete species:', err);
        alert('Failed to delete species. Please try again.');
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
    setFormData(prev => ({
      ...prev,
      tags: prev.tags.includes(tag)
        ? prev.tags.filter(t => t !== tag)
        : [...prev.tags, tag],
    }));
  };

  const handleAddCustomTag = () => {
    const tag = formData.customTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (tag && !formData.tags.includes(tag)) {
      setFormData(prev => ({
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
    setFormData(prev => ({
      ...prev,
      feedIds: prev.feedIds.includes(feedId)
        ? prev.feedIds.filter(id => id !== feedId)
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
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Categories</option>
            {Object.entries(speciesCategoryLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={selectedWaterType}
            onChange={(e) => setSelectedWaterType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Water Types</option>
            {Object.entries(speciesWaterTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Statuses</option>
            {Object.entries(speciesStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button
          onClick={openAddModal}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Species
        </button>
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
          <p className="text-red-600">Failed to load species. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Species Grid */}
      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredSpecies.map((species) => (
            <div key={species.id} className="bg-white rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow">
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">{species.commonName}</h3>
                    <p className="text-sm text-gray-500 italic">{species.scientificName}</p>
                    {species.localName && (
                      <p className="text-sm text-gray-400">({species.localName})</p>
                    )}
                    <p className="text-xs text-gray-400 mt-1">Code: {species.code}</p>
                  </div>
                  <div className="flex flex-col gap-1 items-end">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${speciesCategoryColors[species.category] || 'bg-gray-100 text-gray-800'}`}>
                      {speciesCategoryLabels[species.category] || species.category}
                    </span>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${waterTypeColors[species.waterType] || 'bg-gray-100 text-gray-800'}`}>
                      {speciesWaterTypeLabels[species.waterType] || species.waterType}
                    </span>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${speciesStatusColors[species.status] || 'bg-gray-100 text-gray-800'}`}>
                      {speciesStatusLabels[species.status] || species.status}
                    </span>
                  </div>
                </div>

                {/* Tags */}
                {species.tags && species.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-3">
                    {species.tags.map(tag => (
                      <span
                        key={tag}
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                          PREDEFINED_TAGS.includes(tag)
                            ? 'bg-blue-50 text-blue-700 border border-blue-200'
                            : 'bg-green-50 text-green-700 border border-green-200'
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Optimal Conditions Summary */}
                {species.optimalConditions && (
                  <div className="space-y-2 text-sm text-gray-600 border-t border-gray-100 pt-3 mt-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Optimal Conditions</p>

                    {species.optimalConditions.temperature && (
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                        </svg>
                        <span>Temp: {species.optimalConditions.temperature.min}-{species.optimalConditions.temperature.max}°C</span>
                      </div>
                    )}

                    {species.optimalConditions.ph && (
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                        </svg>
                        <span>pH: {species.optimalConditions.ph.min}-{species.optimalConditions.ph.max}</span>
                      </div>
                    )}

                    {species.optimalConditions.dissolvedOxygen && (
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                        </svg>
                        <span>O2: min {species.optimalConditions.dissolvedOxygen.min} mg/L</span>
                      </div>
                    )}

                    {species.optimalConditions.co2 && (
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                        <span>CO2: {species.optimalConditions.co2.min}-{species.optimalConditions.co2.max} mg/L</span>
                      </div>
                    )}

                    {species.optimalConditions.lightRegime && (
                      <div className="flex items-center">
                        <svg className="w-4 h-4 mr-2 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                        </svg>
                        <span>Light: {species.optimalConditions.lightRegime.lightHours}h / Dark: {species.optimalConditions.lightRegime.darkHours}h</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Description */}
                {species.description && (
                  <p className="text-sm text-gray-500 mt-3 line-clamp-2">{species.description}</p>
                )}
              </div>

              <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500">
                  {species.family && species.genus ? `${species.family} / ${species.genus}` : species.family || species.genus || ''}
                </span>
                <div className="flex space-x-2">
                  <button onClick={() => handleEdit(species)} className="text-blue-600 hover:text-blue-800 text-sm font-medium">Edit</button>
                  <button onClick={() => handleDelete(species.id)} className="text-red-600 hover:text-red-800 text-sm font-medium">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredSpecies.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No species found</h3>
          <p className="mt-1 text-sm text-gray-500">Add your first species to get started.</p>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:max-w-3xl sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Species' : 'Add Species'}
                  </h3>

                  {/* Section 1: Basic Info */}
                  <CollapsibleSection
                    title="Basic Information"
                    isOpen={openSections.basic}
                    onToggle={() => toggleSection('basic')}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Common Name *</label>
                        <input
                          type="text"
                          required
                          value={formData.commonName}
                          onChange={e => setFormData(prev => ({ ...prev, commonName: e.target.value }))}
                          placeholder="e.g., European Seabass"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Scientific Name *</label>
                        <input
                          type="text"
                          required
                          value={formData.scientificName}
                          onChange={e => setFormData(prev => ({ ...prev, scientificName: e.target.value }))}
                          placeholder="e.g., Dicentrarchus labrax"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 italic"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Code *</label>
                        <input
                          type="text"
                          required
                          value={formData.code}
                          onChange={e => setFormData(prev => ({ ...prev, code: e.target.value.toUpperCase() }))}
                          placeholder="e.g., SEABASS"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 uppercase"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Local Name</label>
                        <input
                          type="text"
                          value={formData.localName}
                          onChange={e => setFormData(prev => ({ ...prev, localName: e.target.value }))}
                          placeholder="e.g., Levrek"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">Description</label>
                      <textarea
                        value={formData.description}
                        onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                        rows={2}
                        placeholder="Brief description of the species..."
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </CollapsibleSection>

                  {/* Section: Tags */}
                  <CollapsibleSection
                    title="Tags"
                    isOpen={openSections.tags}
                    onToggle={() => toggleSection('tags')}
                  >
                    <div>
                      <p className="text-sm text-gray-500 mb-3">Select tags to categorize this species for filtering and reporting</p>

                      {/* Predefined Tags */}
                      <div className="flex flex-wrap gap-2 mb-4">
                        {PREDEFINED_TAGS.map(tag => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => handleTagToggle(tag)}
                            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                              formData.tags.includes(tag)
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                            }`}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>

                      {/* Custom Tag Input */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={formData.customTag}
                          onChange={e => setFormData(prev => ({ ...prev, customTag: e.target.value }))}
                          onKeyDown={handleCustomTagKeyDown}
                          placeholder="Add custom tag..."
                          className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                        <button
                          type="button"
                          onClick={handleAddCustomTag}
                          disabled={!formData.customTag.trim()}
                          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Add
                        </button>
                      </div>

                      {/* Selected Custom Tags (non-predefined) */}
                      {formData.tags.filter(t => !PREDEFINED_TAGS.includes(t)).length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs text-gray-500 mb-2">Custom tags:</p>
                          <div className="flex flex-wrap gap-2">
                            {formData.tags
                              .filter(t => !PREDEFINED_TAGS.includes(t))
                              .map(tag => (
                                <span
                                  key={tag}
                                  className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-green-100 text-green-700"
                                >
                                  {tag}
                                  <button
                                    type="button"
                                    onClick={() => handleTagToggle(tag)}
                                    className="ml-2 text-green-500 hover:text-green-700"
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                          </div>
                        </div>
                      )}

                      {formData.tags.length > 0 && (
                        <p className="mt-3 text-xs text-gray-500">{formData.tags.length} tag(s) selected</p>
                      )}
                    </div>
                  </CollapsibleSection>

                  {/* Section 2: Classification */}
                  <CollapsibleSection
                    title="Classification"
                    isOpen={openSections.classification}
                    onToggle={() => toggleSection('classification')}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Category *</label>
                        <select
                          required
                          value={formData.category}
                          onChange={e => setFormData(prev => ({ ...prev, category: e.target.value as SpeciesCategory }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select Category</option>
                          {Object.entries(speciesCategoryLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Water Type *</label>
                        <select
                          required
                          value={formData.waterType}
                          onChange={e => setFormData(prev => ({ ...prev, waterType: e.target.value as SpeciesWaterType }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select Water Type</option>
                          {Object.entries(speciesWaterTypeLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Family</label>
                        <input
                          type="text"
                          value={formData.family}
                          onChange={e => setFormData(prev => ({ ...prev, family: e.target.value }))}
                          placeholder="e.g., Moronidae"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Genus</label>
                        <input
                          type="text"
                          value={formData.genus}
                          onChange={e => setFormData(prev => ({ ...prev, genus: e.target.value }))}
                          placeholder="e.g., Dicentrarchus"
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 3: Supplier */}
                  <CollapsibleSection
                    title="Supplier (Fry/Egg Source)"
                    isOpen={openSections.supplier}
                    onToggle={() => toggleSection('supplier')}
                  >
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Supplier</label>
                      <select
                        value={formData.supplierId}
                        onChange={e => setFormData(prev => ({ ...prev, supplierId: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      >
                        <option value="">Select Supplier (Optional)</option>
                        {suppliers.map(supplier => (
                          <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-gray-500">Optional: Select the primary supplier for fry/eggs of this species</p>
                    </div>
                  </CollapsibleSection>

                  {/* Section 4: Optimal Conditions */}
                  <CollapsibleSection
                    title="Optimal Water Conditions"
                    isOpen={openSections.optimalConditions}
                    onToggle={() => toggleSection('optimalConditions')}
                  >
                    {/* Temperature */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Temperature (°C)</label>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Min</label>
                          <input
                            type="number"
                            step="0.1"
                            value={formData.tempMin}
                            onChange={e => setFormData(prev => ({ ...prev, tempMin: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="18"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Max</label>
                          <input
                            type="number"
                            step="0.1"
                            value={formData.tempMax}
                            onChange={e => setFormData(prev => ({ ...prev, tempMax: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="28"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Optimal</label>
                          <input
                            type="number"
                            step="0.1"
                            value={formData.tempOptimal}
                            onChange={e => setFormData(prev => ({ ...prev, tempOptimal: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="24"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* pH */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">pH</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Min</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="14"
                            value={formData.phMin}
                            onChange={e => setFormData(prev => ({ ...prev, phMin: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="7.0"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Max</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            max="14"
                            value={formData.phMax}
                            onChange={e => setFormData(prev => ({ ...prev, phMax: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="8.5"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Dissolved Oxygen */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Dissolved Oxygen (mg/L)</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Min</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={formData.oxygenMin}
                            onChange={e => setFormData(prev => ({ ...prev, oxygenMin: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="5.0"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Optimal</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={formData.oxygenOptimal}
                            onChange={e => setFormData(prev => ({ ...prev, oxygenOptimal: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="7.0"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Ammonia */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Ammonia (mg/L)</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Max Tolerable</label>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={formData.ammoniaMax}
                            onChange={e => setFormData(prev => ({ ...prev, ammoniaMax: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="0.02"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* CO2 */}
                    <div className="mb-4">
                      <label className="block text-sm font-medium text-gray-700 mb-2">CO2 (mg/L)</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Min</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={formData.co2Min}
                            onChange={e => setFormData(prev => ({ ...prev, co2Min: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="0"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Max</label>
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={formData.co2Max}
                            onChange={e => setFormData(prev => ({ ...prev, co2Max: e.target.value === '' ? '' : Number(e.target.value) }))}
                            placeholder="20"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Light Regime */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Light Regime (hours/day)</label>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs text-gray-500">Light Hours</label>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="24"
                            value={formData.lightHours}
                            onChange={e => {
                              const light = e.target.value === '' ? '' : Number(e.target.value);
                              const dark = light !== '' ? 24 - light : '';
                              setFormData(prev => ({ ...prev, lightHours: light, darkHours: dark }));
                            }}
                            placeholder="14"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Dark Hours</label>
                          <input
                            type="number"
                            step="0.5"
                            min="0"
                            max="24"
                            value={formData.darkHours}
                            onChange={e => {
                              const dark = e.target.value === '' ? '' : Number(e.target.value);
                              const light = dark !== '' ? 24 - dark : '';
                              setFormData(prev => ({ ...prev, darkHours: dark, lightHours: light }));
                            }}
                            placeholder="10"
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">Light + Dark hours should equal 24</p>
                    </div>
                  </CollapsibleSection>

                  {/* Section 5: Feeds */}
                  <CollapsibleSection
                    title="Compatible Feeds"
                    isOpen={openSections.feeds}
                    onToggle={() => toggleSection('feeds')}
                  >
                    <div>
                      <p className="text-sm text-gray-500 mb-3">Select feeds that are suitable for this species</p>
                      <div className="max-h-60 overflow-y-auto border border-gray-200 rounded-md p-2">
                        {feeds.length === 0 ? (
                          <p className="text-sm text-gray-400 text-center py-4">No feeds available. Add feeds in the Feeds tab first.</p>
                        ) : (
                          <div className="space-y-2">
                            {feeds.map(feed => (
                              <label key={feed.id} className="flex items-center p-2 hover:bg-gray-50 rounded cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={formData.feedIds.includes(feed.id)}
                                  onChange={() => handleFeedToggle(feed.id)}
                                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                                />
                                <span className="ml-3 text-sm text-gray-700">{feed.name}</span>
                                <span className="ml-2 text-xs text-gray-400">({feed.code})</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                      {formData.feedIds.length > 0 && (
                        <p className="mt-2 text-xs text-gray-500">{formData.feedIds.length} feed(s) selected</p>
                      )}
                    </div>
                  </CollapsibleSection>

                  {/* Section 6: Status & Notes */}
                  <CollapsibleSection
                    title="Status & Notes"
                    isOpen={openSections.status}
                    onToggle={() => toggleSection('status')}
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Status</label>
                        <select
                          value={formData.status}
                          onChange={e => setFormData(prev => ({ ...prev, status: e.target.value as SpeciesStatus }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          {Object.entries(speciesStatusLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="mt-4">
                      <label className="block text-sm font-medium text-gray-700">Notes</label>
                      <textarea
                        value={formData.notes}
                        onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                        rows={3}
                        placeholder="Additional notes about this species..."
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </CollapsibleSection>
                </div>

                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={createSpecies.isPending || updateSpecies.isPending}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
                  >
                    {(createSpecies.isPending || updateSpecies.isPending) && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    )}
                    {editingId ? 'Update' : 'Create'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SpeciesTab;
