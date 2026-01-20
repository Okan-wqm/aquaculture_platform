/**
 * Equipment Tab Component
 * Displays list of equipment with dynamic specifications
 * Two-stage type selection: Category → Type
 * Dynamic specification form based on equipment type
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
  useEquipmentList,
  useEquipmentTypes,
  useCreateEquipment,
  useUpdateEquipment,
  useDeleteEquipment,
  useEquipmentDeletePreview,
  Equipment,
  EquipmentType,
} from '../../../hooks/useEquipment';
import { useDepartmentsBySite } from '../../../hooks/useDepartments';
import { useSiteList } from '../../../hooks/useSites';
import { useSystemsBySite } from '../../../hooks/useSystems';
import { useSupplierList } from '../../../hooks/useSuppliers';
import {
  DynamicSpecificationForm,
  SpecificationSchema,
  validateSpecifications,
  getDefaultSpecificationValues,
  DeleteConfirmationDialog,
  DeletePreviewData,
  AffectedItemGroup,
} from '@aquaculture/shared-ui';

// Equipment categories for two-stage selection
// Values must match backend EquipmentCategory enum (UPPERCASE)
const EQUIPMENT_CATEGORIES = [
  { value: 'TANK', label: 'Tank' },
  { value: 'POND', label: 'Pond' },
  { value: 'PUMP', label: 'Pump' },
  { value: 'FILTRATION', label: 'Filter' },
  { value: 'HEATING_COOLING', label: 'Heater/Chiller' },
  { value: 'MONITORING', label: 'Sensor' },
  { value: 'AERATION', label: 'Blower/Aerator' },
  { value: 'FEEDING', label: 'Feeder' },
  { value: 'ELECTRICAL', label: 'Generator' },
  { value: 'WATER_TREATMENT', label: 'Water Treatment' },
  { value: 'OTHER', label: 'Other' },
];

const statusColors: Record<string, string> = {
  OPERATIONAL: 'bg-green-100 text-green-800',
  MAINTENANCE: 'bg-yellow-100 text-yellow-800',
  FAULTY: 'bg-red-100 text-red-800',
  DECOMMISSIONED: 'bg-gray-100 text-gray-800',
};

const typeIcons: Record<string, string> = {
  'fish-tank': 'M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z',
  'tank': 'M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6z',
  'water-pump': 'M13 10V3L4 14h7v7l9-11h-7z',
  'pump': 'M13 10V3L4 14h7v7l9-11h-7z',
  'drum-filter': 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
  'filtration': 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
  'blower': 'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  'aeration': 'M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  'auto-feeder': 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
  'feeding': 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
};

interface EquipmentFormData {
  name: string;
  code: string;
  selectedCategory: string;  // Category for two-stage selection
  equipmentTypeId: string;
  siteId: string;
  departmentId: string;
  systemIds: string[];
  status: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  purchaseDate: string;
  warrantyEndDate: string;
  supplierId: string;
  description: string;
  parentEquipmentId: string;  // Parent equipment for hierarchy
  isVisibleInSensor: boolean;
  specifications: Record<string, unknown>;  // Dynamic specifications
}

const initialFormData: EquipmentFormData = {
  name: '',
  code: '',
  selectedCategory: '',
  equipmentTypeId: '',
  siteId: '',
  departmentId: '',
  systemIds: [],
  status: 'OPERATIONAL',
  manufacturer: '',
  model: '',
  serialNumber: '',
  purchaseDate: '',
  warrantyEndDate: '',
  supplierId: '',
  description: '',
  parentEquipmentId: '',
  isVisibleInSensor: false,
  specifications: {},
};

export const EquipmentTab: React.FC = () => {
  // Local state - declared before hooks that depend on it
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [showOrphanedOnly, setShowOrphanedOnly] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<EquipmentFormData>(initialFormData);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [equipmentToDelete, setEquipmentToDelete] = useState<Equipment | null>(null);

  // DEBUG: Auth durumunu kontrol et
  const debugToken = localStorage.getItem('access_token');
  const debugTenantId = localStorage.getItem('tenant_id');
  console.log('[EquipmentTab] DEBUG - token:', debugToken ? 'EXISTS' : 'NULL', 'tenantId:', debugTenantId);

  // API hooks
  const { data: equipmentData, isLoading, error, refetch } = useEquipmentList();
  const { data: equipmentTypes } = useEquipmentTypes();
  const { data: sitesData } = useSiteList();
  const { data: departmentsList } = useDepartmentsBySite(formData.siteId || '');
  const { data: systemsList } = useSystemsBySite(formData.siteId || '');
  const { data: suppliersData } = useSupplierList();
  const createEquipment = useCreateEquipment();
  const updateEquipment = useUpdateEquipment();
  const deleteEquipmentMutation = useDeleteEquipment();

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useEquipmentDeletePreview(
    equipmentToDelete?.id ?? null
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

    if (deletePreview.affectedItems.childEquipment.length > 0) {
      affectedItems.push({
        type: 'childEquipment',
        label: 'Alt Ekipmanlar',
        items: deletePreview.affectedItems.childEquipment.map(e => ({
          id: e.id,
          name: e.name,
          code: e.code,
          status: e.status,
        })),
      });
    }

    if (deletePreview.affectedItems.subEquipment.length > 0) {
      affectedItems.push({
        type: 'subEquipment',
        label: 'Alt Parçalar',
        items: deletePreview.affectedItems.subEquipment.map(e => ({
          id: e.id,
          name: e.name,
          code: e.code,
          status: e.status,
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

  // Get data lists
  const sites = sitesData?.items || [];
  const departments = departmentsList || [];
  const systems = systemsList || [];
  const suppliers = suppliersData?.items || [];

  // Filter equipment types by selected category
  const filteredTypesByCategory = useMemo(() => {
    if (!formData.selectedCategory || !equipmentTypes) return [];
    return equipmentTypes.filter(
      (type) => type.category === formData.selectedCategory
    );
  }, [formData.selectedCategory, equipmentTypes]);

  // Get selected equipment type with its specification schema
  const selectedEquipmentType = useMemo(() => {
    if (!formData.equipmentTypeId || !equipmentTypes) return null;
    return equipmentTypes.find((type) => type.id === formData.equipmentTypeId) || null;
  }, [formData.equipmentTypeId, equipmentTypes]);

  // Get specification schema from selected type
  const specificationSchema = useMemo((): SpecificationSchema | null => {
    if (!selectedEquipmentType?.specificationSchema) return null;
    return selectedEquipmentType.specificationSchema as unknown as SpecificationSchema;
  }, [selectedEquipmentType]);

  // Get equipment list from API or empty array
  const equipment = equipmentData?.items || [];

  // Count orphaned equipment (no system associations)
  const orphanedCount = equipment.filter(
    eq => (!eq.systemIds || eq.systemIds.length === 0) && (!eq.systems || eq.systems.length === 0)
  ).length;

  // Get available parent equipment (exclude current equipment if editing, and filter by site if selected)
  const availableParentEquipment = useMemo(() => {
    if (!equipment.length) return [];
    return equipment.filter((eq) => {
      // Exclude current equipment when editing
      if (editingId && eq.id === editingId) return false;
      // Exclude equipment that already has this as parent (prevent circular reference)
      if (editingId && eq.parentEquipmentId === editingId) return false;
      // Filter by site if selected
      if (formData.siteId && eq.department?.siteId !== formData.siteId) return false;
      return true;
    });
  }, [equipment, editingId, formData.siteId]);

  const filteredEquipment = equipment.filter(eq => {
    const matchesSearch =
      eq.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      eq.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      eq.serialNumber?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = selectedType === 'all' || eq.equipmentType?.code === selectedType;
    const matchesStatus = selectedStatus === 'all' || eq.status === selectedStatus;
    const isOrphaned = (!eq.systemIds || eq.systemIds.length === 0) && (!eq.systems || eq.systems.length === 0);
    const matchesOrphanFilter = !showOrphanedOnly || isOrphaned;
    return matchesSearch && matchesType && matchesStatus && matchesOrphanFilter;
  });

  // Get unique types for filter from equipment types API
  const types = (equipmentTypes || []).map(type => ({
    value: type.code,
    label: type.name,
  }));

  const renderSpecifications = (specs: Record<string, unknown>) => {
    return Object.entries(specs).map(([key, value]) => (
      <div key={key} className="flex justify-between text-sm">
        <span className="text-gray-500 capitalize">{key.replace(/([A-Z])/g, ' $1').trim()}:</span>
        <span className="text-gray-900 font-medium">{String(value)}</span>
      </div>
    ));
  };

  // Handle category change - reset type and specifications
  const handleCategoryChange = useCallback((category: string) => {
    setFormData((prev) => ({
      ...prev,
      selectedCategory: category,
      equipmentTypeId: '',
      specifications: {},
    }));
  }, []);

  // Handle type change - reset specifications with defaults
  const handleTypeChange = useCallback((typeId: string) => {
    const selectedType = equipmentTypes?.find((t) => t.id === typeId);
    const schema = selectedType?.specificationSchema as unknown as SpecificationSchema | undefined;
    const defaults = schema ? getDefaultSpecificationValues(schema) : {};

    setFormData((prev) => ({
      ...prev,
      equipmentTypeId: typeId,
      specifications: defaults,
    }));
  }, [equipmentTypes]);

  // Handle specifications change
  const handleSpecificationsChange = useCallback((specs: Record<string, unknown>) => {
    setFormData((prev) => ({
      ...prev,
      specifications: specs,
    }));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate required fields
    if (!formData.siteId) {
      alert('Please select a site.');
      return;
    }
    if (!formData.departmentId) {
      alert('Please select a department.');
      return;
    }
    if (formData.systemIds.length === 0) {
      alert('Please select at least one system.');
      return;
    }
    if (!formData.equipmentTypeId) {
      alert('Please select an equipment type.');
      return;
    }

    // Validate specifications
    if (specificationSchema) {
      const specErrors = validateSpecifications(specificationSchema, formData.specifications);
      if (Object.keys(specErrors).length > 0) {
        alert('Please fill in all required specification fields: ' + Object.values(specErrors).join(', '));
        return;
      }
    }

    try {
      if (editingId) {
        await updateEquipment.mutateAsync({
          id: editingId,
          name: formData.name,
          code: formData.code,
          systemIds: formData.systemIds,
          status: formData.status,
          manufacturer: formData.manufacturer || undefined,
          model: formData.model || undefined,
          serialNumber: formData.serialNumber || undefined,
          purchaseDate: formData.purchaseDate || undefined,
          warrantyEndDate: formData.warrantyEndDate || undefined,
          supplierId: formData.supplierId || undefined,
          description: formData.description || undefined,
          parentEquipmentId: formData.parentEquipmentId || undefined,
          isVisibleInSensor: formData.isVisibleInSensor,
          specifications: formData.specifications,
        });
      } else {
        await createEquipment.mutateAsync({
          name: formData.name,
          code: formData.code,
          equipmentTypeId: formData.equipmentTypeId,
          departmentId: formData.departmentId,
          systemIds: formData.systemIds,
          status: formData.status,
          manufacturer: formData.manufacturer || undefined,
          model: formData.model || undefined,
          serialNumber: formData.serialNumber || undefined,
          purchaseDate: formData.purchaseDate || undefined,
          warrantyEndDate: formData.warrantyEndDate || undefined,
          supplierId: formData.supplierId || undefined,
          description: formData.description || undefined,
          parentEquipmentId: formData.parentEquipmentId || undefined,
          isVisibleInSensor: formData.isVisibleInSensor,
          specifications: formData.specifications,
        });
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
    } catch (err) {
      console.error('Failed to save equipment:', err);
      alert('Failed to save equipment. Please try again.');
    }
  };

  const handleEdit = (eq: Equipment) => {
    setEditingId(eq.id);
    // Get siteId from the equipment's department
    const siteId = eq.department?.siteId || '';
    // Get category from equipment type
    const category = eq.equipmentType?.category || '';
    setFormData({
      name: eq.name,
      code: eq.code,
      selectedCategory: category,
      equipmentTypeId: eq.equipmentTypeId || eq.equipmentType?.id || '',
      siteId: siteId,
      departmentId: eq.departmentId || '',
      systemIds: eq.systemIds || [],
      status: eq.status,
      manufacturer: eq.manufacturer || '',
      model: eq.model || '',
      serialNumber: eq.serialNumber || '',
      purchaseDate: eq.purchaseDate?.split('T')[0] || '',
      warrantyEndDate: eq.warrantyEndDate?.split('T')[0] || '',
      supplierId: eq.supplierId || '',
      description: eq.description || '',
      parentEquipmentId: eq.parentEquipmentId || '',
      isVisibleInSensor: eq.isVisibleInSensor ?? false,
      specifications: (eq.specifications as Record<string, unknown>) || {},
    });
    setIsModalOpen(true);
  };

  const handleSiteChange = (siteId: string) => {
    setFormData(prev => ({
      ...prev,
      siteId,
      departmentId: '', // Reset department when site changes
      systemIds: [], // Reset systems when site changes
    }));
  };

  const handleDepartmentChange = (departmentId: string) => {
    setFormData(prev => ({
      ...prev,
      departmentId,
    }));
  };

  const handleSystemToggle = (systemId: string) => {
    setFormData(prev => ({
      ...prev,
      systemIds: prev.systemIds.includes(systemId)
        ? prev.systemIds.filter(id => id !== systemId)
        : [...prev.systemIds, systemId],
    }));
  };

  const handleDelete = (eq: Equipment) => {
    setEquipmentToDelete(eq);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!equipmentToDelete) return;
    try {
      await deleteEquipmentMutation.mutateAsync({ id: equipmentToDelete.id, cascade: true });
      setDeleteDialogOpen(false);
      setEquipmentToDelete(null);
    } catch (err) {
      console.error('Failed to delete equipment:', err);
      alert('Failed to delete equipment. Please try again.');
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setEquipmentToDelete(null);
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
        <div className="flex flex-1 gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder="Search equipment..."
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Types</option>
            {types.map(type => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Status</option>
            <option value="OPERATIONAL">Operational</option>
            <option value="MAINTENANCE">Maintenance</option>
            <option value="FAULTY">Faulty</option>
          </select>
          <label className="flex items-center text-sm text-gray-600 ml-2">
            <input
              type="checkbox"
              checked={showOrphanedOnly}
              onChange={(e) => setShowOrphanedOnly(e.target.checked)}
              className="mr-2 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Orphaned only
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-300 overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-2 ${viewMode === 'grid' ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode('table')}
              className={`px-3 py-2 ${viewMode === 'table' ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </button>
          </div>
          <button
            onClick={() => {
              setEditingId(null);
              setFormData(initialFormData);
              setIsModalOpen(true);
            }}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
          >
            <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Equipment
          </button>
        </div>
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
          <p className="text-red-600">Failed to load equipment. Please try again.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">Retry</button>
        </div>
      )}

      {/* Orphan Warning Notice */}
      {!isLoading && !error && orphanedCount > 0 && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center">
          <svg className="w-5 h-5 text-red-500 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm text-red-700">
            {orphanedCount} equipment item(s) are not associated with any system
          </span>
        </div>
      )}

      {/* Equipment Grid View */}
      {!isLoading && !error && viewMode === 'grid' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredEquipment.map((eq) => (
            <div
              key={eq.id}
              className={`rounded-lg shadow-sm border-2 hover:shadow-md transition-shadow ${
                (eq.systemIds && eq.systemIds.length > 0) || (eq.systems && eq.systems.length > 0)
                  ? 'bg-white border-blue-500'
                  : 'bg-red-50 border-red-500'
              }`}
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center">
                    <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center mr-3">
                      <svg className="w-6 h-6 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={typeIcons[eq.equipmentType?.code || ''] || typeIcons[eq.equipmentType?.category || ''] || typeIcons['fish-tank']} />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">{eq.name}</h3>
                      <p className="text-sm text-gray-500">{eq.code}</p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[eq.status] || 'bg-gray-100 text-gray-800'}`}>
                    {eq.status}
                  </span>
                </div>

                <div className="space-y-2 text-sm mb-4">
                  <div className="flex items-center text-gray-600">
                    <span className="text-gray-400 w-24">Type:</span>
                    <span className="font-medium">{eq.equipmentType?.name || '-'}</span>
                  </div>
                  <div className="flex items-center text-gray-600">
                    <span className="text-gray-400 w-24">Location:</span>
                    <span>{eq.department?.name || '-'}</span>
                  </div>
                  {/* System Association */}
                  {(eq.systemIds && eq.systemIds.length > 0) || (eq.systems && eq.systems.length > 0) ? (
                    <div className="flex items-center text-gray-600">
                      <span className="text-gray-400 w-24">Systems:</span>
                      <span className="text-sm">
                        {eq.systems?.map(s => s.systemName).join(', ') || `${eq.systemIds?.length || 0} system(s)`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center text-red-600">
                      <svg className="w-4 h-4 mr-1 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <span className="text-sm font-medium">Not associated with any system</span>
                    </div>
                  )}
                  <div className="flex items-center text-gray-600">
                    <span className="text-gray-400 w-24">Model:</span>
                    <span>{eq.manufacturer || ''} {eq.model || '-'}</span>
                  </div>
                  {/* Parent Equipment */}
                  {eq.parentEquipment && (
                    <div className="flex items-center text-gray-600">
                      <span className="text-gray-400 w-24">Parent:</span>
                      <span className="flex items-center">
                        <svg className="w-3 h-3 mr-1 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                        {eq.parentEquipment.name}
                      </span>
                    </div>
                  )}
                  {/* Sub Equipment Count */}
                  {(eq.subEquipmentCount || 0) > 0 && (
                    <div className="flex items-center text-gray-600">
                      <span className="text-gray-400 w-24">Sub-equip:</span>
                      <span className="flex items-center text-blue-600">
                        <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        {eq.subEquipmentCount} item(s)
                      </span>
                    </div>
                  )}
                </div>

                {/* Specifications */}
                {eq.specifications && Object.keys(eq.specifications).length > 0 && (
                  <div className="border-t border-gray-200 pt-4">
                    <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Specifications</h4>
                    <div className="space-y-1">
                      {renderSpecifications(eq.specifications)}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500">
                  {eq.warrantyEndDate ? `Warranty: ${new Date(eq.warrantyEndDate).toLocaleDateString()}` : 'No warranty info'}
                </span>
                <div className="flex space-x-2">
                  <button onClick={() => handleEdit(eq)} className="text-blue-600 hover:text-blue-800 text-sm font-medium">Edit</button>
                  <button onClick={() => handleDelete(eq)} className="text-red-600 hover:text-red-800 text-sm font-medium">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Equipment Table View */}
      {!isLoading && !error && viewMode === 'table' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Equipment</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Location</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Systems</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Hierarchy</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Model</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredEquipment.map((eq) => (
                <tr key={eq.id} className={`${
                  (eq.systemIds && eq.systemIds.length > 0) || (eq.systems && eq.systems.length > 0)
                    ? 'hover:bg-blue-50 border-l-4 border-l-blue-500'
                    : 'bg-red-50 border-l-4 border-l-red-500'
                }`}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="text-sm font-medium text-gray-900">{eq.name}</div>
                    <div className="text-sm text-gray-500">{eq.code}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{eq.equipmentType?.name || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{eq.department?.name || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {(eq.systemIds && eq.systemIds.length > 0) || (eq.systems && eq.systems.length > 0) ? (
                      <span className="text-gray-500">
                        {eq.systems?.map(s => s.systemName).join(', ') || `${eq.systemIds?.length || 0} system(s)`}
                      </span>
                    ) : (
                      <span className="flex items-center text-red-600">
                        <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Not associated
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {eq.parentEquipment ? (
                      <span className="flex items-center text-blue-600" title={`Parent: ${eq.parentEquipment.name}`}>
                        <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                        {eq.parentEquipment.code}
                      </span>
                    ) : (eq.subEquipmentCount || 0) > 0 ? (
                      <span className="flex items-center text-green-600" title={`${eq.subEquipmentCount} sub-equipment`}>
                        <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        {eq.subEquipmentCount}
                      </span>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[eq.status] || 'bg-gray-100 text-gray-800'}`}>
                      {eq.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{eq.manufacturer || ''} {eq.model || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button onClick={() => handleEdit(eq)} className="text-blue-600 hover:text-blue-900 mr-3">Edit</button>
                    <button onClick={() => handleDelete(eq)} className="text-red-600 hover:text-red-900">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredEquipment.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <svg className="mx-auto h-12 w-12 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          </svg>
          <h3 className="mt-2 text-sm font-medium text-gray-900">No equipment found</h3>
          <p className="mt-1 text-sm text-gray-500">
            Get started by adding equipment to your farm.
          </p>
        </div>
      )}

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:p-0">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75 transition-opacity" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:max-w-2xl sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="bg-white px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">
                    {editingId ? 'Edit Equipment' : 'Add Equipment'}
                  </h3>

                  <div className="space-y-6">
                    {/* General Information Section */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
                        General Information
                      </h4>
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

                      {/* Two-stage type selection */}
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Category *</label>
                          <select
                            value={formData.selectedCategory}
                            onChange={e => handleCategoryChange(e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                            required
                          >
                            <option value="">Select Category...</option>
                            {EQUIPMENT_CATEGORIES.map(cat => (
                              <option key={cat.value} value={cat.value}>{cat.label}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Type *</label>
                          <select
                            value={formData.equipmentTypeId}
                            onChange={e => handleTypeChange(e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                            required
                            disabled={!formData.selectedCategory}
                          >
                            <option value="">{formData.selectedCategory ? 'Select Type...' : 'Select category first...'}</option>
                            {filteredTypesByCategory.map(type => (
                              <option key={type.id} value={type.id}>{type.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Status *</label>
                          <select
                            value={formData.status}
                            onChange={e => setFormData(prev => ({ ...prev, status: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="OPERATIONAL">Operational</option>
                            <option value="MAINTENANCE">Maintenance</option>
                            <option value="FAULTY">Faulty</option>
                            <option value="DECOMMISSIONED">Decommissioned</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Supplier</label>
                          <select
                            value={formData.supplierId}
                            onChange={e => setFormData(prev => ({ ...prev, supplierId: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          >
                            <option value="">Select Supplier...</option>
                            {suppliers.map(sup => (
                              <option key={sup.id} value={sup.id}>{sup.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Location Section */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
                        Location
                      </h4>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Site *</label>
                          <select
                            value={formData.siteId}
                            onChange={e => handleSiteChange(e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                            required
                          >
                            <option value="">Select Site...</option>
                            {sites.map(site => (
                              <option key={site.id} value={site.id}>{site.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Department *</label>
                          <select
                            value={formData.departmentId}
                            onChange={e => handleDepartmentChange(e.target.value)}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                            required
                            disabled={!formData.siteId}
                          >
                            <option value="">{formData.siteId ? 'Select Department...' : 'Select Site first...'}</option>
                            {departments.map(dept => (
                              <option key={dept.id} value={dept.id}>{dept.name}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div className="mt-4">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Systems * <span className="text-gray-400 text-xs font-normal">(Select all systems this equipment serves)</span>
                        </label>
                        {!formData.siteId ? (
                          <p className="text-sm text-gray-500 italic">Select a site first...</p>
                        ) : systems.length === 0 ? (
                          <p className="text-sm text-gray-500 italic">No systems available for this site</p>
                        ) : (
                          <div className="max-h-32 overflow-y-auto border border-gray-300 rounded-md p-2 space-y-1">
                            {systems.map(sys => (
                              <label
                                key={sys.id}
                                className={`flex items-center p-2 rounded cursor-pointer hover:bg-gray-50 ${
                                  formData.systemIds.includes(sys.id) ? 'bg-blue-50 border border-blue-200' : ''
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={formData.systemIds.includes(sys.id)}
                                  onChange={() => handleSystemToggle(sys.id)}
                                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                                />
                                <span className="ml-2 text-sm text-gray-700">{sys.name}</span>
                                <span className="ml-auto text-xs text-gray-400">{sys.code}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        {formData.systemIds.length > 0 && (
                          <p className="mt-1 text-xs text-blue-600">{formData.systemIds.length} system(s) selected</p>
                        )}
                      </div>
                    </div>

                    {/* Hierarchy Section */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
                        Hierarchy
                      </h4>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">Parent Equipment</label>
                        <select
                          value={formData.parentEquipmentId}
                          onChange={e => setFormData(prev => ({ ...prev, parentEquipmentId: e.target.value }))}
                          className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                        >
                          <option value="">None (Root Equipment)</option>
                          {availableParentEquipment.map(eq => (
                            <option key={eq.id} value={eq.id}>
                              {eq.name} ({eq.code}) - {eq.equipmentType?.name}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-xs text-gray-500">
                          Optional. Select if this equipment is a sub-component of another equipment.
                        </p>
                      </div>

                      {/* Show current child equipment when editing */}
                      {editingId && equipment.find(eq => eq.id === editingId)?.childEquipment?.length ? (
                        <div className="mt-4">
                          <label className="block text-sm font-medium text-gray-700 mb-2">Sub-Equipment</label>
                          <div className="border border-gray-200 rounded-md p-3 bg-gray-50">
                            <div className="space-y-2">
                              {equipment.find(eq => eq.id === editingId)?.childEquipment?.map(child => (
                                <div key={child.id} className="flex items-center justify-between text-sm">
                                  <span className="flex items-center">
                                    <svg className="w-4 h-4 text-gray-400 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                    {child.name} ({child.code})
                                  </span>
                                  <span className={`px-2 py-0.5 text-xs rounded-full ${statusColors[child.status] || 'bg-gray-100 text-gray-800'}`}>
                                    {child.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="mt-2 text-xs text-gray-500">
                              To add sub-equipment, edit or create equipment and set this equipment as their parent.
                            </p>
                          </div>
                        </div>
                      ) : null}
                    </div>

                    {/* Details Section */}
                    <div>
                      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
                        Details
                      </h4>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Manufacturer</label>
                          <input
                            type="text"
                            value={formData.manufacturer}
                            onChange={e => setFormData(prev => ({ ...prev, manufacturer: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Model</label>
                          <input
                            type="text"
                            value={formData.model}
                            onChange={e => setFormData(prev => ({ ...prev, model: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Serial Number</label>
                          <input
                            type="text"
                            value={formData.serialNumber}
                            onChange={e => setFormData(prev => ({ ...prev, serialNumber: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4 mt-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Purchase Date</label>
                          <input
                            type="date"
                            value={formData.purchaseDate}
                            onChange={e => setFormData(prev => ({ ...prev, purchaseDate: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">Warranty Expiry</label>
                          <input
                            type="date"
                            value={formData.warrantyEndDate}
                            onChange={e => setFormData(prev => ({ ...prev, warrantyEndDate: e.target.value }))}
                            className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Technical Specifications Section */}
                    {formData.equipmentTypeId && specificationSchema && (
                      <div>
                        <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
                          Technical Specifications - {selectedEquipmentType?.name}
                        </h4>
                        <DynamicSpecificationForm
                          schema={specificationSchema}
                          values={formData.specifications}
                          onChange={handleSpecificationsChange}
                        />
                      </div>
                    )}

                    {/* Options */}
                    <div className="flex items-center gap-2 pt-2">
                      <input
                        type="checkbox"
                        id="isVisibleInSensor"
                        checked={formData.isVisibleInSensor}
                        onChange={(e) => setFormData(prev => ({ ...prev, isVisibleInSensor: e.target.checked }))}
                        className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      />
                      <label htmlFor="isVisibleInSensor" className="text-sm text-gray-700">
                        Show in Sensor Module (Process Editor)
                      </label>
                    </div>
                  </div>
                </div>
                <div className="bg-gray-50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse">
                  <button
                    type="submit"
                    className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm"
                  >
                    {editingId ? 'Update Equipment' : 'Save Equipment'}
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

      {/* Delete Confirmation Dialog */}
      <DeleteConfirmationDialog
        isOpen={deleteDialogOpen}
        onClose={handleCloseDeleteDialog}
        onConfirm={handleConfirmDelete}
        title="Ekipman Silme Onayı"
        entityName={equipmentToDelete?.name ?? ''}
        entityType="Ekipman"
        preview={dialogPreview}
        isLoading={isPreviewLoading}
        isDeleting={deleteEquipmentMutation.isPending}
      />
    </div>
  );
};

export default EquipmentTab;
