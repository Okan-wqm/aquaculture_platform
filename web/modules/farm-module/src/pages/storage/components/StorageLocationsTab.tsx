/**
 * Storage Locations Tab - CRUD for warehouse/silo/cold room locations
 */
import React, { useState } from 'react';
import {
  FormField,
  Modal,
  useConfirm,
  useToast,
  Spinner,
  Button,
  Input,
  Select,
  Textarea,
} from '@aquaculture/shared-ui';
import {
  useStorageLocationList,
  useCreateStorageLocation,
  useUpdateStorageLocation,
  useDeleteStorageLocation,
  StorageLocation,
  StorageLocationType,
  CreateStorageLocationInput,
} from '../../../hooks/useStorageLocations';
import { useSiteList } from '../../../hooks/useSites';
import { Plus } from 'lucide-react';

const typeColors: Record<string, string> = {
  WAREHOUSE: 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200',
  COLD_ROOM: 'bg-blue-100 text-blue-800',
  CHEMICAL_STORE: 'bg-orange-100 text-orange-800',
  FEED_SILO: 'bg-amber-100 text-amber-800',
  OUTDOOR: 'bg-green-100 text-green-800',
  HAZMAT: 'bg-red-100 text-red-800',
};

const typeLabels: Record<string, string> = {
  WAREHOUSE: 'Warehouse',
  COLD_ROOM: 'Cold Room',
  CHEMICAL_STORE: 'Chemical Store',
  FEED_SILO: 'Feed Silo',
  OUTDOOR: 'Outdoor',
  HAZMAT: 'Hazmat',
};

const LOCATION_TYPES: StorageLocationType[] = [
  StorageLocationType.WAREHOUSE,
  StorageLocationType.COLD_ROOM,
  StorageLocationType.CHEMICAL_STORE,
  StorageLocationType.FEED_SILO,
  StorageLocationType.OUTDOOR,
  StorageLocationType.HAZMAT,
];

interface FormData {
  siteId: string;
  name: string;
  code: string;
  type: StorageLocationType;
  description: string;
  capacity: number | '';
  capacityUnit: string;
  temperatureMin: number | '';
  temperatureMax: number | '';
  humidityMin: number | '';
  humidityMax: number | '';
}

const emptyForm: FormData = {
  siteId: '',
  name: '',
  code: '',
  type: StorageLocationType.WAREHOUSE,
  description: '',
  capacity: '',
  capacityUnit: 'm³',
  temperatureMin: '',
  temperatureMax: '',
  humidityMin: '',
  humidityMax: '',
};

