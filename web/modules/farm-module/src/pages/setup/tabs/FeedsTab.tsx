/**
 * Feeds Tab Component
 * Displays list of feeds with comprehensive feed management form
 */
import React, { useState, useMemo } from 'react';
import {
  useFeedList,
  useCreateFeed,
  useUpdateFeed,
  useDeleteFeed,
  useFeedTypes,
  calculateFeedingRate,
  Feed,
  FeedType,
  FeedStatus,
  FloatingType,
  CreateFeedInput,
  FeedingCurvePoint,
  EnvironmentalImpact,
  FeedDocument,
  NutritionalContent,
} from '../../../hooks/useFeeds';
import { useSupplierList } from '../../../hooks/useSuppliers';
import { useSiteList } from '../../../hooks/useSites';

const typeColors: Record<string, string> = {
  STARTER: 'bg-yellow-100 text-yellow-800',
  GROWER: 'bg-green-100 text-green-800',
  FINISHER: 'bg-blue-100 text-blue-800',
  BROODSTOCK: 'bg-purple-100 text-purple-800',
  MEDICATED: 'bg-red-100 text-red-800',
  LARVAL: 'bg-cyan-100 text-cyan-800',
  FRY: 'bg-orange-100 text-orange-800',
  OTHER: 'bg-gray-100 text-gray-800',
};

const typeLabels: Record<string, string> = {
  STARTER: 'Starter',
  GROWER: 'Grower',
  FINISHER: 'Finisher',
  BROODSTOCK: 'Broodstock',
  MEDICATED: 'Medicated',
  LARVAL: 'Larval',
  FRY: 'Fry',
  OTHER: 'Other',
};

const floatingTypeLabels: Record<string, string> = {
  FLOATING: 'Floating',
  SINKING: 'Sinking',
  SLOW_SINKING: 'Slow Sinking',
};

const statusLabels: Record<string, string> = {
  AVAILABLE: 'Available',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
  EXPIRED: 'Expired',
  DISCONTINUED: 'Discontinued',
};

const documentTypeLabels: Record<string, string> = {
  datasheet: 'Datasheet',
  certificate: 'Certificate',
  label: 'Label',
  analysis: 'Analysis',
  other: 'Other',
};

// Fallback feed types when API data is not available
const FALLBACK_FEED_TYPES = [
  { id: '1', code: 'HATCHERY', name: 'Hatchery', isActive: true, sortOrder: 1 },
  { id: '2', code: 'NURSERY', name: 'Nursery', isActive: true, sortOrder: 2 },
  { id: '3', code: 'GROWER', name: 'Grower', isActive: true, sortOrder: 3 },
  { id: '4', code: 'FINISHER', name: 'Finisher', isActive: true, sortOrder: 4 },
  { id: '5', code: 'BROODSTOCK', name: 'Broodstock', isActive: true, sortOrder: 5 },
  { id: '6', code: 'STARTER', name: 'Starter', isActive: true, sortOrder: 6 },
  { id: '7', code: 'MEDICATED', name: 'Medicated', isActive: true, sortOrder: 7 },
  { id: '8', code: 'LARVAL', name: 'Larval', isActive: true, sortOrder: 8 },
  { id: '9', code: 'FRY', name: 'Fry', isActive: true, sortOrder: 9 },
  { id: '10', code: 'OTHER', name: 'Other', isActive: true, sortOrder: 10 },
];

interface FeedFormData {
  // Temel Bilgiler
  name: string;
  code: string;
  type: string;
  siteId: string;
  supplierId: string;
  brand: string;
  manufacturer: string;

  // Pelet Bilgileri
  pelletSizeLabel: string;
  pelletSize: number | '';
  floatingType: string;
  productStage: string;

  // Besin Beyanı
  nutritionalContent: {
    crudeProtein: number | '';
    crudeFat: number | '';
    nfe: number | '';
    crudeAsh: number | '';
    crudeFiber: number | '';
    phosphorus: number | '';
    grossEnergy: number | '';
    digestibleEnergy: number | '';
  };

