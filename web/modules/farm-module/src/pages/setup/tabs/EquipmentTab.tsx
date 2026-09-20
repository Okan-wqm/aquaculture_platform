/**
 * Equipment Tab Component
 * Displays list of equipment with dynamic specifications
 * Two-stage type selection: Category → Type
 * Dynamic specification form based on equipment type
 */
import React, { useState, useMemo, useCallback, useEffect } from 'react';
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
import { useSensors } from '../../../hooks/useSensors';
import {
  AffectedItemGroup,
  Button,
  DeleteConfirmationDialog,
  DeletePreviewData,
  DynamicSpecificationForm,
  FormField,
  getDefaultSpecificationValues,
  Input,
  Modal,
  Select,
  SpecificationSchema,
  Spinner,
  ToggleButton,
  useToast,
  validateSpecifications,
  type SelectOption,
} from '@aquaculture/shared-ui';
import { FeederCalibrationSection } from '../components/FeederCalibrationSection';
import { SubEquipmentSection } from '../components/SubEquipmentSection';
import { DataTable, type DataTableColumn } from '@aquaculture/shared-ui';
import {
  ArrowDown,
  ArrowUp,
  Box,
  ChevronRight,
  Filter,
  Grid2x2,
  LayoutGrid,
  type LucideIcon,
  Menu,
  Plus,
  Search as SearchIcon,
  Settings,
  Square,
  TriangleAlert,
  Wind,
  Zap,
} from 'lucide-react';

/** Lifecycle states every piece of equipment can be in. */
const EQUIPMENT_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'OPERATIONAL', label: 'Operational' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'REPAIR', label: 'Repair' },
  { value: 'STANDBY', label: 'Standby' },
  { value: 'OUT_OF_SERVICE', label: 'Out of Service' },
  { value: 'DECOMMISSIONED', label: 'Decommissioned' },
];

/** The extra states a tank, pond or cage can be in — holding stock, not running. */
const TANK_STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PREPARING', label: 'Preparing' },
  { value: 'CLEANING', label: 'Cleaning' },
  { value: 'HARVESTING', label: 'Harvesting' },
  { value: 'FALLOW', label: 'Fallow' },
  { value: 'QUARANTINE', label: 'Quarantine' },
];

/** The same states under a heading, which is what Select renders as an optgroup. */
const grouped = (options: readonly SelectOption[], group: string): SelectOption[] =>
  options.map((option) => ({ ...option, group }));

// Equipment categories for two-stage selection.
// Values match GraphQL enum wire values; normalizeCategory accepts legacy
// lower-case DB strings returned by older generated hooks.
const EQUIPMENT_CATEGORIES = [
  { value: 'TANK', label: 'Tank' },
  { value: 'POND', label: 'Pond' },
  { value: 'CAGE', label: 'Cage' },
  { value: 'PUMP', label: 'Pump' },
  { value: 'FILTRATION', label: 'Filter' },
  { value: 'HEATING_COOLING', label: 'Heater/Chiller' },
  { value: 'MONITORING', label: 'Sensor' },
  { value: 'AERATION', label: 'Blower/Aerator' },
  { value: 'FEEDING', label: 'Feeder' },
  { value: 'ELECTRICAL', label: 'Generator' },
  { value: 'WATER_TREATMENT', label: 'Water Treatment' },
  { value: 'PLUMBING', label: 'Plumbing' },
  { value: 'OTHER', label: 'Other' },
];

const statusColors: Record<string, string> = {
  // General equipment statuses
  OPERATIONAL: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  MAINTENANCE: 'bg-warning-100 dark:bg-warning-900/40 text-warning-800 dark:text-warning-200',
  REPAIR: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  STANDBY: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  OUT_OF_SERVICE: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
  DECOMMISSIONED: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  // Tank-specific statuses
  ACTIVE: 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200',
  PREPARING: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  CLEANING: 'bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200',
  HARVESTING: 'bg-accent-100 dark:bg-accent-900/40 text-accent-800 dark:text-accent-200',
  FALLOW: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
  QUARANTINE: 'bg-error-100 dark:bg-error-900/40 text-error-800 dark:text-error-200',
};

const TANK_CATEGORIES = ['TANK', 'POND', 'CAGE'];

function normalizeCategory(category?: string): string {
  return category ? category.toUpperCase() : '';
}

