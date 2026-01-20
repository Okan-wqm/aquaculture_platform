/**
 * Batch Form Modal Component
 * Full form for creating new batches with documents and tank allocations
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  useGenerateBatchNumber,
  useAvailableTanks,
  useCreateBatch,
  type ArrivalMethod,
  type BatchInputType,
  type BatchDocumentType,
} from '../../../hooks/useBatches';
import { useSupplierList } from '../../../hooks/useSuppliers';
import { useSpeciesList } from '../../../hooks/useSpecies';
import { useUploadBatchDocument } from '../../../hooks/useFileUpload';
import { DocumentUploadSection, toDocumentInput } from './DocumentUploadSection';
import { TankAllocationSection, toLocationInput } from './TankAllocationSection';

interface BatchFormData {
  name: string;
  speciesId: string;
  supplierId: string;
  strain: string;
  inputType: BatchInputType;
  initialQuantity: number | '';
  avgWeightG: number | '';
  stockedAt: string;
  expectedHarvestDate: string;
  targetFCR: number | '';
  arrivalMethod: ArrivalMethod | '';
  purchaseCost: number | '';
  currency: string;
  supplierBatchNumber: string;
  notes: string;
}

interface LocalDocument {
  id: string;
  file?: File;
  documentName: string;
  documentNumber?: string;
  documentType: BatchDocumentType;
  storagePath?: string;
  storageUrl?: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  issueDate?: string;
  expiryDate?: string;
  issuingAuthority?: string;
  isUploaded: boolean;
  isUploading: boolean;
  uploadError?: string;
}

interface TankAllocation {
  id: string;
  tankId: string;
  quantity: number;
  allocationDate?: string;
}

interface BatchFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const inputTypeOptions: { value: BatchInputType; label: string }[] = [
  { value: 'EGGS', label: 'Eggs' },
  { value: 'LARVAE', label: 'Larvae' },
  { value: 'POST_LARVAE', label: 'Post-Larvae' },
  { value: 'FRY', label: 'Fry' },
  { value: 'FINGERLINGS', label: 'Fingerlings' },
  { value: 'JUVENILES', label: 'Juveniles' },
  { value: 'ADULTS', label: 'Adults' },
  { value: 'BROODSTOCK', label: 'Broodstock' },
];

const arrivalMethodOptions: { value: ArrivalMethod; label: string }[] = [
  { value: 'AIR_CARGO', label: 'Air Cargo' },
  { value: 'TRUCK', label: 'Truck' },
  { value: 'BOAT', label: 'Boat' },
  { value: 'RAIL', label: 'Rail' },
  { value: 'LOCAL_PICKUP', label: 'Local Pickup' },
  { value: 'OTHER', label: 'Other' },
];

export const BatchFormModal: React.FC<BatchFormModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  // API hooks
  const { data: batchNumber, isLoading: isLoadingBatchNumber, refetch: refetchBatchNumber } = useGenerateBatchNumber();
  const { data: availableTanks = [], isLoading: isLoadingTanks } = useAvailableTanks({ excludeFullTanks: false });
  const { data: suppliers } = useSupplierList();
  const { data: species } = useSpeciesList();
  const uploadMutation = useUploadBatchDocument();
  const createBatchMutation = useCreateBatch();

  // Form state
  const [formData, setFormData] = useState<BatchFormData>({
    name: '',
    speciesId: '',
    supplierId: '',
    strain: '',
    inputType: 'FRY',
    initialQuantity: '',
    avgWeightG: '',
    stockedAt: new Date().toISOString().split('T')[0],
    expectedHarvestDate: '',
    targetFCR: 1.2,
    arrivalMethod: '',
    purchaseCost: '',
    currency: 'USD',
    supplierBatchNumber: '',
    notes: '',
  });

  const [healthCertificates, setHealthCertificates] = useState<LocalDocument[]>([]);
  const [importDocuments, setImportDocuments] = useState<LocalDocument[]>([]);
  const [tankAllocations, setTankAllocations] = useState<TankAllocation[]>([]);
  const [activeTab, setActiveTab] = useState<'basic' | 'documents' | 'tanks' | 'notes'>('basic');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Calculate biomass
  const totalBiomassKg = useMemo(() => {
    const qty = Number(formData.initialQuantity) || 0;
    const weight = Number(formData.avgWeightG) || 0;
    return (qty * weight) / 1000;
  }, [formData.initialQuantity, formData.avgWeightG]);

  // Allocated quantity
  const allocatedQuantity = useMemo(() => {
    return tankAllocations.reduce((sum, a) => sum + (a.quantity || 0), 0);
  }, [tankAllocations]);

  // Reset form when modal opens
  useEffect(() => {
    if (isOpen) {
      setFormData({
        name: '',
        speciesId: '',
        supplierId: '',
        strain: '',
        inputType: 'FRY',
        initialQuantity: '',
        avgWeightG: '',
        stockedAt: new Date().toISOString().split('T')[0],
        expectedHarvestDate: '',
        targetFCR: 1.2,
        arrivalMethod: '',
        purchaseCost: '',
        currency: 'USD',
        supplierBatchNumber: '',
        notes: '',
      });
      setHealthCertificates([]);
      setImportDocuments([]);
      setTankAllocations([]);
      setActiveTab('basic');
      setErrors({});
      refetchBatchNumber();
    }
  }, [isOpen, refetchBatchNumber]);

  // Handle input changes
  const handleInputChange = useCallback((field: keyof BatchFormData, value: string | number) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }));
    }
  }, [errors]);

  // Handle document upload
  const handleUpload = useCallback(async (file: File, documentName: string, documentNumber?: string) => {
    const result = await uploadMutation.mutateAsync({
      file,
      documentName,
      documentCategory: 'health_certificate', // will be overridden by section
      documentNumber,
    });
    return result;
  }, [uploadMutation]);

  // Validate form
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!formData.speciesId) {
      newErrors.speciesId = 'Species is required';
    }
    if (!formData.supplierId) {
      newErrors.supplierId = 'Supplier is required';
    }
    if (!formData.initialQuantity || formData.initialQuantity <= 0) {
      newErrors.initialQuantity = 'Quantity must be greater than 0';
    }
    if (!formData.avgWeightG || formData.avgWeightG <= 0) {
      newErrors.avgWeightG = 'Average weight must be greater than 0';
    }
    if (!formData.stockedAt) {
      newErrors.stockedAt = 'Input date is required';
    }
    if (!formData.arrivalMethod) {
      newErrors.arrivalMethod = 'Arrival method is required';
    }
    if (!formData.targetFCR || formData.targetFCR < 0.5 || formData.targetFCR > 5) {
      newErrors.targetFCR = 'Target FCR must be between 0.5 and 5';
    }

    // Check tank allocations
    if (tankAllocations.length === 0) {
      newErrors.tankAllocations = 'At least one tank allocation is required';
    } else {
      const hasEmptyTank = tankAllocations.some(a => !a.tankId);
      if (hasEmptyTank) {
        newErrors.tankAllocations = 'All allocations must have a tank selected';
      }
      const totalQuantity = Number(formData.initialQuantity) || 0;
      if (allocatedQuantity !== totalQuantity) {
        newErrors.tankAllocations = `Allocated quantity (${allocatedQuantity}) must equal total quantity (${totalQuantity})`;
      }
    }

    // Check for pending uploads
    const pendingUploads = [...healthCertificates, ...importDocuments].some(d => d.isUploading);
    if (pendingUploads) {
      newErrors.documents = 'Please wait for all uploads to complete';
    }

    // Check for failed uploads
    const failedUploads = [...healthCertificates, ...importDocuments].some(d => d.uploadError);
    if (failedUploads) {
      newErrors.documents = 'Some document uploads failed. Please retry or remove them.';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      // Switch to tab with first error
      if (errors.speciesId || errors.supplierId || errors.initialQuantity || errors.avgWeightG || errors.stockedAt || errors.arrivalMethod || errors.targetFCR) {
        setActiveTab('basic');
      } else if (errors.documents) {
        setActiveTab('documents');
      } else if (errors.tankAllocations) {
        setActiveTab('tanks');
      }
      return;
    }

    setIsSubmitting(true);

    try {
      // Convert documents to input format
      const healthCertInputs = healthCertificates
        .map(d => toDocumentInput(d))
        .filter((d): d is NonNullable<typeof d> => d !== null);

      const importDocInputs = importDocuments
        .map(d => toDocumentInput(d))
        .filter((d): d is NonNullable<typeof d> => d !== null);

      // Convert tank allocations
      const avgWeight = Number(formData.avgWeightG) || 0;
      const locationInputs = tankAllocations.map(a => {
        const biomass = (a.quantity * avgWeight) / 1000;
        return toLocationInput(a, biomass);
      });

      // Create batch
      await createBatchMutation.mutateAsync({
        name: formData.name || undefined,
        speciesId: formData.speciesId,
        strain: formData.strain || undefined,
        inputType: formData.inputType,
        initialQuantity: Number(formData.initialQuantity),
        initialWeight: {
          avgWeight: Number(formData.avgWeightG),
          totalBiomass: totalBiomassKg,
        },
        stockedAt: formData.stockedAt,
        expectedHarvestDate: formData.expectedHarvestDate || undefined,
        targetFCR: Number(formData.targetFCR),
        supplierId: formData.supplierId,
        supplierBatchNumber: formData.supplierBatchNumber || undefined,
        purchaseCost: formData.purchaseCost ? Number(formData.purchaseCost) : undefined,
        currency: formData.currency || undefined,
        arrivalMethod: formData.arrivalMethod as ArrivalMethod,
        healthCertificates: healthCertInputs.length > 0 ? healthCertInputs : undefined,
        importDocuments: importDocInputs.length > 0 ? importDocInputs : undefined,
        initialLocations: locationInputs,
        notes: formData.notes || undefined,
      });

      onSuccess();
      onClose();
    } catch (error) {
      console.error('Failed to create batch:', error);
      setErrors(prev => ({
        ...prev,
        submit: error instanceof Error ? error.message : 'Failed to create batch',
      }));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className="inline-block w-full max-w-4xl my-8 overflow-hidden text-left align-middle transition-all transform bg-white rounded-lg shadow-xl">
          {/* Header */}
          <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">New Batch Input</h3>
                <p className="text-sm text-gray-500 mt-0.5">
                  Batch Number:{' '}
                  {isLoadingBatchNumber ? (
                    <span className="text-gray-400">Loading...</span>
                  ) : (
                    <span className="font-mono font-medium text-blue-600">{batchNumber}</span>
                  )}
                </p>
              </div>
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-500"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="mt-4 flex space-x-4">
              {(['basic', 'documents', 'tanks', 'notes'] as const).map((tab) => {
                const hasError = tab === 'basic'
                  ? Object.keys(errors).some(k => ['speciesId', 'supplierId', 'initialQuantity', 'avgWeightG', 'stockedAt', 'arrivalMethod', 'targetFCR'].includes(k))
                  : tab === 'documents'
                  ? !!errors.documents
                  : tab === 'tanks'
                  ? !!errors.tankAllocations
                  : false;

                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-3 py-1.5 text-sm font-medium rounded-md relative ${
                      activeTab === tab
                        ? 'bg-blue-100 text-blue-700'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {tab === 'basic' && 'Basic Info'}
                    {tab === 'documents' && 'Documents'}
                    {tab === 'tanks' && 'Tank Allocation'}
                    {tab === 'notes' && 'Notes'}
                    {hasError && (
                      <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
              {/* Basic Info Tab */}
              {activeTab === 'basic' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    {/* Name (optional) */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Batch Name
                      </label>
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => handleInputChange('name', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="Optional display name"
                      />
                    </div>

                    {/* Input Date */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Input Date <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="date"
                        value={formData.stockedAt}
                        onChange={(e) => handleInputChange('stockedAt', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.stockedAt ? 'border-red-500' : 'border-gray-300'
                        }`}
                      />
                      {errors.stockedAt && <p className="mt-1 text-sm text-red-500">{errors.stockedAt}</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Supplier */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Supplier / Hatchery <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.supplierId}
                        onChange={(e) => handleInputChange('supplierId', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.supplierId ? 'border-red-500' : 'border-gray-300'
                        }`}
                      >
                        <option value="">Select a supplier...</option>
                        {suppliers?.items?.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} ({s.code})
                          </option>
                        ))}
                      </select>
                      {errors.supplierId && <p className="mt-1 text-sm text-red-500">{errors.supplierId}</p>}
                    </div>

                    {/* Species */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Species <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.speciesId}
                        onChange={(e) => handleInputChange('speciesId', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.speciesId ? 'border-red-500' : 'border-gray-300'
                        }`}
                      >
                        <option value="">Select a species...</option>
                        {species?.items?.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.commonName} ({s.scientificName})
                          </option>
                        ))}
                      </select>
                      {errors.speciesId && <p className="mt-1 text-sm text-red-500">{errors.speciesId}</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    {/* Input Type */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Unit Type <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.inputType}
                        onChange={(e) => handleInputChange('inputType', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {inputTypeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Total Quantity */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Total Quantity <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        min="1"
                        value={formData.initialQuantity}
                        onChange={(e) => handleInputChange('initialQuantity', e.target.value ? parseInt(e.target.value) : '')}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.initialQuantity ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="e.g., 50000"
                      />
                      {errors.initialQuantity && <p className="mt-1 text-sm text-red-500">{errors.initialQuantity}</p>}
                    </div>

                    {/* Average Weight */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Average Weight (g) <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        step="0.001"
                        min="0.001"
                        value={formData.avgWeightG}
                        onChange={(e) => handleInputChange('avgWeightG', e.target.value ? parseFloat(e.target.value) : '')}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.avgWeightG ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="e.g., 2.5"
                      />
                      {errors.avgWeightG && <p className="mt-1 text-sm text-red-500">{errors.avgWeightG}</p>}
                    </div>
                  </div>

                  {/* Biomass (calculated) */}
                  <div className="bg-blue-50 p-3 rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-blue-700">Total Biomass</span>
                      <span className="text-lg font-bold text-blue-900">{totalBiomassKg.toFixed(2)} kg</span>
                    </div>
                    <p className="text-xs text-blue-600 mt-1">
                      Calculated: {Number(formData.initialQuantity || 0).toLocaleString()} units x {Number(formData.avgWeightG || 0)} g / 1000
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Arrival Method */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Arrival Method <span className="text-red-500">*</span>
                      </label>
                      <select
                        value={formData.arrivalMethod}
                        onChange={(e) => handleInputChange('arrivalMethod', e.target.value)}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.arrivalMethod ? 'border-red-500' : 'border-gray-300'
                        }`}
                      >
                        <option value="">Select method...</option>
                        {arrivalMethodOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      {errors.arrivalMethod && <p className="mt-1 text-sm text-red-500">{errors.arrivalMethod}</p>}
                    </div>

                    {/* Target FCR */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target FCR <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        min="0.5"
                        max="5"
                        value={formData.targetFCR}
                        onChange={(e) => handleInputChange('targetFCR', e.target.value ? parseFloat(e.target.value) : '')}
                        className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                          errors.targetFCR ? 'border-red-500' : 'border-gray-300'
                        }`}
                        placeholder="e.g., 1.2"
                      />
                      {errors.targetFCR && <p className="mt-1 text-sm text-red-500">{errors.targetFCR}</p>}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    {/* Strain */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Strain</label>
                      <input
                        type="text"
                        value={formData.strain}
                        onChange={(e) => handleInputChange('strain', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="e.g., AquaGen"
                      />
                    </div>

                    {/* Supplier Batch Number */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Supplier Batch #</label>
                      <input
                        type="text"
                        value={formData.supplierBatchNumber}
                        onChange={(e) => handleInputChange('supplierBatchNumber', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        placeholder="e.g., HTC-2024-001"
                      />
                    </div>

                    {/* Expected Harvest Date */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Expected Harvest</label>
                      <input
                        type="date"
                        value={formData.expectedHarvestDate}
                        onChange={(e) => handleInputChange('expectedHarvestDate', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Purchase Cost */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Purchase Cost</label>
                      <div className="flex">
                        <select
                          value={formData.currency}
                          onChange={(e) => handleInputChange('currency', e.target.value)}
                          className="px-3 py-2 border border-r-0 border-gray-300 rounded-l-lg bg-gray-50"
                        >
                          <option value="USD">USD</option>
                          <option value="EUR">EUR</option>
                          <option value="TRY">TRY</option>
                          <option value="NOK">NOK</option>
                        </select>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={formData.purchaseCost}
                          onChange={(e) => handleInputChange('purchaseCost', e.target.value ? parseFloat(e.target.value) : '')}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-r-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Documents Tab */}
              {activeTab === 'documents' && (
                <div className="space-y-6">
                  {errors.documents && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-sm text-red-600">{errors.documents}</p>
                    </div>
                  )}

                  <DocumentUploadSection
                    title="Health Certificates"
                    documentType="HEALTH_CERTIFICATE"
                    documents={healthCertificates}
                    onDocumentsChange={setHealthCertificates}
                    onUpload={handleUpload}
                    required={true}
                    maxDocuments={5}
                  />

                  <hr className="border-gray-200" />

                  <DocumentUploadSection
                    title="Import Documents"
                    documentType="IMPORT_DOCUMENT"
                    documents={importDocuments}
                    onDocumentsChange={setImportDocuments}
                    onUpload={handleUpload}
                    required={false}
                    maxDocuments={5}
                  />
                </div>
              )}

              {/* Tank Allocation Tab */}
              {activeTab === 'tanks' && (
                <div>
                  {errors.tankAllocations && (
                    <div className="p-3 mb-4 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-sm text-red-600">{errors.tankAllocations}</p>
                    </div>
                  )}

                  <TankAllocationSection
                    allocations={tankAllocations}
                    onAllocationsChange={setTankAllocations}
                    availableTanks={availableTanks}
                    isLoadingTanks={isLoadingTanks}
                    totalQuantity={Number(formData.initialQuantity) || 0}
                    avgWeightG={Number(formData.avgWeightG) || 0}
                  />
                </div>
              )}

              {/* Notes Tab */}
              {activeTab === 'notes' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={formData.notes}
                    onChange={(e) => handleInputChange('notes', e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder="Additional notes about this batch..."
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200">
              {errors.submit && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm text-red-600">{errors.submit}</p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-500">
                  {allocatedQuantity > 0 && (
                    <span className={allocatedQuantity === Number(formData.initialQuantity) ? 'text-green-600' : 'text-amber-600'}>
                      {allocatedQuantity.toLocaleString()} / {Number(formData.initialQuantity || 0).toLocaleString()} allocated
                    </span>
                  )}
                </div>
                <div className="flex space-x-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    disabled={isSubmitting}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmitting || isLoadingBatchNumber}
                    className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                  >
                    {isSubmitting && (
                      <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                      </svg>
                    )}
                    {isSubmitting ? 'Creating...' : 'Create Batch'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default BatchFormModal;