  // İçerik
  composition: string;

  // Besleme Eğrisi
  feedingCurve: FeedingCurvePoint[];

  // Çevresel Etki
  environmentalImpact: {
    co2EqWithLuc: number | '';
    co2EqWithoutLuc: number | '';
  };

  // Dokümanlar
  documents: FeedDocument[];

  // Fiyatlama
  unitPrice: number | '';
  unitSize: string;
  pricePerKg: number | '';

  // Ek Bilgiler
  notes: string;
  status: string;
}

const initialFormData: FeedFormData = {
  name: '',
  code: '',
  type: '',
  siteId: '',
  supplierId: '',
  brand: '',
  manufacturer: '',
  pelletSizeLabel: '',
  pelletSize: '',
  floatingType: 'FLOATING',
  productStage: '',
  nutritionalContent: {
    crudeProtein: '',
    crudeFat: '',
    nfe: '',
    crudeAsh: '',
    crudeFiber: '',
    phosphorus: '',
    grossEnergy: '',
    digestibleEnergy: '',
  },
  composition: '',
  feedingCurve: [],
  environmentalImpact: {
    co2EqWithLuc: '',
    co2EqWithoutLuc: '',
  },
  documents: [],
  unitPrice: '',
  unitSize: '',
  pricePerKg: '',
  notes: '',
  status: 'AVAILABLE',
};

// Collapsible Section Component
const CollapsibleSection: React.FC<{
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}> = ({ title, children, defaultOpen = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 rounded-lg mb-4">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 rounded-t-lg"
      >
        <span className="font-medium text-gray-700">{title}</span>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && <div className="p-4">{children}</div>}
    </div>
  );
};

