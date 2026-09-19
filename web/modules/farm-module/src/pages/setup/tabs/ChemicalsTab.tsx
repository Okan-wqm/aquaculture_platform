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
import { useSupplierList, Supplier, SupplierType } from '../../../hooks/useSuppliers';
import { useSiteList, Site } from '../../../hooks/useSites';
import {
  FormField,
  Modal,
  useToast,
  useConfirm,
  DataTable,
  type DataTableColumn,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import { ChevronDown, FileText, FlaskConical, Plus, Search as SearchIcon } from 'lucide-react';

// ============================================================================
// CONSTANTS
// ============================================================================

const categoryColors: Record<string, string> = {
  TREATMENT: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  DISINFECTANT: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  ANTIBIOTIC: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  VITAMIN: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  MINERAL: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  WATER_CONDITIONER: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  PROBIOTIC: 'bg-primary-100 dark:bg-primary-900/40 text-primary-800 dark:text-primary-200',
  ANTIPARASITIC: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  ANESTHETIC: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  pH_ADJUSTER: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  ALGAECIDE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  OTHER: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
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
  AVAILABLE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  LOW_STOCK: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  OUT_OF_STOCK: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  EXPIRED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  DISCONTINUED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
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
  storageTempMin: number | '';
  storageTempMax: number | '';
  storageHumidityMin: number | '';
  storageHumidityMax: number | '';
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
  storageTempMin: '',
  storageTempMax: '',
  storageHumidityMin: '',
  storageHumidityMax: '',
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
  <div className="border border-gray-200 dark:border-gray-700 rounded-lg mb-4">
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-t-lg"
    >
      <span className="font-medium text-gray-700 dark:text-gray-300">
        {title}
        {optional && (
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">(Optional)</span>
        )}
      </span>
      <ChevronDown
        className={`w-5 h-5 text-gray-500 dark:text-gray-400 transition-transform ${isOpen ? 'transform rotate-180' : ''}`}
        aria-hidden="true"
      />
    </button>
    {isOpen && <div className="p-4 border-t border-gray-200 dark:border-gray-700">{children}</div>}
  </div>
);

// ============================================================================
// SITE MULTI-SELECT COMPONENT
// ============================================================================

const SiteMultiSelect: React.FC<{
  sites: readonly Site[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}> = ({ sites, selectedIds, onChange }) => {
  const toggleSite = (siteId: string) => {
    if (selectedIds.includes(siteId)) {
      onChange(selectedIds.filter((id) => id !== siteId));
    } else {
      onChange([...selectedIds, siteId]);
    }
  };

  return (
    <div className="space-y-2">
      {sites.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No sites available</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-2">
          {sites.map((site) => (
            <label
              key={site.id}
              className="flex items-center p-2 rounded hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(site.id)}
                onChange={() => toggleSite(site.id)}
                className="h-4 w-4 text-info-600 focus:ring-info-500 border-gray-300 dark:border-gray-600 rounded"
              />
              <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">{site.name}</span>
            </label>
          ))}
        </div>
      )}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {selectedIds.map((id) => {
            const site = sites.find((s) => s.id === id);
            return site ? (
              <span
                key={id}
                className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200"
              >
                {site.name}
                <Button
                  variant="ghost"
                  className="ml-1"
                  type="button"
                  onClick={() => toggleSite(id)}
                >
                  &times;
                </Button>
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
      <p className="text-sm text-gray-500 dark:text-gray-400 italic">
        Save the chemical first to upload documents
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Upload Form */}
      <div className="flex flex-col gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <div className="flex gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
            onChange={handleFileSelect}
            className="flex-1 text-sm text-gray-500 dark:text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-info-50 file:text-info-700 hover:file:bg-info-100"
          />
        </div>
        {selectedFile && (
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Document Name
              </label>
              <Input
                fullWidth
                type="text"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="Enter document name"
              />
            </div>
            <div className="w-40">
              <Select
                label="Type"
                size="sm"
                value={uploadType}
                onChange={(e) => setUploadType(e.target.value as ChemicalDocumentType)}
                options={Object.entries(documentTypeLabels).map(([value, label]) => ({
                  value,
                  label,
                }))}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={handleUpload}
              disabled={isUploading || !uploadName}
            >
              {isUploading ? 'Uploading...' : 'Upload'}
            </Button>
          </div>
        )}
      </div>

      {/* Documents List */}
      {documents.length > 0 ? (
        <div className="border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-200 dark:divide-gray-700">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between p-3">
              <div className="flex items-center gap-3">
                <FileText className="w-8 h-8 text-gray-400 dark:text-gray-500" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{doc.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {documentTypeLabels[doc.type]} | {new Date(doc.uploadedAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-info-600 dark:text-info-400 hover:text-info-800 dark:hover:text-info-200 text-sm"
                >
                  Download
                </a>
                <Button variant="ghost" type="button" onClick={() => onDelete(doc)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
          No documents uploaded yet
        </p>
      )}
    </div>
  );
};

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const ChemicalsTab: React.FC = () => {
  const { toast } = useToast();
  // API hooks
  const { data: chemicalsData, isLoading, error, refetch } = useChemicalList();
  const { data: chemicalTypesData = [] } = useChemicalTypes();
  // Use fallback categories when API data is not available
  const chemicalTypes =
    chemicalTypesData.length > 0 ? chemicalTypesData : FALLBACK_CHEMICAL_CATEGORIES;
  const { data: suppliersData } = useSupplierList({ type: SupplierType.CHEMICAL });
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
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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

  const filteredChemicals = chemicals.filter((chemical) => {
    const matchesSearch =
      chemical.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      chemical.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (chemical.activeIngredient?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
    const matchesCategory = selectedCategory === 'all' || chemical.type === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const confirm = useConfirm();
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const errors: Record<string, string> = {};
    if (!formData.name) errors.name = 'Please enter a name.';
    if (!formData.code) errors.code = 'Please enter a code.';
    if (!formData.type) errors.type = 'Please select a chemical type.';
    if (!formData.siteId) errors.siteId = 'Please select a site.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsSaving(true);
    try {
      const input: any = {
        name: formData.name,
        code: formData.code,
        type: formData.type || undefined,
        unit: formData.unit || 'liter',
        supplierId: formData.supplierId || undefined,
        description: formData.description || undefined,
        activeIngredient: formData.activeIngredient || undefined,
        concentration: formData.concentration || undefined,
        formulation: formData.formulation || undefined,
        storageRequirements: formData.storageRequirements || undefined,
        storageTempMin:
          formData.storageTempMin !== '' ? Number(formData.storageTempMin) : undefined,
        storageTempMax:
          formData.storageTempMax !== '' ? Number(formData.storageTempMax) : undefined,
        storageHumidityMin:
          formData.storageHumidityMin !== '' ? Number(formData.storageHumidityMin) : undefined,
        storageHumidityMax:
          formData.storageHumidityMax !== '' ? Number(formData.storageHumidityMax) : undefined,
        notes: formData.notes || undefined,
      };

      // Only include safetyInfo if it has actual values
      const safetyInfo: Record<string, string> = {};
      if (formData.hazardClass) safetyInfo.hazardClass = formData.hazardClass;
      if (formData.signalWord) safetyInfo.signalWord = formData.signalWord;
      if (formData.msdsUrl) safetyInfo.msdsUrl = formData.msdsUrl;
      if (Object.keys(safetyInfo).length > 0) {
        input.safetyInfo = safetyInfo;
      }

      // Only include usageProtocol if it has actual values (dosage and applicationMethod are required)
      if (formData.usageGuideUrl) {
        input.usageProtocol = {
          notes: `Usage Guide: ${formData.usageGuideUrl}`,
        };
      }

      if (editingId) {
        // siteId is not accepted by UpdateChemicalInput - strip it
        await updateChemical.mutateAsync({ id: editingId, ...input });
      } else {
        // siteId only valid for create
        input.siteId = formData.siteId || undefined;
        await createChemical.mutateAsync(input as CreateChemicalInput);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setFieldErrors({});
      setEditingId(null);
      setEditingChemical(null);
    } catch (err: unknown) {
      console.error('Failed to save chemical:', err);
      // BUG-09: Surface duplicate/conflict errors from backend to the user
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isDuplicate =
        errorMessage.toLowerCase().includes('duplicate') ||
        errorMessage.toLowerCase().includes('conflict') ||
        errorMessage.toLowerCase().includes('already exists') ||
        errorMessage.includes('409');
      if (isDuplicate) {
        toast({
          title: 'Duplicate Chemical',
          description:
            'A chemical with this name or code already exists. Please use a different name or code.',
          variant: 'error',
        });
      } else {
        toast({
          title: 'Error',
          description: 'Failed to save chemical. Please try again.',
          variant: 'error',
        });
      }
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
      storageTempMin: chemical.storageTempMin ?? '',
      storageTempMax: chemical.storageTempMax ?? '',
      storageHumidityMin: chemical.storageHumidityMin ?? '',
      storageHumidityMax: chemical.storageHumidityMax ?? '',
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
    setOpenSections((prev) => ({ ...prev, basic: true }));
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Delete this chemical?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
      try {
        await deleteChemicalMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete chemical:', err);
        toast({ title: 'Failed to delete chemical. Please try again.', variant: 'error' });
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
      toast({ title: 'Failed to upload document. Please try again.', variant: 'error' });
    }
  };

  const handleDocumentDelete = async (doc: ChemicalDocument) => {
    if (!editingId) return;
    if (
      await confirm({
        title: `Delete document "${doc.name}"?`,
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
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
        toast({ title: 'Failed to delete document. Please try again.', variant: 'error' });
      }
    }
  };

  const getSupplierName = (supplierId?: string) => {
    if (!supplierId) return '-';
    const supplier = suppliers.find((s) => s.id === supplierId);
    return supplier?.name || '-';
  };

  type ChemicalRow = (typeof filteredChemicals)[number];
  const chemicalRowColumns: DataTableColumn<ChemicalRow>[] = [
    {
      key: 'chemical',
      header: 'Chemical',
      render: (_value, chemical) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {chemical.name}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{chemical.code}</div>
        </>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (_value, chemical) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${categoryColors[chemical.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {categoryLabels[chemical.type] || chemical.type}
          </span>
        </>
      ),
    },
    {
      key: 'manufacturer',
      header: 'Manufacturer',
      render: (_value, chemical) => getSupplierName(chemical.supplierId),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, chemical) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[chemical.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {statusLabels[chemical.status] || chemical.status}
          </span>
        </>
      ),
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (_value, chemical) => chemical.notes || '-',
    },
    {
      key: 'documents',
      header: 'Documents',
      render: (_value, chemical) => <>{chemical.documents?.length || 0} docs</>,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, chemical) => (
        <>
          <Button variant="ghost" className="mr-3" onClick={() => handleEdit(chemical)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => handleDelete(chemical.id)}>
            Delete
          </Button>
        </>
      ),
    },
  ];

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
              ...chemicalTypes.map((type) => ({ value: type.code, label: type.name })),
            ]}
          />
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setEditingId(null);
            setEditingChemical(null);
            setFormData(initialFormData);
            setFieldErrors({});
            setOpenSections({
              basic: true,
              composition: false,
              storage: false,
              usage: false,
              sites: false,
              documents: false,
              notes: false,
            });
            setIsModalOpen(true);
          }}
        >
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Chemical
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
            Failed to load chemicals. Please try again.
          </p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Chemicals Table */}
      {!isLoading && !error && (
        <div className="bg-white dark:bg-gray-900 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
          <DataTable<ChemicalRow>
            data={filteredChemicals}
            columns={chemicalRowColumns}
            keyExtractor={(chemical) => chemical.id}
            emptyMessage="No records found"
            searchable={false}
            sortable={false}
            stickyHeader={false}
          />

          {/* Empty State */}
          {filteredChemicals.length === 0 && (
            <div className="text-center py-12">
              <FlaskConical
                className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
                No chemicals found
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Add chemicals to manage treatments and protocols.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Chemical' : 'Add Chemical'}
        size="lg"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            {/* Basic Info Section */}
            <CollapsibleSection
              title="Basic Information"
              isOpen={openSections.basic}
              onToggle={() => toggleSection('basic')}
            >
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Name *
                    </label>
                    <FormField
                      error={formData.name ? undefined : fieldErrors.name}
                      className="mb-0"
                    >
                      <Input
                        fullWidth
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                      />
                    </FormField>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Code *
                    </label>
                    <FormField
                      error={formData.code ? undefined : fieldErrors.code}
                      className="mb-0"
                    >
                      <Input
                        fullWidth
                        type="text"
                        required
                        value={formData.code}
                        onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                      />
                    </FormField>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <Select
                      label="Category"
                      required
                      placeholder="Select Category"
                      value={formData.type}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, type: e.target.value as ChemicalType }))
                      }
                      error={formData.type ? undefined : fieldErrors.type}
                      options={chemicalTypes.map((type) => ({
                        value: type.code,
                        label: type.name,
                      }))}
                    />
                  </div>
                  <div>
                    <Select
                      label="Site"
                      required
                      placeholder="Select Site"
                      value={formData.siteId}
                      onChange={(e) => setFormData((prev) => ({ ...prev, siteId: e.target.value }))}
                      error={formData.siteId ? undefined : fieldErrors.siteId}
                      options={sites.map((site) => ({ value: site.id, label: site.name }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Select
                    label="Manufacturer (Supplier)"
                    value={formData.supplierId}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, supplierId: e.target.value }))
                    }
                    options={[
                      { value: '', label: 'Select Supplier' },
                      ...suppliers.map((supplier) => ({
                        value: supplier.id,
                        label: supplier.name,
                      })),
                    ]}
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Unit *
                    </label>
                    <Select
                      fullWidth
                      options={[
                        { value: 'liter', label: 'Liter' },
                        { value: 'ml', label: 'Milliliter' },
                        { value: 'kg', label: 'Kilogram' },
                        { value: 'gram', label: 'Gram' },
                        { value: 'piece', label: 'Piece' },
                      ]}
                      required
                      value={formData.unit}
                      onChange={(e) => setFormData((prev) => ({ ...prev, unit: e.target.value }))}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Description
                  </label>
                  <Textarea
                    fullWidth
                    value={formData.description}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, description: e.target.value }))
                    }
                    rows={2}
                  />
                </div>
                <Select
                  label="Status"
                  value={formData.status}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, status: e.target.value as ChemicalStatus }))
                  }
                  options={Object.entries(statusLabels).map(([value, label]) => ({ value, label }))}
                />
              </div>
            </CollapsibleSection>

            {/* Composition Section */}
            <CollapsibleSection
              title="Composition"
              isOpen={openSections.composition}
              onToggle={() => toggleSection('composition')}
              optional
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Active Ingredient
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.activeIngredient}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, activeIngredient: e.target.value }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Concentration
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.concentration}
                    placeholder="e.g., 10%, 50mg/L"
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, concentration: e.target.value }))
                    }
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Formulation
                  </label>
                  <Select
                    fullWidth
                    options={[
                      { value: '', label: 'Select Formulation' },
                      { value: 'liquid', label: 'Liquid' },
                      { value: 'powder', label: 'Powder' },
                      { value: 'granule', label: 'Granule' },
                      { value: 'tablet', label: 'Tablet' },
                      { value: 'gel', label: 'Gel' },
                      { value: 'emulsion', label: 'Emulsion' },
                    ]}
                    value={formData.formulation}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, formulation: e.target.value }))
                    }
                  />
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Select
                    label="Storage Requirements"
                    value={formData.storageRequirements}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, storageRequirements: e.target.value }))
                    }
                    options={storageOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
                  />
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Hazard Class
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.hazardClass}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, hazardClass: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Min Temp (°C)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      step="0.1"
                      value={formData.storageTempMin}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          storageTempMin: e.target.value ? parseFloat(e.target.value) : '',
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Max Temp (°C)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      step="0.1"
                      value={formData.storageTempMax}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          storageTempMax: e.target.value ? parseFloat(e.target.value) : '',
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Min Humidity (%)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={formData.storageHumidityMin}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          storageHumidityMin: e.target.value ? parseFloat(e.target.value) : '',
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Max Humidity (%)
                    </label>
                    <Input
                      fullWidth
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      value={formData.storageHumidityMax}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          storageHumidityMax: e.target.value ? parseFloat(e.target.value) : '',
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Signal Word
                    </label>
                    <Select
                      fullWidth
                      options={[
                        { value: '', label: 'None' },
                        { value: 'warning', label: 'Warning' },
                        { value: 'danger', label: 'Danger' },
                      ]}
                      value={formData.signalWord}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, signalWord: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      MSDS URL
                    </label>
                    <Input
                      fullWidth
                      type="url"
                      value={formData.msdsUrl}
                      placeholder="https://..."
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, msdsUrl: e.target.value }))
                      }
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Withdrawal Period (days)
                  </label>
                  <Input
                    fullWidth
                    type="number"
                    min="0"
                    value={formData.withdrawalPeriodDays}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        withdrawalPeriodDays: parseInt(e.target.value) || 0,
                      }))
                    }
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    Usage Guide URL
                  </label>
                  <Input
                    fullWidth
                    type="url"
                    value={formData.usageGuideUrl}
                    placeholder="https://..."
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, usageGuideUrl: e.target.value }))
                    }
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
                onChange={(ids) => setFormData((prev) => ({ ...prev, siteIds: ids }))}
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
              <Textarea
                fullWidth
                value={formData.notes}
                onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                rows={3}
                placeholder="Additional notes about this chemical..."
              />
            </CollapsibleSection>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 sm:flex sm:flex-row-reverse">
            <Button
              variant="primary"
              size="lg"
              className="justify-center sm:ml-3 sm:w-auto sm:text-sm"
              type="submit"
              disabled={isSaving}
            >
              {isSaving ? 'Saving...' : editingId ? 'Update' : 'Create'}
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

export default ChemicalsTab;
