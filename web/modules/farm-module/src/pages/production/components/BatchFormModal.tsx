/**
 * Batch Form Modal Component
 * Full form for creating new batches with documents and tank allocations
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Modal, Spinner, Button, Input, Select, Textarea } from '@aquaculture/shared-ui';
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
  { value: 'SMOLT', label: 'Smolt' },
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

export const BatchFormModal: React.FC<BatchFormModalProps> = ({ isOpen, onClose, onSuccess }) => {
  // API hooks
  const {
    data: batchNumber,
    isLoading: isLoadingBatchNumber,
    refetch: refetchBatchNumber,
  } = useGenerateBatchNumber();
  const {
    data: availableTanks = [],
    isLoading: isLoadingTanks,
    error: tanksError,
  } = useAvailableTanks({ excludeFullTanks: false });
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
  const handleInputChange = useCallback(
    (field: keyof BatchFormData, value: string | number) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (errors[field]) {
        setErrors((prev) => ({ ...prev, [field]: '' }));
      }
    },
    [errors],
  );

  // Handle document upload
  const handleUpload = useCallback(
    async (file: File, documentName: string, documentNumber?: string) => {
      const result = await uploadMutation.mutateAsync({
        file,
        documentName,
        documentCategory: 'health_certificate', // will be overridden by section
        documentNumber,
      });
      return result;
    },
    [uploadMutation],
  );

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
      const hasEmptyTank = tankAllocations.some((a) => !a.tankId);
      if (hasEmptyTank) {
        newErrors.tankAllocations = 'All allocations must have a tank selected';
      }
      const totalQuantity = Number(formData.initialQuantity) || 0;
      if (allocatedQuantity !== totalQuantity) {
        newErrors.tankAllocations = `Allocated quantity (${allocatedQuantity}) must equal total quantity (${totalQuantity})`;
      }
    }

    // Check for pending uploads
    const pendingUploads = [...healthCertificates, ...importDocuments].some((d) => d.isUploading);
    if (pendingUploads) {
      newErrors.documents = 'Please wait for all uploads to complete';
    }

    // Check for failed uploads
    const failedUploads = [...healthCertificates, ...importDocuments].some((d) => d.uploadError);
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
      if (
        errors.speciesId ||
        errors.supplierId ||
        errors.initialQuantity ||
        errors.avgWeightG ||
        errors.stockedAt ||
        errors.arrivalMethod ||
        errors.targetFCR
      ) {
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
        .map((d) => toDocumentInput(d))
        .filter((d): d is NonNullable<typeof d> => d !== null);

      const importDocInputs = importDocuments
        .map((d) => toDocumentInput(d))
        .filter((d): d is NonNullable<typeof d> => d !== null);

      // Convert tank allocations
      const avgWeight = Number(formData.avgWeightG) || 0;
      const locationInputs = tankAllocations.map((a) => {
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
      setErrors((prev) => ({
        ...prev,
        submit: error instanceof Error ? error.message : 'Failed to create batch',
      }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Batch Input" size="xl">
      {/* Batch number */}
      <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2 mb-4">
        Batch Number:{' '}
        {isLoadingBatchNumber ? (
          <span className="text-gray-400 dark:text-gray-500">Loading...</span>
        ) : (
          <span className="font-mono font-medium text-info-600 dark:text-info-400">
            {batchNumber}
          </span>
        )}
      </p>

      {/* Tabs */}
      <div className="mb-4 flex space-x-4 border-b border-gray-200 dark:border-gray-700 pb-3">
        {(['basic', 'documents', 'tanks', 'notes'] as const).map((tab) => {
          const hasError =
            tab === 'basic'
              ? Object.keys(errors).some((k) =>
                  [
                    'speciesId',
                    'supplierId',
                    'initialQuantity',
                    'avgWeightG',
                    'stockedAt',
                    'arrivalMethod',
                    'targetFCR',
                  ].includes(k),
                )
              : tab === 'documents'
                ? !!errors.documents
                : tab === 'tanks'
                  ? !!errors.tankAllocations
                  : false;

          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md relative ${
                activeTab === tab
                  ? 'bg-info-100 dark:bg-info-900/40 text-info-700 dark:text-info-300'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
              }`}
            >
              {tab === 'basic' && 'Basic Info'}
              {tab === 'documents' && 'Documents'}
              {tab === 'tanks' && 'Tank Allocation'}
              {tab === 'notes' && 'Notes'}
              {hasError && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-error-500 rounded-full" />
              )}
            </button>
          );
        })}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit}>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {/* Basic Info Tab */}
          {activeTab === 'basic' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Name (optional) */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Batch Name
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    placeholder="Optional display name"
                  />
                </div>

                {/* Input Date */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Input Date <span className="text-error-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={formData.stockedAt}
                    onChange={(e) => handleInputChange('stockedAt', e.target.value)}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent ${
                      errors.stockedAt ? 'border-error-500' : 'border-gray-300 dark:border-gray-600'
                    }`}
                  />
                  {errors.stockedAt && (
                    <p className="mt-1 text-sm text-error-500">{errors.stockedAt}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Supplier */}
                <Select
                  label="Supplier / Hatchery"
                  required
                  placeholder="Select a supplier..."
                  value={formData.supplierId}
                  onChange={(e) => handleInputChange('supplierId', e.target.value)}
                  error={errors.supplierId}
                  options={(suppliers?.items ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.name} (${s.code})`,
                  }))}
                />

                {/* Species */}
                <Select
                  label="Species"
                  required
                  placeholder="Select a species..."
                  value={formData.speciesId}
                  onChange={(e) => handleInputChange('speciesId', e.target.value)}
                  error={errors.speciesId}
                  options={(species?.items ?? []).map((s) => ({
                    value: s.id,
                    label: `${s.commonName} (${s.scientificName})`,
                  }))}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Input Type */}
                <Select
                  label="Unit Type"
                  required
                  value={formData.inputType}
                  onChange={(e) => handleInputChange('inputType', e.target.value)}
                  options={inputTypeOptions.map((opt) => ({ value: opt.value, label: opt.label }))}
                />

                {/* Total Quantity */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Total Quantity <span className="text-error-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={formData.initialQuantity}
                    onChange={(e) =>
                      handleInputChange(
                        'initialQuantity',
                        e.target.value ? parseInt(e.target.value) : '',
                      )
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent ${
                      errors.initialQuantity
                        ? 'border-error-500'
                        : 'border-gray-300 dark:border-gray-600'
                    }`}
                    placeholder="e.g., 50000"
                  />
                  {errors.initialQuantity && (
                    <p className="mt-1 text-sm text-error-500">{errors.initialQuantity}</p>
                  )}
                </div>

                {/* Average Weight */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Average Weight (g) <span className="text-error-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={formData.avgWeightG}
                    onChange={(e) =>
                      handleInputChange(
                        'avgWeightG',
                        e.target.value ? parseFloat(e.target.value) : '',
                      )
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent ${
                      errors.avgWeightG
                        ? 'border-error-500'
                        : 'border-gray-300 dark:border-gray-600'
                    }`}
                    placeholder="e.g., 2.5"
                  />
                  {errors.avgWeightG && (
                    <p className="mt-1 text-sm text-error-500">{errors.avgWeightG}</p>
                  )}
                </div>
              </div>

              {/* Biomass (calculated) */}
              <div className="bg-info-50 dark:bg-info-900/20 p-3 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-info-700 dark:text-info-300">
                    Total Biomass
                  </span>
                  <span className="text-lg font-bold text-info-900 dark:text-info-100">
                    {totalBiomassKg.toFixed(2)} kg
                  </span>
                </div>
                <p className="text-xs text-info-600 dark:text-info-400 mt-1">
                  Calculated: {Number(formData.initialQuantity || 0).toLocaleString()} units x{' '}
                  {Number(formData.avgWeightG || 0)} g / 1000
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Arrival Method */}
                <Select
                  label="Arrival Method"
                  required
                  placeholder="Select method..."
                  value={formData.arrivalMethod}
                  onChange={(e) => handleInputChange('arrivalMethod', e.target.value)}
                  error={errors.arrivalMethod}
                  options={arrivalMethodOptions.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                  }))}
                />

                {/* Target FCR */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Target FCR <span className="text-error-500">*</span>
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.5"
                    max="5"
                    value={formData.targetFCR}
                    onChange={(e) =>
                      handleInputChange(
                        'targetFCR',
                        e.target.value ? parseFloat(e.target.value) : '',
                      )
                    }
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-info-500 focus:border-transparent ${
                      errors.targetFCR ? 'border-error-500' : 'border-gray-300 dark:border-gray-600'
                    }`}
                    placeholder="e.g., 1.2"
                  />
                  {errors.targetFCR && (
                    <p className="mt-1 text-sm text-error-500">{errors.targetFCR}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {/* Strain */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Strain
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.strain}
                    onChange={(e) => handleInputChange('strain', e.target.value)}
                    placeholder="e.g., AquaGen"
                  />
                </div>

                {/* Supplier Batch Number */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Supplier Batch #
                  </label>
                  <Input
                    fullWidth
                    type="text"
                    value={formData.supplierBatchNumber}
                    onChange={(e) => handleInputChange('supplierBatchNumber', e.target.value)}
                    placeholder="e.g., HTC-2024-001"
                  />
                </div>

                {/* Expected Harvest Date */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Expected Harvest
                  </label>
                  <Input
                    fullWidth
                    type="date"
                    value={formData.expectedHarvestDate}
                    onChange={(e) => handleInputChange('expectedHarvestDate', e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Purchase Cost */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Purchase Cost
                  </label>
                  <div className="flex">
                    <Select
                      options={[
                        { value: 'USD', label: 'USD' },
                        { value: 'EUR', label: 'EUR' },
                        { value: 'TRY', label: 'TRY' },
                        { value: 'NOK', label: 'NOK' },
                      ]}
                      value={formData.currency}
                      onChange={(e) => handleInputChange('currency', e.target.value)}
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={formData.purchaseCost}
                      onChange={(e) =>
                        handleInputChange(
                          'purchaseCost',
                          e.target.value ? parseFloat(e.target.value) : '',
                        )
                      }
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
                <div className="p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
                  <p className="text-sm text-error-600 dark:text-error-400">{errors.documents}</p>
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

              <hr className="border-gray-200 dark:border-gray-700" />

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
                <div className="p-3 mb-4 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
                  <p className="text-sm text-error-600 dark:text-error-400">
                    {errors.tankAllocations}
                  </p>
                </div>
              )}

              <TankAllocationSection
                allocations={tankAllocations}
                onAllocationsChange={setTankAllocations}
                availableTanks={availableTanks}
                isLoadingTanks={isLoadingTanks}
                tanksError={tanksError}
                totalQuantity={Number(formData.initialQuantity) || 0}
                avgWeightG={Number(formData.avgWeightG) || 0}
              />
            </div>
          )}

          {/* Notes Tab */}
          {activeTab === 'notes' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Notes
              </label>
              <Textarea
                fullWidth
                value={formData.notes}
                onChange={(e) => handleInputChange('notes', e.target.value)}
                rows={8}
                maxLength={5000}
                placeholder="Additional notes about this batch..."
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          {errors.submit && (
            <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg">
              <p className="text-sm text-error-600 dark:text-error-400">{errors.submit}</p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-500 dark:text-gray-400">
              {allocatedQuantity > 0 && (
                <span
                  className={
                    allocatedQuantity === Number(formData.initialQuantity)
                      ? 'text-success-600 dark:text-success-400'
                      : 'text-warning-600 dark:text-warning-400'
                  }
                >
                  {allocatedQuantity.toLocaleString()} /{' '}
                  {Number(formData.initialQuantity || 0).toLocaleString()} allocated
                </span>
              )}
            </div>
            <div className="flex space-x-3">
              <Button variant="secondary" type="button" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={isSubmitting || isLoadingBatchNumber}
              >
                {isSubmitting && <Spinner size="sm" color="white" className="-ml-1 mr-2" />}
                {isSubmitting ? 'Creating...' : 'Create Batch'}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
};

export default BatchFormModal;