export const FeedsTab: React.FC = () => {
  // API hooks
  const { data: feedsData, isLoading, error, refetch } = useFeedList();
  const { data: feedTypesData = [] } = useFeedTypes();
  // Use fallback feed types when API data is not available
  const feedTypes = feedTypesData.length > 0 ? feedTypesData : FALLBACK_FEED_TYPES;
  // Use all suppliers (not filtered by type) for broader selection
  const { data: suppliersData } = useSupplierList();
  const suppliers = suppliersData?.items || [];
  // Sites
  const { data: sitesData } = useSiteList();
  const sites = sitesData?.items || [];
  const createFeed = useCreateFeed();
  const updateFeed = useUpdateFeed();
  const deleteFeedMutation = useDeleteFeed();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [expandedFeed, setExpandedFeed] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FeedFormData>(initialFormData);
  const [calculatorWeight, setCalculatorWeight] = useState<number | ''>('');

  // Get feeds from API
  const feeds = feedsData?.items || [];

  const filteredFeeds = feeds.filter(feed => {
    const matchesSearch =
      feed.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      feed.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (feed.manufacturer?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    const matchesType = selectedType === 'all' || feed.type === selectedType;
    return matchesSearch && matchesType;
  });

  // Calculate feeding rate from curve
  const calculatedRate = useMemo(() => {
    if (!calculatorWeight || !formData.feedingCurve.length) return null;
    return calculateFeedingRate(Number(calculatorWeight), formData.feedingCurve);
  }, [calculatorWeight, formData.feedingCurve]);

  const toggleExpand = (feedId: string) => {
    setExpandedFeed(expandedFeed === feedId ? null : feedId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Build input object
    const input: CreateFeedInput = {
      name: formData.name,
      code: formData.code,
      type: formData.type.toUpperCase() as FeedType,
      siteId: formData.siteId,
      brand: formData.brand || undefined,
      manufacturer: formData.manufacturer || undefined,
      supplierId: formData.supplierId || undefined,
      pelletSizeLabel: formData.pelletSizeLabel || undefined,
      pelletSize: formData.pelletSize ? Number(formData.pelletSize) : undefined,
      floatingType: formData.floatingType as FloatingType,
      productStage: formData.productStage || undefined,
      composition: formData.composition || undefined,
      unitSize: formData.unitSize || undefined,
      unitPrice: formData.unitPrice ? Number(formData.unitPrice) : undefined,
      pricePerKg: formData.pricePerKg ? Number(formData.pricePerKg) : undefined,
      notes: formData.notes || undefined,
      status: formData.status as FeedStatus,
      nutritionalContent: {
        crudeProtein: formData.nutritionalContent.crudeProtein ? Number(formData.nutritionalContent.crudeProtein) : undefined,
        crudeFat: formData.nutritionalContent.crudeFat ? Number(formData.nutritionalContent.crudeFat) : undefined,
        nfe: formData.nutritionalContent.nfe ? Number(formData.nutritionalContent.nfe) : undefined,
        crudeAsh: formData.nutritionalContent.crudeAsh ? Number(formData.nutritionalContent.crudeAsh) : undefined,
        crudeFiber: formData.nutritionalContent.crudeFiber ? Number(formData.nutritionalContent.crudeFiber) : undefined,
        phosphorus: formData.nutritionalContent.phosphorus ? Number(formData.nutritionalContent.phosphorus) : undefined,
        grossEnergy: formData.nutritionalContent.grossEnergy ? Number(formData.nutritionalContent.grossEnergy) : undefined,
        digestibleEnergy: formData.nutritionalContent.digestibleEnergy ? Number(formData.nutritionalContent.digestibleEnergy) : undefined,
      },
      environmentalImpact: {
        co2EqWithLuc: formData.environmentalImpact.co2EqWithLuc ? Number(formData.environmentalImpact.co2EqWithLuc) : undefined,
        co2EqWithoutLuc: formData.environmentalImpact.co2EqWithoutLuc ? Number(formData.environmentalImpact.co2EqWithoutLuc) : undefined,
      },
      feedingCurve: formData.feedingCurve.length > 0 ? formData.feedingCurve : undefined,
      documents: formData.documents.length > 0 ? formData.documents : undefined,
    };

    try {
      if (editingId) {
        await updateFeed.mutateAsync({ id: editingId, ...input });
      } else {
        await createFeed.mutateAsync(input);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
      setCalculatorWeight('');
    } catch (err) {
      console.error('Failed to save feed:', err);
      alert('Failed to save feed. Please try again.');
    }
  };

  const handleEdit = (feed: Feed) => {
    setEditingId(feed.id);
    setFormData({
      name: feed.name,
      code: feed.code,
      type: feed.type,
      siteId: feed.siteId || '',
      supplierId: feed.supplierId || '',
      brand: feed.brand || '',
      manufacturer: feed.manufacturer || '',
      pelletSizeLabel: feed.pelletSizeLabel || '',
      pelletSize: feed.pelletSize || '',
      floatingType: feed.floatingType || 'FLOATING',
      productStage: feed.productStage || '',
      nutritionalContent: {
        crudeProtein: feed.nutritionalContent?.crudeProtein || '',
        crudeFat: feed.nutritionalContent?.crudeFat || '',
        nfe: feed.nutritionalContent?.nfe || '',
        crudeAsh: feed.nutritionalContent?.crudeAsh || '',
        crudeFiber: feed.nutritionalContent?.crudeFiber || '',
        phosphorus: feed.nutritionalContent?.phosphorus || '',
        grossEnergy: feed.nutritionalContent?.grossEnergy || '',
        digestibleEnergy: feed.nutritionalContent?.digestibleEnergy || '',
      },
      composition: feed.composition || '',
      feedingCurve: feed.feedingCurve || [],
      environmentalImpact: {
        co2EqWithLuc: feed.environmentalImpact?.co2EqWithLuc || '',
        co2EqWithoutLuc: feed.environmentalImpact?.co2EqWithoutLuc || '',
      },
      documents: feed.documents || [],
      unitPrice: feed.unitPrice || '',
      unitSize: feed.unitSize || '',
      pricePerKg: feed.pricePerKg || '',
      notes: feed.notes || '',
      status: feed.status || 'AVAILABLE',
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this feed?')) {
      try {
        await deleteFeedMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete feed:', err);
        alert('Failed to delete feed. Please try again.');
      }
    }
  };

  // Feeding curve handlers
  const addFeedingCurvePoint = () => {
    setFormData(prev => ({
      ...prev,
      feedingCurve: [...prev.feedingCurve, { fishWeightG: 0, feedingRatePercent: 0, fcr: 1 }],
    }));
  };

  const removeFeedingCurvePoint = (index: number) => {
    setFormData(prev => ({
      ...prev,
      feedingCurve: prev.feedingCurve.filter((_, i) => i !== index),
    }));
  };

  const updateFeedingCurvePoint = (index: number, field: keyof FeedingCurvePoint, value: number) => {
    setFormData(prev => ({
      ...prev,
      feedingCurve: prev.feedingCurve.map((point, i) =>
        i === index ? { ...point, [field]: value } : point
      ),
    }));
  };

  // Document handlers
  const addDocument = () => {
    setFormData(prev => ({
      ...prev,
      documents: [...prev.documents, { name: '', type: 'datasheet', url: '' }],
    }));
  };

  const removeDocument = (index: number) => {
    setFormData(prev => ({
      ...prev,
      documents: prev.documents.filter((_, i) => i !== index),
    }));
  };

  const updateDocument = (index: number, field: keyof FeedDocument, value: string) => {
    setFormData(prev => ({
      ...prev,
      documents: prev.documents.map((doc, i) =>
        i === index ? { ...doc, [field]: value } : doc
      ),
    }));
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search feeds..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Types</option>
            {feedTypes.map((type) => (
              <option key={type.id} value={type.code}>{type.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setFormData(initialFormData);
            setCalculatorWeight('');
            setIsModalOpen(true);
          }}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Feed
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
          <p className="text-red-600">Failed to load feeds. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Feeds List */}
      {!isLoading && !error && (
        <div className="space-y-4">
          {filteredFeeds.map((feed) => (
            <div key={feed.id} className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              {/* Feed Header */}
              <div
                className="p-6 cursor-pointer hover:bg-gray-50"
                onClick={() => toggleExpand(feed.id)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="w-12 h-12 bg-amber-100 rounded-lg flex items-center justify-center mr-4">
                      <svg className="w-6 h-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                      </svg>
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold text-gray-900">{feed.name}</h3>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeColors[feed.type] || 'bg-gray-100 text-gray-800'}`}>
                          {typeLabels[feed.type] || feed.type}
                        </span>
                      </div>
                      <p className="text-sm text-gray-500">{feed.code} {feed.manufacturer ? `| ${feed.manufacturer}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Pellet Size</p>
                      <p className="text-sm font-medium">{feed.pelletSizeLabel || (feed.pelletSize ? `${feed.pelletSize}mm` : '-')}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-gray-500">Price</p>
                      <p className="text-lg font-semibold text-green-600">{feed.pricePerKg?.toFixed(2) || feed.unitPrice?.toFixed(2) || '0.00'} TL</p>
                    </div>
                    <svg
                      className={`w-5 h-5 text-gray-400 transition-transform ${expandedFeed === feed.id ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Expanded Content */}
              {expandedFeed === feed.id && (
                <div className="border-t border-gray-200 bg-gray-50 p-6">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Nutritional Content */}
                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900 mb-4">Nutritional Content</h4>
                      <div className="space-y-3">
                        {feed.nutritionalContent ? (
                          <>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Protein</span>
                              <span className="font-medium">{feed.nutritionalContent.crudeProtein || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Fat</span>
                              <span className="font-medium">{feed.nutritionalContent.crudeFat || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">NFE</span>
                              <span className="font-medium">{feed.nutritionalContent.nfe || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Ash</span>
                              <span className="font-medium">{feed.nutritionalContent.crudeAsh || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Fiber</span>
                              <span className="font-medium">{feed.nutritionalContent.crudeFiber || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Phosphorus</span>
                              <span className="font-medium">{feed.nutritionalContent.phosphorus || '-'}%</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Gross Energy</span>
                              <span className="font-medium">{feed.nutritionalContent.grossEnergy || '-'} MJ</span>
                            </div>
                            <div className="flex justify-between text-sm">
                              <span className="text-gray-600">Digestible Energy</span>
                              <span className="font-medium">{feed.nutritionalContent.digestibleEnergy || '-'} MJ</span>
                            </div>
                          </>
                        ) : (
                          <p className="text-sm text-gray-500">No nutritional content available</p>
                        )}
                      </div>
                    </div>

                    {/* Feeding Curve */}
                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900 mb-4">Feeding Curve</h4>
                      {feed.feedingCurve && feed.feedingCurve.length > 0 ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-3 gap-2 text-xs font-medium text-gray-500 border-b pb-2">
                            <span>Weight (g)</span>
                            <span>Rate (%BW)</span>
                            <span>FCR</span>
                          </div>
                          {feed.feedingCurve.map((point, index) => (
                            <div key={index} className="grid grid-cols-3 gap-2 text-sm">
                              <span>{point.fishWeightG}</span>
                              <span>{point.feedingRatePercent}%</span>
                              <span>{point.fcr}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-gray-500">No feeding curve available</p>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="bg-white p-4 rounded-lg border border-gray-200">
                      <h4 className="text-sm font-semibold text-gray-900 mb-4">Actions</h4>
                      <div className="space-y-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEdit(feed); }}
                          className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                        >
                          Edit
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(feed.id); }}
                          className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredFeeds.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No feeds found</h3>
          <p className="mt-1 text-sm text-gray-500">Get started by adding a new feed.</p>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-start justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 w-full max-w-4xl">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-6 pt-5 pb-4 max-h-[80vh] overflow-y-auto">
                  <h3 className="text-lg font-medium text-gray-900 mb-6">
                    {editingId ? 'Edit Feed' : 'Add New Feed'}
                  </h3>

                  {/* Section 1: Basic Information */}
                  <CollapsibleSection title="Basic Information" defaultOpen={true}>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Feed Name *</label>
                        <input
                          type="text"
                          required
                          value={formData.name}
                          onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Code *</label>
                        <input
                          type="text"
                          required
                          value={formData.code}
                          onChange={e => setFormData(prev => ({ ...prev, code: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Category *</label>
                        <select
                          required
                          value={formData.type}
                          onChange={e => setFormData(prev => ({ ...prev, type: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select</option>
                          {feedTypes.map((type) => (
                            <option key={type.id} value={type.code}>{type.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Site *</label>
                        <select
                          required
                          value={formData.siteId}
                          onChange={e => setFormData(prev => ({ ...prev, siteId: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select Site</option>
                          {sites.map((site) => (
                            <option key={site.id} value={site.id}>{site.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Supplier</label>
                        <select
                          value={formData.supplierId}
                          onChange={e => setFormData(prev => ({ ...prev, supplierId: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select</option>
                          {suppliers.map((supplier) => (
                            <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Brand</label>
                        <input
                          type="text"
                          value={formData.brand}
                          onChange={e => setFormData(prev => ({ ...prev, brand: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Manufacturer</label>
                        <input
                          type="text"
                          value={formData.manufacturer}
                          onChange={e => setFormData(prev => ({ ...prev, manufacturer: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 2: Pellet Information */}
                  <CollapsibleSection title="Pellet Information">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Pellet Size Label</label>
                        <input
                          type="text"
                          placeholder="e.g. 2mm, 3-5mm"
                          value={formData.pelletSizeLabel}
                          onChange={e => setFormData(prev => ({ ...prev, pelletSizeLabel: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Pellet Diameter (mm)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.pelletSize}
                          onChange={e => setFormData(prev => ({ ...prev, pelletSize: e.target.value ? parseFloat(e.target.value) : '' }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Floating Type</label>
                        <select
                          value={formData.floatingType}
                          onChange={e => setFormData(prev => ({ ...prev, floatingType: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          {Object.entries(floatingTypeLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Product Stage</label>
                        <input
                          type="text"
                          value={formData.productStage}
                          onChange={e => setFormData(prev => ({ ...prev, productStage: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 3: Nutritional Declaration */}
                  <CollapsibleSection title="Nutritional Declaration">
                    <div className="grid grid-cols-4 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Crude Protein (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.crudeProtein}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, crudeProtein: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Crude Fat (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.crudeFat}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, crudeFat: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">NFE (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.nfe}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, nfe: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Ash (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.crudeAsh}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, crudeAsh: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Fiber (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.crudeFiber}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, crudeFiber: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Phosphorus (%)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          max="100"
                          value={formData.nutritionalContent.phosphorus}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, phosphorus: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Gross Energy (MJ)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.nutritionalContent.grossEnergy}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, grossEnergy: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Digestible Energy (MJ)</label>
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={formData.nutritionalContent.digestibleEnergy}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            nutritionalContent: { ...prev.nutritionalContent, digestibleEnergy: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 4: Composition */}
                  <CollapsibleSection title="Composition">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Raw Materials</label>
                      <textarea
                        rows={4}
                        placeholder="Fish meal, wheat flour, soybean meal..."
                        value={formData.composition}
                        onChange={e => setFormData(prev => ({ ...prev, composition: e.target.value }))}
                        className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </CollapsibleSection>

                  {/* Section 5: Feeding Curve */}
                  <CollapsibleSection title="Feeding Curve">
                    <div className="space-y-4">
                      {formData.feedingCurve.length > 0 && (
                        <div className="border rounded-lg overflow-hidden">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Fish Weight (g)</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">Feeding Rate (%BW)</th>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500">FCR</th>
                                <th className="px-4 py-2"></th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {formData.feedingCurve.map((point, index) => (
                                <tr key={index}>
                                  <td className="px-4 py-2">
                                    <input
                                      type="number"
                                      step="0.1"
                                      min="0"
                                      value={point.fishWeightG}
                                      onChange={e => updateFeedingCurvePoint(index, 'fishWeightG', parseFloat(e.target.value) || 0)}
                                      className="w-full border border-gray-300 rounded px-2 py-1"
                                    />
                                  </td>
                                  <td className="px-4 py-2">
                                    <input
                                      type="number"
                                      step="0.1"
                                      min="0"
                                      value={point.feedingRatePercent}
                                      onChange={e => updateFeedingCurvePoint(index, 'feedingRatePercent', parseFloat(e.target.value) || 0)}
                                      className="w-full border border-gray-300 rounded px-2 py-1"
                                    />
                                  </td>
                                  <td className="px-4 py-2">
                                    <input
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      value={point.fcr}
                                      onChange={e => updateFeedingCurvePoint(index, 'fcr', parseFloat(e.target.value) || 0)}
                                      className="w-full border border-gray-300 rounded px-2 py-1"
                                    />
                                  </td>
                                  <td className="px-4 py-2">
                                    <button
                                      type="button"
                                      onClick={() => removeFeedingCurvePoint(index)}
                                      className="text-red-600 hover:text-red-800"
                                    >
                                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                      </svg>
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={addFeedingCurvePoint}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        Add Point
                      </button>

                      {/* Calculator */}
                      {formData.feedingCurve.length > 0 && (
                        <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                          <h5 className="text-sm font-medium text-blue-800 mb-2">Feeding Rate Calculator</h5>
                          <div className="flex items-center gap-4">
                            <div className="flex-1">
                              <label className="block text-xs text-blue-700">Fish Weight (g)</label>
                              <input
                                type="number"
                                min="0"
                                value={calculatorWeight}
                                onChange={e => setCalculatorWeight(e.target.value ? parseFloat(e.target.value) : '')}
                                className="mt-1 block w-full border border-blue-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                              />
                            </div>
                            <div className="flex-1">
                              <label className="block text-xs text-blue-700">Estimated Feeding Rate</label>
                              <div className="mt-1 py-2 px-3 bg-white border border-blue-300 rounded-md">
                                {calculatedRate ? `${calculatedRate.feedingRate.toFixed(2)}% BW` : '-'}
                              </div>
                            </div>
                            <div className="flex-1">
                              <label className="block text-xs text-blue-700">Estimated FCR</label>
                              <div className="mt-1 py-2 px-3 bg-white border border-blue-300 rounded-md">
                                {calculatedRate ? calculatedRate.fcr.toFixed(2) : '-'}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </CollapsibleSection>

                  {/* Section 6: Environmental Impact */}
                  <CollapsibleSection title="Environmental Impact">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">CO2-eq with LUC (kg CO2/kg)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.environmentalImpact.co2EqWithLuc}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            environmentalImpact: { ...prev.environmentalImpact, co2EqWithLuc: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">CO2-eq without LUC (kg CO2/kg)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.environmentalImpact.co2EqWithoutLuc}
                          onChange={e => setFormData(prev => ({
                            ...prev,
                            environmentalImpact: { ...prev.environmentalImpact, co2EqWithoutLuc: e.target.value ? parseFloat(e.target.value) : '' }
                          }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 7: Documents */}
                  <CollapsibleSection title="Documents">
                    <div className="space-y-4">
                      {formData.documents.map((doc, index) => (
                        <div key={index} className="grid grid-cols-4 gap-4 p-4 border border-gray-200 rounded-lg">
                          <div>
                            <label className="block text-xs font-medium text-gray-500">Type</label>
                            <select
                              value={doc.type}
                              onChange={e => updateDocument(index, 'type', e.target.value)}
                              className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1 px-2 text-sm"
                            >
                              {Object.entries(documentTypeLabels).map(([value, label]) => (
                                <option key={value} value={value}>{label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500">Name</label>
                            <input
                              type="text"
                              value={doc.name}
                              onChange={e => updateDocument(index, 'name', e.target.value)}
                              className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1 px-2 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-500">URL</label>
                            <input
                              type="url"
                              value={doc.url}
                              onChange={e => updateDocument(index, 'url', e.target.value)}
                              className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-1 px-2 text-sm"
                            />
                          </div>
                          <div className="flex items-end">
                            <button
                              type="button"
                              onClick={() => removeDocument(index)}
                              className="text-red-600 hover:text-red-800"
                            >
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={addDocument}
                        className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                        </svg>
                        Add Document
                      </button>
                    </div>
                  </CollapsibleSection>

                  {/* Section 8: Pricing */}
                  <CollapsibleSection title="Pricing">
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Unit Price (TL)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.unitPrice}
                          onChange={e => setFormData(prev => ({ ...prev, unitPrice: e.target.value ? parseFloat(e.target.value) : '' }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Unit Size</label>
                        <input
                          type="text"
                          placeholder="e.g. 25kg bag"
                          value={formData.unitSize}
                          onChange={e => setFormData(prev => ({ ...prev, unitSize: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Price per Kg (TL)</label>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.pricePerKg}
                          onChange={e => setFormData(prev => ({ ...prev, pricePerKg: e.target.value ? parseFloat(e.target.value) : '' }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Section 9: Additional Information */}
                  <CollapsibleSection title="Additional Information">
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Notes</label>
                        <textarea
                          rows={3}
                          value={formData.notes}
                          onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Status</label>
                        <select
                          value={formData.status}
                          onChange={e => setFormData(prev => ({ ...prev, status: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          {Object.entries(statusLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>
                </div>

                <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
                  >
                    {editingId ? 'Update' : 'Save'}
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

export default FeedsTab;
