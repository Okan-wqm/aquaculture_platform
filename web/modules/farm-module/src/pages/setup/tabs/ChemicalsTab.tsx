/**
 * Chemicals Tab Component
 * Professional chemical management with CRUD, document upload, and multi-site assignment
 */
import React, { useState, useRef } from 'react';
import {
  useChemicalList,
  useCreateChemical,
  useUpdateChemical,
  useDeleteChemical,
  useChemicalTypes,
  useUploadChemicalDocument,
  useRemoveChemicalDocument,
  Chemical,
  ChemicalType,
  ChemicalStatus,
  ChemicalDocumentType,
  ChemicalDocument,
  CreateChemicalInput,
} from '../../../hooks/useChemicals';
import { useSupplierList, Supplier } from '../../../hooks/useSuppliers';
import { useSiteList, Site } from '../../../hooks/useSites';

// ============================================================================
// CONSTANTS
// ============================================================================

const categoryColors: Record<string, string> = {
  TREATMENT: 'bg-blue-100 text-blue-800',
  DISINFECTANT: 'bg-green-100 text-green-800',
  ANTIBIOTIC: 'bg-red-100 text-red-800',
  VITAMIN: 'bg-yellow-100 text-yellow-800',
  MINERAL: 'bg-purple-100 text-purple-800',
  WATER_CONDITIONER: 'bg-cyan-100 text-cyan-800',
  PROBIOTIC: 'bg-indigo-100 text-indigo-800',
  ANTIPARASITIC: 'bg-orange-100 text-orange-800',
  ANESTHETIC: 'bg-pink-100 text-pink-800',
  pH_ADJUSTER: 'bg-teal-100 text-teal-800',
  ALGAECIDE: 'bg-lime-100 text-lime-800',
  OTHER: 'bg-gray-100 text-gray-800',
};

const categoryLabels: Record<string, string> = {
  TREATMENT: 'Treatment',
  DISINFECTANT: 'Disinfectant',
  ANTIBIOTIC: 'Antibiotic',
  VITAMIN: 'Vitamin',
  MINERAL: 'Mineral',
  WATER_CONDITIONER: 'Water Conditioner',
  PROBIOTIC: 'Probiotic',
  ANTIPARASITIC: 'Antiparasitic',
  ANESTHETIC: 'Anesthetic',
  pH_ADJUSTER: 'pH Adjuster',
  ALGAECIDE: 'Algaecide',
  OTHER: 'Other',
};

const statusColors: Record<string, string> = {
  AVAILABLE: 'bg-green-100 text-green-800',
  LOW_STOCK: 'bg-yellow-100 text-yellow-800',
  OUT_OF_STOCK: 'bg-red-100 text-red-800',
  EXPIRED: 'bg-gray-100 text-gray-800',
  DISCONTINUED: 'bg-gray-100 text-gray-800',
};

const statusLabels: Record<string, string> = {
  AVAILABLE: 'Available',
  LOW_STOCK: 'Low Stock',
  OUT_OF_STOCK: 'Out of Stock',
  EXPIRED: 'Expired',
  DISCONTINUED: 'Discontinued',
};

const documentTypeLabels: Record<ChemicalDocumentType, string> = {
  [ChemicalDocumentType.MSDS]: 'MSDS',
  [ChemicalDocumentType.LABEL]: 'Label',
  [ChemicalDocumentType.PROTOCOL]: 'Protocol',
  [ChemicalDocumentType.CERTIFICATE]: 'Certificate',
  [ChemicalDocumentType.OTHER]: 'Other',
};

const storageOptions = [
  { value: 'room_temperature', label: 'Room Temperature' },
  { value: 'refrigerated', label: 'Refrigerated' },
  { value: 'cool_dark', label: 'Cool & Dark' },
  { value: 'hazmat', label: 'Hazmat Storage' },
];