// PERF-018: Pre-compile the camelCase regex once at module scope so it is not
// reallocated inside the render loop on every equipment card render.
const CAMEL_CASE_REGEX = /([A-Z])/g;

/**
 * Convert a camelCase key to a human-readable label.
 * Defined outside the component so it is not recreated on re-renders.
 */
function camelCaseToLabel(key: string): string {
  return key.replace(CAMEL_CASE_REGEX, ' $1').trim();
}

/**
 * Render equipment specification entries.
 * Defined outside the component to avoid re-creation on every render cycle (PERF-018).
 *
 * ARCH-NOTE: Equipment specifications contain nested objects (dimensions, waterFlow, aeration).
 * This renderer handles 3 levels: primitives (direct display), booleans (Yes/No),
 * and nested objects (recursively rendered as sub-groups).
 * null/undefined values are skipped to avoid empty rows.
 */
function renderSpecifications(specs: Record<string, unknown>): React.ReactNode[] {
  return Object.entries(specs)
    .filter(([, value]) => value != null)
    .flatMap(([key, value]) => {
      if (typeof value === 'boolean') {
        return [
          <div key={key} className="flex justify-between text-sm">
            <span className="text-gray-500 dark:text-gray-400 capitalize">
              {camelCaseToLabel(key)}:
            </span>
            <span
              className={`font-medium ${value ? 'text-success-600 dark:text-success-400' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {value ? 'Yes' : 'No'}
            </span>
          </div>,
        ];
      }
      if (typeof value === 'object' && !Array.isArray(value)) {
        const nested = value as Record<string, unknown>;
        return [
          <div
            key={`${key}-header`}
            className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-1 capitalize"
          >
            {camelCaseToLabel(key)}
          </div>,
          ...Object.entries(nested)
            .filter(([, v]) => v != null)
            .map(([subKey, subValue]) => (
              <div key={`${key}-${subKey}`} className="flex justify-between text-sm pl-2">
                <span className="text-gray-500 dark:text-gray-400 capitalize">
                  {camelCaseToLabel(subKey)}:
                </span>
                <span className="text-gray-900 dark:text-gray-100 font-medium">
                  {typeof subValue === 'boolean'
                    ? subValue
                      ? 'Yes'
                      : 'No'
                    : typeof subValue === 'object'
                      ? JSON.stringify(subValue)
                      : String(subValue)}
                </span>
              </div>
            )),
        ];
      }
      return [
        <div key={key} className="flex justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400 capitalize">
            {camelCaseToLabel(key)}:
          </span>
          <span className="text-gray-900 dark:text-gray-100 font-medium">{String(value)}</span>
        </div>,
      ];
    });
}

const typeIcons: Record<string, LucideIcon> = {
  'fish-tank': Square,
  tank: Square,
  pond: Square,
  cage: Grid2x2,
  'water-pump': Zap,
  pump: Zap,
  'drum-filter': Filter,
  filtration: Filter,
  blower: Wind,
  aeration: Wind,
  'auto-feeder': Box,
  feeding: Box,
};

function EquipmentTypeIcon({
  type,
}: {
  type: { code?: string; category?: string } | undefined;
}): React.JSX.Element {
  const TypeIcon =
    (type?.code !== undefined ? typeIcons[type.code] : undefined) ??
    (type?.category !== undefined ? typeIcons[type.category] : undefined) ??
    Square;
  return <TypeIcon className="w-6 h-6 text-info-600 dark:text-info-400" aria-hidden="true" />;
}

interface EquipmentFormData {
  name: string;
  code: string;
  selectedCategory: string; // Category for two-stage selection
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
  parentEquipmentId: string; // Parent equipment for hierarchy
  isVisibleInSensor: boolean;
  temperatureSensorId: string; // Linked temperature sensor (sensor-service sensors.id)
  specifications: Record<string, unknown>; // Dynamic specifications
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
  temperatureSensorId: '',
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
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [equipmentToDelete, setEquipmentToDelete] = useState<Equipment | null>(null);

  const { toast } = useToast();

  // API hooks
  const { data: equipmentData, isLoading, error, refetch } = useEquipmentList();
  const { data: equipmentTypes } = useEquipmentTypes();

  // BUG-014: reset type filter when equipmentTypes list changes (e.g. after initial load)
  // so a stale selectedType value doesn't silently produce an empty filtered list
  useEffect(() => {
    if (equipmentTypes && equipmentTypes.length > 0 && selectedType !== 'all') {
      const stillValid = equipmentTypes.some((t) => t.code === selectedType);
      if (!stillValid) {
        setSelectedType('all');
      }
    }
  }, [equipmentTypes, selectedType]);

  const { data: sitesData } = useSiteList();
  const { data: departmentsList, error: deptError } = useDepartmentsBySite(formData.siteId || '');
  const { data: systemsList } = useSystemsBySite(formData.siteId || '');
  const { data: suppliersData } = useSupplierList();
  const { sensors } = useSensors();
  const createEquipment = useCreateEquipment();
  const updateEquipment = useUpdateEquipment();
  const deleteEquipmentMutation = useDeleteEquipment();

  // Delete preview query
  const { data: deletePreview, isLoading: isPreviewLoading } = useEquipmentDeletePreview(
    equipmentToDelete?.id ?? null,
  );

  // Transform backend preview to dialog format
  const dialogPreview = useMemo((): DeletePreviewData | null => {
    if (!deletePreview) return null;

    const affectedItems: AffectedItemGroup[] = [];

    if (deletePreview.affectedItems.childEquipment.length > 0) {
      affectedItems.push({
        type: 'childEquipment',
        label: 'Alt Ekipmanlar',
        items: deletePreview.affectedItems.childEquipment.map((e) => ({
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
        items: deletePreview.affectedItems.subEquipment.map((e) => ({
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
      (type) => normalizeCategory(type.category) === formData.selectedCategory,
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
    return selectedEquipmentType.specificationSchema;
  }, [selectedEquipmentType]);

  // Check if current type is a feeder (for calibration section)
  const isFeederType = useMemo(() => {
    if (!selectedEquipmentType?.code) return false;
    return selectedEquipmentType.code.startsWith('feeder-');
  }, [selectedEquipmentType]);

  // Get equipment list from API or empty array. Memoized so the
  // filtered-list useMemo below keeps a stable dependency instead of a
  // fresh [] identity on every render.
  const equipment = useMemo(() => equipmentData?.items ?? [], [equipmentData]);

  // Count orphaned equipment (no system associations)
  const orphanedCount = equipment.filter(
    (eq) =>
      (!eq.systemIds || eq.systemIds.length === 0) && (!eq.systems || eq.systems.length === 0),
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

  // PERF-004: memoize to avoid re-running O(n) filter on unrelated state changes
  const filteredEquipment = useMemo(
    () =>
      equipment.filter((eq) => {
        const matchesSearch =
          eq.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          eq.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
          eq.serialNumber?.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesType = selectedType === 'all' || eq.equipmentType?.code === selectedType;
        const matchesStatus = selectedStatus === 'all' || eq.status === selectedStatus;
        const isOrphaned =
          (!eq.systemIds || eq.systemIds.length === 0) && (!eq.systems || eq.systems.length === 0);
        const matchesOrphanFilter = !showOrphanedOnly || isOrphaned;
        return matchesSearch && matchesType && matchesStatus && matchesOrphanFilter;
      }),
    [equipment, searchTerm, selectedType, selectedStatus, showOrphanedOnly],
  );

  // Get unique types for filter from equipment types API
  const types = (equipmentTypes || []).map((type) => ({
    value: type.code,
    label: type.name,
  }));

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
  const handleTypeChange = useCallback(
    (typeId: string) => {
      const selectedType = equipmentTypes?.find((t) => t.id === typeId);
      const schema = selectedType?.specificationSchema;
      const defaults = schema ? getDefaultSpecificationValues(schema) : {};

      setFormData((prev) => ({
        ...prev,
        equipmentTypeId: typeId,
        specifications: defaults,
      }));
    },
    [equipmentTypes],
  );

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
    const errors: Record<string, string> = {};
    if (!formData.siteId) errors.siteId = 'Please select a site.';
    if (!formData.departmentId) errors.departmentId = 'Please select a department.';
    if (!formData.equipmentTypeId) errors.equipmentTypeId = 'Please select an equipment type.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (formData.systemIds.length === 0) {
      toast({
        title: 'Validation Error',
        description: 'Please select at least one system.',
        variant: 'error',
      });
      return;
    }

    // Validate specifications
    if (specificationSchema) {
      const specErrors = validateSpecifications(specificationSchema, formData.specifications);
      if (Object.keys(specErrors).length > 0) {
        toast({
          title: 'Validation Error',
          description:
            'Please fill in all required specification fields: ' +
            Object.values(specErrors).join(', '),
          variant: 'error',
        });
        return;
      }
    }

    // Tank/Pond/Cage category: volume must be > 0
    const TANK_VOLUME_CATEGORIES = ['TANK', 'POND', 'CAGE'];
    if (TANK_VOLUME_CATEGORIES.includes(formData.selectedCategory ?? '')) {
      const specs = (formData.specifications || {}) as Record<string, unknown>;
      const volume = Number(specs.volume) || 0;
      const dims = specs.dimensions as Record<string, unknown> | undefined;
      const hasValidDimensions =
        dims &&
        ((Number(dims.diameter) > 0 && Number(dims.depth) > 0) ||
          (Number(dims.length) > 0 && Number(dims.width) > 0 && Number(dims.depth) > 0));
      if (volume <= 0 && !hasValidDimensions) {
        toast({
          title: 'Validation Error',
          description: "Tank hacmi 0'dan buyuk olmalidir veya gecerli boyutlar girilmelidir.",
          variant: 'error',
        });
        return;
      }
    }

    try {
      if (editingId) {
        await updateEquipment.mutateAsync({
          id: editingId,
          name: formData.name,
          code: formData.code,
          equipmentTypeId: formData.equipmentTypeId || undefined,
          departmentId: formData.departmentId || undefined,
          systemIds: formData.systemIds.length > 0 ? formData.systemIds : undefined,
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
          temperatureSensorId: formData.temperatureSensorId || undefined,
          specifications: formData.specifications,
        });
      } else {
        await createEquipment.mutateAsync({
          name: formData.name,
          code: formData.code,
          equipmentTypeId: formData.equipmentTypeId || undefined,
          departmentId: formData.departmentId || undefined,
          systemIds: formData.systemIds.length > 0 ? formData.systemIds : undefined,
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
          temperatureSensorId: formData.temperatureSensorId || undefined,
          specifications: formData.specifications,
        });
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setFieldErrors({});
      setEditingId(null);
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to save equipment:', err);
      toast({
        title: 'Error',
        description: 'Failed to save equipment. Please try again.',
        variant: 'error',
      });
    }
  };

  const handleEdit = (eq: Equipment) => {
    setEditingId(eq.id);
    // Get siteId from the equipment's department
    const siteId = eq.department?.siteId || '';
    // Get category from equipment type
    const category = normalizeCategory(eq.equipmentType?.category);
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
      temperatureSensorId: eq.temperatureSensorId || '',
      specifications: (eq.specifications as Record<string, unknown>) || {},
    });
    setIsModalOpen(true);
  };

  const handleSiteChange = (siteId: string) => {
    setFormData((prev) => ({
      ...prev,
      siteId,
      departmentId: '', // Reset department when site changes
      systemIds: [], // Reset systems when site changes
    }));
  };

  const handleDepartmentChange = (departmentId: string) => {
    setFormData((prev) => ({
      ...prev,
      departmentId,
    }));
  };

  const handleSystemToggle = (systemId: string) => {
    setFormData((prev) => ({
      ...prev,
      systemIds: prev.systemIds.includes(systemId)
        ? prev.systemIds.filter((id) => id !== systemId)
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
      if (import.meta.env.DEV) console.error('Failed to delete equipment:', err);
      toast({
        title: 'Error',
        description: 'Failed to delete equipment. Please try again.',
        variant: 'error',
      });
    }
  };

  const handleCloseDeleteDialog = () => {
    setDeleteDialogOpen(false);
    setEquipmentToDelete(null);
  };

  type EqRow = (typeof filteredEquipment)[number];
  const eqRowColumns: DataTableColumn<EqRow>[] = [
    {
      key: 'equipment',
      header: 'Equipment',
      render: (_value, eq) => (
        <>
          <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{eq.name}</div>
          <div className="text-sm text-gray-500 dark:text-gray-400">{eq.code}</div>
        </>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (_value, eq) => eq.equipmentType?.name || '-',
    },
    {
      key: 'location',
      header: 'Location',
      render: (_value, eq) => eq.department?.name || '-',
    },
    {
      key: 'systems',
      header: 'Systems',
      render: (_value, eq) => (
        <>
          {(eq.systemIds && eq.systemIds.length > 0) || (eq.systems && eq.systems.length > 0) ? (
            <span className="text-gray-500 dark:text-gray-400">
              {eq.systems?.map((s) => s.systemName).join(', ') ||
                `${eq.systemIds?.length || 0} system(s)`}
            </span>
          ) : (
            <span className="flex items-center text-error-600 dark:text-error-400">
              <TriangleAlert className="w-4 h-4 mr-1" aria-hidden="true" />
              Not associated
            </span>
          )}
        </>
      ),
    },
    {
      key: 'hierarchy',
      header: 'Hierarchy',
      render: (_value, eq) => (
        <>
          {eq.parentEquipment ? (
            <span
              className="flex items-center text-info-600 dark:text-info-400"
              title={`Parent: ${eq.parentEquipment.name}`}
            >
              <ArrowUp className="w-3 h-3 mr-1" aria-hidden="true" />
              {eq.parentEquipment.code}
            </span>
          ) : (eq.subEquipmentCount || 0) > 0 ? (
            <span
              className="flex items-center text-success-600 dark:text-success-400"
              title={`${eq.subEquipmentCount} sub-equipment`}
            >
              <ArrowDown className="w-3 h-3 mr-1" aria-hidden="true" />
              {eq.subEquipmentCount}
            </span>
          ) : (
            <span className="text-gray-400 dark:text-gray-500">-</span>
          )}
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, eq) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[eq.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
          >
            {eq.status}
          </span>
        </>
      ),
    },
    {
      key: 'model',
      header: 'Model',
      render: (_value, eq) => (
        <>
          {eq.manufacturer || ''} {eq.model || '-'}
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, eq) => (
        <>
          <Button variant="ghost" className="mr-3" onClick={() => handleEdit(eq)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => handleDelete(eq)}>
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
        <div className="flex flex-1 gap-4 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <input
              type="text"
              placeholder="Search equipment..."
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
            aria-label="Type filter"
            fullWidth={false}
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            options={[
              { value: 'all', label: 'All Types' },
              ...types.map((type) => ({ value: type.value, label: type.label })),
            ]}
          />
          <Select
            aria-label="Status filter"
            fullWidth={false}
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            options={[
              { value: 'all', label: 'All Status' },
              ...grouped(EQUIPMENT_STATUS_OPTIONS, 'Equipment'),
              ...grouped(TANK_STATUS_OPTIONS, 'Tank / Pond / Cage'),
            ]}
          />
          <label className="flex items-center text-sm text-gray-600 dark:text-gray-400 ml-2">
            <input
              type="checkbox"
              checked={showOrphanedOnly}
              onChange={(e) => setShowOrphanedOnly(e.target.checked)}
              className="mr-2 rounded border-gray-300 dark:border-gray-600 text-info-600 focus:ring-info-500"
            />
            Orphaned only
          </label>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
            <ToggleButton
              onClick={() => setViewMode('grid')}
              pressed={viewMode === 'grid'}
              className="px-3 py-2"
              pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-600 dark:text-info-400"
              idleClassName="text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <LayoutGrid className="w-5 h-5" aria-hidden="true" />
            </ToggleButton>
            <ToggleButton
              onClick={() => setViewMode('table')}
              pressed={viewMode === 'table'}
              className="px-3 py-2"
              pressedClassName="bg-info-50 dark:bg-info-900/20 text-info-600 dark:text-info-400"
              idleClassName="text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </ToggleButton>
          </div>
          <Button
            variant="primary"
            onClick={() => {
              setEditingId(null);
              setFormData(initialFormData);
              setFieldErrors({});
              setIsModalOpen(true);
            }}
          >
            <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
            Add Equipment
          </Button>
        </div>
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
            Failed to load equipment. Please try again.
          </p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Orphan Warning Notice */}
      {!isLoading && !error && orphanedCount > 0 && (
        <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-lg flex items-center">
          <TriangleAlert className="w-5 h-5 text-error-500 mr-2 flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-error-700 dark:text-error-300">
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
                  ? 'bg-white dark:bg-gray-900 border-info-500'
                  : 'bg-error-50 dark:bg-error-900/20 border-error-500'
              }`}
            >
              <div className="p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center">
                    <div className="w-10 h-10 bg-info-100 dark:bg-info-900/40 rounded-lg flex items-center justify-center mr-3">
                      <EquipmentTypeIcon type={eq.equipmentType} />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                        {eq.name}
                      </h3>
                      <p className="text-sm text-gray-500 dark:text-gray-400">{eq.code}</p>
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusColors[eq.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                  >
                    {eq.status}
                  </span>
                </div>

                <div className="space-y-2 text-sm mb-4">
                  <div className="flex items-center text-gray-600 dark:text-gray-400">
                    <span className="text-gray-400 dark:text-gray-500 w-24">Type:</span>
                    <span className="font-medium">{eq.equipmentType?.name || '-'}</span>
                  </div>
                  <div className="flex items-center text-gray-600 dark:text-gray-400">
                    <span className="text-gray-400 dark:text-gray-500 w-24">Location:</span>
                    <span>{eq.department?.name || '-'}</span>
                  </div>
                  {/* System Association */}
                  {(eq.systemIds && eq.systemIds.length > 0) ||
                  (eq.systems && eq.systems.length > 0) ? (
                    <div className="flex items-center text-gray-600 dark:text-gray-400">
                      <span className="text-gray-400 dark:text-gray-500 w-24">Systems:</span>
                      <span className="text-sm">
                        {eq.systems?.map((s) => s.systemName).join(', ') ||
                          `${eq.systemIds?.length || 0} system(s)`}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center text-error-600 dark:text-error-400">
                      <TriangleAlert className="w-4 h-4 mr-1 text-error-400" aria-hidden="true" />
                      <span className="text-sm font-medium">Not associated with any system</span>
                    </div>
                  )}
                  <div className="flex items-center text-gray-600 dark:text-gray-400">
                    <span className="text-gray-400 dark:text-gray-500 w-24">Model:</span>
                    <span>
                      {eq.manufacturer || ''} {eq.model || '-'}
                    </span>
                  </div>
                  {/* Parent Equipment */}
                  {eq.parentEquipment && (
                    <div className="flex items-center text-gray-600 dark:text-gray-400">
                      <span className="text-gray-400 dark:text-gray-500 w-24">Parent:</span>
                      <span className="flex items-center">
                        <ArrowUp className="w-3 h-3 mr-1 text-info-500" aria-hidden="true" />
                        {eq.parentEquipment.name}
                      </span>
                    </div>
                  )}
                  {/* Auto Filling Badge for feeders */}
                  {eq.equipmentType?.code?.startsWith('feeder-') &&
                    !!(eq.specifications as Record<string, unknown>)?.autoFilling && (
                      <div className="flex items-center">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200">
                          Auto Fill
                        </span>
                      </div>
                    )}
                  {/* Sub Equipment Count */}
                  {(eq.subEquipmentCount || 0) > 0 && (
                    <div className="flex items-center text-gray-600 dark:text-gray-400">
                      <span className="text-gray-400 dark:text-gray-500 w-24">Sub-equip:</span>
                      <span className="flex items-center text-info-600 dark:text-info-400">
                        <ArrowDown className="w-3 h-3 mr-1" aria-hidden="true" />
                        {eq.subEquipmentCount} item(s)
                      </span>
                    </div>
                  )}
                </div>

                {/* Specifications */}
                {eq.specifications && Object.keys(eq.specifications).length > 0 && (
                  <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
                    <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                      Specifications
                    </h4>
                    <div className="space-y-1">{renderSpecifications(eq.specifications)}</div>
                  </div>
                )}
              </div>

              <div className="px-6 py-3 bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 rounded-b-lg flex justify-between items-center">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {eq.warrantyEndDate
                    ? `Warranty: ${new Date(eq.warrantyEndDate).toLocaleDateString()}`
                    : 'No warranty info'}
                </span>
                <div className="flex space-x-2">
                  <Button variant="ghost" onClick={() => handleEdit(eq)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => handleDelete(eq)}>
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Equipment Table View */}
      {!isLoading && !error && viewMode === 'table' && (
        <DataTable<EqRow>
          data={filteredEquipment}
          columns={eqRowColumns}
          keyExtractor={(eq) => eq.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}

      {/* Empty State */}
      {!isLoading && !error && filteredEquipment.length === 0 && (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <Settings
            className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
            aria-hidden="true"
          />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No equipment found
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Get started by adding equipment to your farm.
          </p>
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Equipment' : 'Add Equipment'}
        size="lg"
      >
        <form onSubmit={handleSubmit}>
          <div className="max-h-[70vh] overflow-y-auto">
            <div className="space-y-6">
              {/* General Information Section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
                  General Information
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Name *
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      required
                      value={formData.name}
                      onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Code *
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      required
                      value={formData.code}
                      onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                    />
                  </div>
                </div>

                {/* Two-stage type selection */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <Select
                    label="Category"
                    required
                    placeholder="Select Category..."
                    value={formData.selectedCategory}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    options={EQUIPMENT_CATEGORIES.map((cat) => ({
                      value: cat.value,
                      label: cat.label,
                    }))}
                  />
                  <Select
                    label="Type"
                    required
                    placeholder={
                      formData.selectedCategory ? 'Select Type...' : 'Select category first...'
                    }
                    value={formData.equipmentTypeId}
                    onChange={(e) => handleTypeChange(e.target.value)}
                    disabled={!formData.selectedCategory}
                    error={formData.equipmentTypeId ? undefined : fieldErrors.equipmentTypeId}
                    options={filteredTypesByCategory.map((type) => ({
                      value: type.id,
                      label: type.name,
                    }))}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <Select
                    label="Status"
                    required
                    value={formData.status}
                    onChange={(e) => setFormData((prev) => ({ ...prev, status: e.target.value }))}
                    options={[
                      ...grouped(EQUIPMENT_STATUS_OPTIONS, 'General'),
                      ...(TANK_CATEGORIES.includes(formData.selectedCategory)
                        ? grouped(TANK_STATUS_OPTIONS, 'Tank / Pond / Cage')
                        : []),
                    ]}
                  />
                  <div>
                    <Select
                      label="Supplier"
                      value={formData.supplierId}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, supplierId: e.target.value }))
                      }
                      options={[
                        { value: '', label: 'Select Supplier...' },
                        ...suppliers.map((sup) => ({ value: sup.id, label: sup.name })),
                      ]}
                    />
                  </div>
                </div>
              </div>

              {/* Location Section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
                  Location
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Select
                    label="Site"
                    required
                    placeholder="Select Site..."
                    value={formData.siteId}
                    onChange={(e) => handleSiteChange(e.target.value)}
                    error={formData.siteId ? undefined : fieldErrors.siteId}
                    options={sites.map((site) => ({ value: site.id, label: site.name }))}
                  />
                  <div>
                    <Select
                      label="Department"
                      required
                      placeholder={
                        deptError
                          ? 'Departmanlar yüklenemedi'
                          : !formData.siteId
                            ? 'Önce site seçin...'
                            : departments.length === 0
                              ? 'Bu site için departman bulunamadı'
                              : 'Departman seçin...'
                      }
                      value={formData.departmentId}
                      onChange={(e) => handleDepartmentChange(e.target.value)}
                      disabled={!formData.siteId}
                      error={formData.departmentId ? undefined : fieldErrors.departmentId}
                      options={departments.map((dept) => ({ value: dept.id, label: dept.name }))}
                    />
                    {deptError && (
                      <p className="text-xs text-error-500 mt-1">
                        Departmanlar yüklenirken hata oluştu
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Systems *{' '}
                    <span className="text-gray-400 dark:text-gray-500 text-xs font-normal">
                      (Select all systems this equipment serves)
                    </span>
                  </label>
                  {!formData.siteId ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      Select a site first...
                    </p>
                  ) : systems.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      No systems available for this site
                    </p>
                  ) : (
                    <div className="max-h-32 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-md p-2 space-y-1">
                      {systems.map((sys) => (
                        <label
                          key={sys.id}
                          className={`flex items-center p-2 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 ${
                            formData.systemIds.includes(sys.id)
                              ? 'bg-info-50 dark:bg-info-900/20 border border-info-200 dark:border-info-800'
                              : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={formData.systemIds.includes(sys.id)}
                            onChange={() => handleSystemToggle(sys.id)}
                            className="w-4 h-4 text-info-600 border-gray-300 dark:border-gray-600 rounded focus:ring-info-500"
                          />
                          <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                            {sys.name}
                          </span>
                          <span className="ml-auto text-xs text-gray-400 dark:text-gray-500">
                            {sys.code}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {formData.systemIds.length > 0 && (
                    <p className="mt-1 text-xs text-info-600 dark:text-info-400">
                      {formData.systemIds.length} system(s) selected
                    </p>
                  )}
                </div>
              </div>

              {/* Hierarchy Section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
                  Hierarchy
                </h4>
                <Select
                  label="Parent Equipment"
                  value={formData.parentEquipmentId}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, parentEquipmentId: e.target.value }))
                  }
                  helperText="Optional. Select if this equipment is a sub-component of another equipment."
                  options={[
                    { value: '', label: 'None (Root Equipment)' },
                    ...availableParentEquipment.map((eq) => ({
                      value: eq.id,
                      label: `${eq.name} (${eq.code}) - ${eq.equipmentType?.name}`,
                    })),
                  ]}
                />

                {/* Show current child equipment when editing */}
                {editingId &&
                equipment.find((eq) => eq.id === editingId)?.childEquipment?.length ? (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                      Sub-Equipment
                    </label>
                    <div className="border border-gray-200 dark:border-gray-700 rounded-md p-3 bg-gray-50 dark:bg-gray-800">
                      <div className="space-y-2">
                        {equipment
                          .find((eq) => eq.id === editingId)
                          ?.childEquipment?.map((child) => (
                            <div
                              key={child.id}
                              className="flex items-center justify-between text-sm"
                            >
                              <span className="flex items-center">
                                <ChevronRight
                                  className="w-4 h-4 text-gray-400 dark:text-gray-500 mr-2"
                                  aria-hidden="true"
                                />
                                {child.name} ({child.code})
                              </span>
                              <span
                                className={`px-2 py-0.5 text-xs rounded-full ${statusColors[child.status] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                              >
                                {child.status}
                              </span>
                            </div>
                          ))}
                      </div>
                      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                        To add sub-equipment, edit or create equipment and set this equipment as
                        their parent.
                      </p>
                    </div>
                  </div>
                ) : null}

                {editingId && (
                  <SubEquipmentSection
                    parentEquipmentId={editingId}
                    parentEquipmentTypeCode={
                      equipment.find((eq) => eq.id === editingId)?.equipmentType?.code
                    }
                  />
                )}
              </div>

              {/* Details Section */}
              <div>
                <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
                  Details
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Manufacturer
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.manufacturer}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, manufacturer: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Model
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.model}
                      onChange={(e) => setFormData((prev) => ({ ...prev, model: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Serial Number
                    </label>
                    <Input
                      fullWidth
                      type="text"
                      value={formData.serialNumber}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, serialNumber: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Purchase Date
                    </label>
                    <Input
                      fullWidth
                      type="date"
                      value={formData.purchaseDate}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, purchaseDate: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Warranty Expiry
                    </label>
                    <Input
                      fullWidth
                      type="date"
                      value={formData.warrantyEndDate}
                      onChange={(e) =>
                        setFormData((prev) => ({ ...prev, warrantyEndDate: e.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Technical Specifications Section */}
              {formData.equipmentTypeId && specificationSchema && (
                <div>
                  <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
                    Technical Specifications - {selectedEquipmentType?.name}
                  </h4>
                  <DynamicSpecificationForm
                    schema={specificationSchema}
                    values={formData.specifications}
                    onChange={handleSpecificationsChange}
                  />
                </div>
              )}

              {/* Feeder Calibration Section (edit mode only) */}
              {editingId && isFeederType && <FeederCalibrationSection equipmentId={editingId} />}

              {/* Temperature Sensor (tank / pond / cage only) — links a
                  sensor-service sensor whose live temperature drives the
                  tank's feed-rate calculation. */}
              {TANK_CATEGORIES.includes(formData.selectedCategory) && (
                <div>
                  <Select
                    label="Temperature Sensor"
                    value={formData.temperatureSensorId}
                    onChange={(e) =>
                      setFormData((prev) => ({ ...prev, temperatureSensorId: e.target.value }))
                    }
                    helperText="Optional. Links a sensor whose live temperature drives this tank's feed-rate calculation."
                    options={[
                      { value: '', label: 'No sensor' },
                      ...sensors.map((sensor) => ({
                        value: sensor.id,
                        label: `${sensor.name} (${sensor.type})`,
                      })),
                    ]}
                  />
                </div>
              )}

              {/* Options */}
              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isVisibleInSensor"
                  checked={formData.isVisibleInSensor}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, isVisibleInSensor: e.target.checked }))
                  }
                  className="w-4 h-4 text-info-600 border-gray-300 dark:border-gray-600 rounded focus:ring-info-500"
                />
                <label
                  htmlFor="isVisibleInSensor"
                  className="text-sm text-gray-700 dark:text-gray-300"
                >
                  Show in Sensor Module (Process Editor)
                </label>
              </div>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 sm:flex sm:flex-row-reverse">
            <Button
              variant="primary"
              size="lg"
              className="justify-center sm:ml-3 sm:w-auto sm:text-sm"
              type="submit"
            >
              {editingId ? 'Update Equipment' : 'Save Equipment'}
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