export const StorageLocationsTab: React.FC = () => {
  const { data: locationsData, isLoading, error, refetch } = useStorageLocationList();
  const { data: sitesData } = useSiteList();
  const sites = sitesData?.items || [];
  const createLocation = useCreateStorageLocation();
  const updateLocation = useUpdateStorageLocation();
  const deleteLocationMutation = useDeleteStorageLocation();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);
  // FE-HIGH-086: required-field misses land on the field, not in a toast.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const locations = locationsData?.items || [];

  const openCreate = () => {
    setEditingId(null);
    setFormData(emptyForm);
    setFieldErrors({});
    setIsModalOpen(true);
  };
  const openEdit = (loc: StorageLocation) => {
    setEditingId(loc.id);
    setFormData({
      siteId: loc.siteId || '',
      name: loc.name,
      code: loc.code,
      type: loc.type as StorageLocationType,
      description: loc.description || '',
      capacity: loc.capacity ?? '',
      capacityUnit: loc.capacityUnit || 'm³',
      temperatureMin: loc.temperatureMin ?? '',
      temperatureMax: loc.temperatureMax ?? '',
      humidityMin: loc.humidityMin ?? '',
      humidityMax: loc.humidityMax ?? '',
    });
    setIsModalOpen(true);
  };

  const confirm = useConfirm();
  const { toast } = useToast();
  const handleDelete = async (id: string) => {
    if (
      await confirm({
        title: 'Delete this location?',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'danger',
      })
    ) {
      try {
        await deleteLocationMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete location:', err);
        toast({ title: 'Failed to delete location.', variant: 'error' });
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: Record<string, string> = {};
    if (!formData.name) errors.name = 'Please enter a name.';
    if (!formData.code) errors.code = 'Please enter a code.';
    if (!formData.siteId) errors.siteId = 'Please select a site.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    try {
      const input: any = {
        siteId: formData.siteId,
        name: formData.name,
        code: formData.code,
        type: formData.type,
        description: formData.description || undefined,
        capacity: formData.capacity !== '' ? Number(formData.capacity) : undefined,
        capacityUnit: formData.capacityUnit,
        temperatureMin:
          formData.temperatureMin !== '' ? Number(formData.temperatureMin) : undefined,
        temperatureMax:
          formData.temperatureMax !== '' ? Number(formData.temperatureMax) : undefined,
        humidityMin: formData.humidityMin !== '' ? Number(formData.humidityMin) : undefined,
        humidityMax: formData.humidityMax !== '' ? Number(formData.humidityMax) : undefined,
      };

      if (editingId) {
        await updateLocation.mutateAsync({ id: editingId, ...input });
      } else {
        await createLocation.mutateAsync(input as CreateStorageLocationInput);
      }
      setIsModalOpen(false);
    } catch (err) {
      console.error('Failed to save location:', err);
      toast({ title: 'Failed to save location.', variant: 'error' });
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
          {locations.length} locations
        </h3>
        <Button variant="primary" onClick={openCreate}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Location
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load locations.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !error && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {locations.map((loc) => {
            const usagePercent =
              loc.capacity && loc.capacity > 0
                ? Math.round((loc.usedCapacity / loc.capacity) * 100)
                : 0;
            return (
              <div
                key={loc.id}
                className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-5"
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                      {loc.name}
                    </h4>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{loc.code}</span>
                  </div>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeColors[loc.type] || 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'}`}
                  >
                    {typeLabels[loc.type] || loc.type}
                  </span>
                </div>
                <div className="mb-3">
                  <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                    <span>Capacity</span>
                    <span>
                      {loc.usedCapacity} / {loc.capacity || 0} {loc.capacityUnit}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.min(usagePercent, 100)}%` }}
                    />
                  </div>
                  <div className="text-right text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                    {usagePercent}%
                  </div>
                </div>
                {(loc.temperatureMin != null || loc.temperatureMax != null) && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Temp: {loc.temperatureMin ?? '-'}°C - {loc.temperatureMax ?? '-'}°C
                    {(loc.humidityMin != null || loc.humidityMax != null) &&
                      ` | Humidity: ${loc.humidityMin ?? '-'}% - ${loc.humidityMax ?? '-'}%`}
                  </div>
                )}
                {loc.description && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{loc.description}</p>
                )}
                <div className="flex gap-2 pt-2 border-t border-gray-100 dark:border-gray-700">
                  <Button variant="ghost" size="xs" onClick={() => openEdit(loc)}>
                    Edit
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => handleDelete(loc.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            );
          })}
          {locations.length === 0 && (
            <div className="col-span-3 text-center py-12 text-gray-500 dark:text-gray-400 text-sm">
              No storage locations found. Add your first location.
            </div>
          )}
        </div>
      )}

      {/* Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Location' : 'Add Location'}
        size="sm"
      >
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Name *
                </label>
                <FormField error={formData.name ? undefined : fieldErrors.name} className="mb-0">
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
                <FormField error={formData.code ? undefined : fieldErrors.code} className="mb-0">
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
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Type
                </label>
                <select
                  value={formData.type}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      type: e.target.value as StorageLocationType,
                    }))
                  }
                  className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                >
                  {LOCATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {typeLabels[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Site *
                </label>
                <FormField
                  error={formData.siteId ? undefined : fieldErrors.siteId}
                  className="mb-0"
                >
                  <select
                    required
                    value={formData.siteId}
                    onChange={(e) => setFormData((prev) => ({ ...prev, siteId: e.target.value }))}
                    className="mt-1 block w-full border border-gray-300 dark:border-gray-600 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="">Select Site</option>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </FormField>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Capacity
                </label>
                <Input
                  fullWidth
                  type="number"
                  min="0"
                  value={formData.capacity}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      capacity: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Unit
                </label>
                <Select
                  fullWidth
                  options={[
                    { value: 'm³', label: 'm³' },
                    { value: 'kg', label: 'kg' },
                    { value: 'L', label: 'L' },
                    { value: 'tons', label: 'tons' },
                  ]}
                  value={formData.capacityUnit}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, capacityUnit: e.target.value }))
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Temp Min (°C)
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="0.1"
                  value={formData.temperatureMin}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      temperatureMin: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Temp Max (°C)
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="0.1"
                  value={formData.temperatureMax}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      temperatureMax: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Humidity Min (%)
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={formData.humidityMin}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      humidityMin: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Humidity Max (%)
                </label>
                <Input
                  fullWidth
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={formData.humidityMax}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      humidityMax: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Description
              </label>
              <Textarea
                fullWidth
                rows={2}
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
              />
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
            <Button variant="secondary" type="button" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit">
              {editingId ? 'Update' : 'Create'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default StorageLocationsTab;