// Fallback categories when API data is not available
const FALLBACK_CHEMICAL_CATEGORIES = [
  { id: '1', code: 'TREATMENT', name: 'Treatment', isActive: true, sortOrder: 1 },
  { id: '2', code: 'DISINFECTANT', name: 'Disinfectant', isActive: true, sortOrder: 2 },
  { id: '3', code: 'ANTIBIOTIC', name: 'Antibiotic', isActive: true, sortOrder: 3 },
  { id: '4', code: 'VITAMIN', name: 'Vitamin', isActive: true, sortOrder: 4 },
  { id: '5', code: 'MINERAL', name: 'Mineral', isActive: true, sortOrder: 5 },
  { id: '6', code: 'WATER_CONDITIONER', name: 'Water Conditioner', isActive: true, sortOrder: 6 },
  { id: '7', code: 'PROBIOTIC', name: 'Probiotic', isActive: true, sortOrder: 7 },
  { id: '8', code: 'ANTIPARASITIC', name: 'Antiparasitic', isActive: true, sortOrder: 8 },
  { id: '9', code: 'ANESTHETIC', name: 'Anesthetic', isActive: true, sortOrder: 9 },
  { id: '10', code: 'pH_ADJUSTER', name: 'pH Adjuster', isActive: true, sortOrder: 10 },
  { id: '11', code: 'ALGAECIDE', name: 'Algaecide', isActive: true, sortOrder: 11 },
  { id: '12', code: 'OTHER', name: 'Other', isActive: true, sortOrder: 12 },
];

// ============================================================================
// TYPES
// ============================================================================

interface ChemicalFormData {
  // Basic Info
  name: string;
  code: string;
  type: ChemicalType | '';
  supplierId: string;
  description: string;
  // Composition
  activeIngredient: string;
  concentration: string;
  formulation: string;
  // Storage & Safety
  storageRequirements: string;
  hazardClass: string;
  signalWord: string;
  msdsUrl: string;
  // Usage
  withdrawalPeriodDays: number;
  usageGuideUrl: string;
  // Status
  status: ChemicalStatus;
  // Notes
  notes: string;
  // Site (required - single site for backward compatibility)
  siteId: string;
  // Sites (multiple sites support)
  siteIds: string[];
  // Unit (required)
  unit: string;
}

const initialFormData: ChemicalFormData = {
  name: '',
  code: '',
  type: '',
  supplierId: '',
  description: '',
  activeIngredient: '',
  concentration: '',
  formulation: '',
  storageRequirements: 'room_temperature',
  hazardClass: '',
  signalWord: '',
  msdsUrl: '',
  withdrawalPeriodDays: 0,
  usageGuideUrl: '',
  status: ChemicalStatus.AVAILABLE,
  notes: '',
  siteId: '',
  siteIds: [],
  unit: 'liter',
};

// ============================================================================
// COLLAPSIBLE SECTION COMPONENT
// ============================================================================

const CollapsibleSection: React.FC<{
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  optional?: boolean;
}> = ({ title, isOpen, onToggle, children, optional }) => (
  <div className="border border-gray-200 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 rounded-t-lg"
    >
      <span className="font-medium text-gray-700">
        {title}
        {optional && <span className="ml-2 text-xs text-gray-400">(Optional)</span>}
      </span>
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

// ============================================================================
// SITE MULTI-SELECT COMPONENT
// ============================================================================

const SiteMultiSelect: React.FC<{
  sites: Site[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}> = ({ sites, selectedIds, onChange }) => {
  const toggleSite = (siteId: string) => {
    if (selectedIds.includes(siteId)) {
      onChange(selectedIds.filter(id => id !== siteId));
    } else {
      onChange([...selectedIds, siteId]);
    }
  };

  return (
    <div className="space-y-2">
      {sites.length === 0 ? (
        <p className="text-sm text-gray-500">No sites available</p>
      ) : (
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-gray-200 rounded-lg p-2">
          {sites.map((site) => (
            <label
              key={site.id}
              className="flex items-center p-2 rounded hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(site.id)}
                onChange={() => toggleSite(site.id)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <span className="ml-2 text-sm text-gray-700">{site.name}</span>
            </label>
          ))}
        </div>
      )}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {selectedIds.map((id) => {
            const site = sites.find(s => s.id === id);
            return site ? (
              <span
                key={id}
                className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-800"
              >
                {site.name}
                <button
                  type="button"
                  onClick={() => toggleSite(id)}
                  className="ml-1 hover:text-blue-900"
                >
                  &times;
                </button>
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// DOCUMENT SECTION COMPONENT
// ============================================================================

const DocumentsSection: React.FC<{
  chemicalId?: string;
  documents: ChemicalDocument[];
  onUpload: (file: File, name: string, type: ChemicalDocumentType) => Promise<void>;
  onDelete: (doc: ChemicalDocument) => Promise<void>;
  isUploading: boolean;
}> = ({ chemicalId, documents, onUpload, onDelete, isUploading }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadName, setUploadName] = useState('');
  const [uploadType, setUploadType] = useState<ChemicalDocumentType>(ChemicalDocumentType.MSDS);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      if (!uploadName) {
        setUploadName(file.name.replace(/\.[^/.]+$/, ''));
      }
    }
  };

  const handleUpload = async () => {
    if (selectedFile && uploadName) {
      await onUpload(selectedFile, uploadName, uploadType);
      setSelectedFile(null);
      setUploadName('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  if (!chemicalId) {
    return (
      <p className="text-sm text-gray-500 italic">
        Save the chemical first to upload documents
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Upload Form */}
      <div className="flex flex-col gap-3 p-3 bg-gray-50 rounded-lg">
        <div className="flex gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            onChange={handleFileSelect}
            className="flex-1 text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>
        {selectedFile && (
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 mb-1">Document Name</label>
              <input
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="Enter document name"
                className="w-full border border-gray-300 rounded-md py-1.5 px-3 text-sm"
              />
            </div>
            <div className="w-40">
              <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
              <select
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value as ChemicalDocumentType)}
                className="w-full border border-gray-300 rounded-md py-1.5 px-3 text-sm"
              >
                {Object.entries(documentTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={handleUpload}
              disabled={isUploading || !uploadName}
              className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:bg-gray-400"
            >
              {isUploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        )}
      </div>

      {/* Documents List */}
      {documents.length > 0 ? (
        <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3">
                <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-gray-900">{doc.name}</p>
                  <p className="text-xs text-gray-500">
                    {documentTypeLabels[doc.type]} | {new Date(doc.uploadedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 text-sm"
                >
                  Download
                </a>
                <button
                  type="button"
                  onClick={() => onDelete(doc)}
                  className="text-red-600 hover:text-red-800 text-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500 text-center py-4">No documents uploaded yet</p>
      )}
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const ChemicalsTab: React.FC = () => {
  // API hooks
  const { data: chemicalsData, isLoading, error, refetch } = useChemicalList();
  const { data: chemicalTypesData = [] } = useChemicalTypes();
  // Use fallback categories when API data is not available
  const chemicalTypes = chemicalTypesData.length > 0 ? chemicalTypesData : FALLBACK_CHEMICAL_CATEGORIES;
  const { data: suppliersData } = useSupplierList({ type: 'CHEMICAL' as any });
  const { data: sitesData } = useSiteList();
  const createChemical = useCreateChemical();
  const updateChemical = useUpdateChemical();
  const deleteChemicalMutation = useDeleteChemical();
  const uploadDocument = useUploadChemicalDocument();
  const removeDocument = useRemoveChemicalDocument();

  // Local state
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingChemical, setEditingChemical] = useState<Chemical | null>(null);
  const [formData, setFormData] = useState<ChemicalFormData>(initialFormData);
  const [isSaving, setIsSaving] = useState(false);

  // Collapsible section states
  const [openSections, setOpenSections] = useState({
    basic: true,
    composition: false,
    storage: false,
    usage: false,
    sites: false,
    documents: false,
    notes: false,
  });

  // Data from API
  const chemicals = chemicalsData?.items || [];
  const suppliers = suppliersData?.items || [];
  const sites = sitesData?.items || [];

  const filteredChemicals = chemicals.filter(chemical => {
    const matchesSearch =
      chemical.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      chemical.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (chemical.activeIngredient?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    const matchesCategory = selectedCategory === 'all' || chemical.type === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const input: any = {
        name: formData.name,
        code: formData.code,
        type: formData.type || undefined,
        siteId: formData.siteId,
        unit: formData.unit || 'liter',
        supplierId: formData.supplierId || undefined,
        description: formData.description || undefined,
        activeIngredient: formData.activeIngredient || undefined,
        concentration: formData.concentration || undefined,
        formulation: formData.formulation || undefined,
        storageRequirements: formData.storageRequirements || undefined,
        withdrawalPeriodDays: formData.withdrawalPeriodDays || undefined,
        status: formData.status,
        notes: formData.notes || undefined,
        safetyInfo: {
          hazardClass: formData.hazardClass || undefined,
          signalWord: formData.signalWord || undefined,
          msdsUrl: formData.msdsUrl || undefined,
        },
        usageProtocol: {
          notes: formData.usageGuideUrl ? `Usage Guide: ${formData.usageGuideUrl}` : undefined,
        },
      };

      if (editingId) {
        await updateChemical.mutateAsync({ id: editingId, ...input });
      } else {
        await createChemical.mutateAsync(input as CreateChemicalInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
      setEditingChemical(null);
    } catch (err) {
      console.error('Failed to save chemical:', err);
      alert('Failed to save chemical. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (chemical: Chemical) => {
    setEditingId(chemical.id);
    setEditingChemical(chemical);
    setFormData({
      name: chemical.name,
      code: chemical.code,
      type: chemical.type,
      supplierId: chemical.supplierId || '',
      description: chemical.description || '',
      activeIngredient: chemical.activeIngredient || '',
      concentration: chemical.concentration || '',
      formulation: chemical.formulation || '',
      storageRequirements: chemical.storageRequirements || 'room_temperature',
      hazardClass: chemical.safetyInfo?.hazardClass || '',
      signalWord: chemical.safetyInfo?.signalWord || '',
      msdsUrl: chemical.safetyInfo?.msdsUrl || '',
      withdrawalPeriodDays: chemical.usageProtocol?.withdrawalPeriod || 0,
      usageGuideUrl: '',
      status: chemical.status,
      notes: chemical.notes || '',
      siteId: chemical.siteId || '',
      siteIds: chemical.siteId ? [chemical.siteId] : [],
      unit: chemical.unit || 'liter',
    });
    setOpenSections(prev => ({ ...prev, basic: true }));
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this chemical?')) {
      try {
        await deleteChemicalMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete chemical:', err);
        alert('Failed to delete chemical. Please try again.');
      }
    }
  };

  const handleDocumentUpload = async (file: File, name: string, type: ChemicalDocumentType) => {
    if (!editingId) return;
    try {
      await uploadDocument.mutateAsync({
        file,
        chemicalId: editingId,
        documentName: name,
        documentType: type,
      });
      refetch();
    } catch (err) {
      console.error('Failed to upload document:', err);
      alert('Failed to upload document. Please try again.');
    }
  };

  const handleDocumentDelete = async (doc: ChemicalDocument) => {
    if (!editingId) return;
    if (confirm(`Delete document "${doc.name}"?`)) {
      try {
        const filename = doc.url.split('/').pop() || doc.name;
        await removeDocument.mutateAsync({
          chemicalId: editingId,
          documentId: doc.id,
          filename,
        });
        refetch();
      } catch (err) {
        console.error('Failed to delete document:', err);
        alert('Failed to delete document. Please try again.');
      }
    }
  };

  const getSupplierName = (supplierId?: string) => {
    if (!supplierId) return '-';
    const supplier = suppliers.find(s => s.id === supplierId);
    return supplier?.name || '-';
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4">
          <div className="relative flex-1 max-w-md">
            <input
              type="text"
              placeholder="Search chemicals..."
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
            {chemicalTypes.map((type) => (
              <option key={type.id} value={type.code}>{type.name}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setEditingChemical(null);
            setFormData(initialFormData);
            setOpenSections({ basic: true, composition: false, storage: false, usage: false, sites: false, documents: false, notes: false });
            setIsModalOpen(true);
          }}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Chemical
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
          <p className="text-red-600">Failed to load chemicals. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Chemicals Table */}
      {!isLoading && !error && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Chemical</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Manufacturer</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Notes</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Documents</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredChemicals.map((chemical) => (
                <tr key={chemical.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{chemical.name}</div>
                    <div className="text-sm text-gray-500">{chemical.code}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[chemical.type] || 'bg-gray-100 text-gray-800'}`}>
                      {categoryLabels[chemical.type] || chemical.type}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {getSupplierName(chemical.supplierId)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[chemical.status] || 'bg-gray-100 text-gray-800'}`}>
                      {statusLabels[chemical.status] || chemical.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500 max-w-xs truncate">
                    {chemical.notes || '-'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {chemical.documents?.length || 0} docs
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button onClick={() => handleEdit(chemical)} className="text-blue-600 hover:text-blue-900 mr-3">Edit</button>
                    <button onClick={() => handleDelete(chemical.id)} className="text-red-600 hover:text-red-900">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Empty State */}
          {filteredChemicals.length === 0 && (
            <div className="text-center py-12">
              <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900">No chemicals found</h3>
              <p className="mt-1 text-sm text-gray-500">Add chemicals to manage treatments and protocols.</p>
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:max-w-2xl sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Chemical' : 'Add Chemical'}
                  </h3>

                  {/* Basic Info Section */}
                  <CollapsibleSection
                    title="Basic Information"
                    isOpen={openSections.basic}
                    onToggle={() => toggleSection('basic')}
                  >
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Name *</label>
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
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Category *</label>
                          <select
                            required
                            value={formData.type}
                            onChange={e => setFormData(prev => ({ ...prev, type: e.target.value as ChemicalType }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="">Select Category</option>
                            {chemicalTypes.map((type) => (
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
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Manufacturer (Supplier)</label>
                          <select
                            value={formData.supplierId}
                            onChange={e => setFormData(prev => ({ ...prev, supplierId: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="">Select Supplier</option>
                            {suppliers.map((supplier) => (
                              <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Unit *</label>
                          <select
                            required
                            value={formData.unit}
                            onChange={e => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="liter">Liter</option>
                            <option value="ml">Milliliter</option>
                            <option value="kg">Kilogram</option>
                            <option value="gram">Gram</option>
                            <option value="piece">Piece</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Description</label>
                        <textarea
                          value={formData.description}
                          onChange={e => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          rows={2}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Status</label>
                        <select
                          value={formData.status}
                          onChange={e => setFormData(prev => ({ ...prev, status: e.target.value as ChemicalStatus }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          {Object.entries(statusLabels).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Composition Section */}
                  <CollapsibleSection
                    title="Composition"
                    isOpen={openSections.composition}
                    onToggle={() => toggleSection('composition')}
                    optional
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Active Ingredient</label>
                        <input
                          type="text"
                          value={formData.activeIngredient}
                          onChange={e => setFormData(prev => ({ ...prev, activeIngredient: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Concentration</label>
                        <input
                          type="text"
                          value={formData.concentration}
                          placeholder="e.g., 10%, 50mg/L"
                          onChange={e => setFormData(prev => ({ ...prev, concentration: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-sm font-medium text-gray-700">Formulation</label>
                        <select
                          value={formData.formulation}
                          onChange={e => setFormData(prev => ({ ...prev, formulation: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">Select Formulation</option>
                          <option value="liquid">Liquid</option>
                          <option value="powder">Powder</option>
                          <option value="granule">Granule</option>
                          <option value="tablet">Tablet</option>
                          <option value="gel">Gel</option>
                          <option value="emulsion">Emulsion</option>
                        </select>
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Storage & Safety Section */}
                  <CollapsibleSection
                    title="Storage & Safety"
                    isOpen={openSections.storage}
                    onToggle={() => toggleSection('storage')}
                    optional
                  >
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Storage Requirements</label>
                          <select
                            value={formData.storageRequirements}
                            onChange={e => setFormData(prev => ({ ...prev, storageRequirements: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            {storageOptions.map((opt) => (
                              <option key={opt.value} value={opt.value}>{opt.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Hazard Class</label>
                          <input
                            type="text"
                            value={formData.hazardClass}
                            onChange={e => setFormData(prev => ({ ...prev, hazardClass: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Signal Word</label>
                          <select
                            value={formData.signalWord}
                            onChange={e => setFormData(prev => ({ ...prev, signalWord: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="">None</option>
                            <option value="warning">Warning</option>
                            <option value="danger">Danger</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">MSDS URL</label>
                          <input
                            type="url"
                            value={formData.msdsUrl}
                            placeholder="https://..."
                            onChange={e => setFormData(prev => ({ ...prev, msdsUrl: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Usage Section */}
                  <CollapsibleSection
                    title="Usage"
                    isOpen={openSections.usage}
                    onToggle={() => toggleSection('usage')}
                    optional
                  >
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Withdrawal Period (days)</label>
                        <input
                          type="number"
                          min="0"
                          value={formData.withdrawalPeriodDays}
                          onChange={e => setFormData(prev => ({ ...prev, withdrawalPeriodDays: parseInt(e.target.value) || 0 }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Usage Guide URL</label>
                        <input
                          type="url"
                          value={formData.usageGuideUrl}
                          placeholder="https://..."
                          onChange={e => setFormData(prev => ({ ...prev, usageGuideUrl: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </CollapsibleSection>

                  {/* Sites Section */}
                  <CollapsibleSection
                    title="Sites"
                    isOpen={openSections.sites}
                    onToggle={() => toggleSection('sites')}
                    optional
                  >
                    <SiteMultiSelect
                      sites={sites}
                      selectedIds={formData.siteIds}
                      onChange={(ids) => setFormData(prev => ({ ...prev, siteIds: ids }))}
                    />
                  </CollapsibleSection>

                  {/* Documents Section - Only for editing */}
                  {editingId && (
                    <CollapsibleSection
                      title="Documents"
                      isOpen={openSections.documents}
                      onToggle={() => toggleSection('documents')}
                      optional
                    >
                      <DocumentsSection
                        chemicalId={editingId}
                        documents={editingChemical?.documents || []}
                        onUpload={handleDocumentUpload}
                        onDelete={handleDocumentDelete}
                        isUploading={uploadDocument.isPending}
                      />
                    </CollapsibleSection>
                  )}

                  {/* Notes Section */}
                  <CollapsibleSection
                    title="Notes"
                    isOpen={openSections.notes}
                    onToggle={() => toggleSection('notes')}
                    optional
                  >
                    <textarea
                      value={formData.notes}
                      onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                      rows={3}
                      placeholder="Additional notes about this chemical..."
                      className="w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                    />
                  </CollapsibleSection>
                </div>

                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm disabled:bg-gray-400"
                  >
                    {isSaving ? 'Saving...' : editingId ? 'Update' : 'Create'}
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

export default ChemicalsTab;
