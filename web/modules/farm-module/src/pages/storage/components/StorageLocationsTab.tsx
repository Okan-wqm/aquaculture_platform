/**
 * Storage Locations Tab - CRUD for warehouse/silo/cold room locations
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';
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

const typeColors: Record<string, string> = {
  WAREHOUSE: 'bg-gray-100 text-gray-800',
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

  const locations = locationsData?.items || [];

  const openCreate = () => {
    setEditingId(null);
    setFormData(emptyForm);
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

  const handleDelete = async (id: string) => {
    if (confirm('Delete this location?')) {
      try {
        await deleteLocationMutation.mutateAsync(id);
      } catch (err) {
        console.error('Failed to delete location:', err);
        alert('Failed to delete location.');
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code) {
      alert('Name and code required.');
      return;
    }
    if (!formData.siteId) {
      alert('Please select a site.');
      return;
    }

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
      alert('Failed to save location.');
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-medium text-gray-500">{locations.length} locations</h3>
        <button
          onClick={openCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Location
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load locations.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
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
              <div key={loc.id} className="bg-white rounded-lg border border-gray-200 p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-900">{loc.name}</h4>
                    <span className="text-xs text-gray-500">{loc.code}</span>
                  </div>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeColors[loc.type] || 'bg-gray-100 text-gray-800'}`}
                  >
                    {typeLabels[loc.type] || loc.type}
                  </span>
                </div>
                <div className="mb-3">
                  <div className="flex justify-between text-xs text-gray-500 mb-1">
                    <span>Capacity</span>
                    <span>
                      {loc.usedCapacity} / {loc.capacity || 0} {loc.capacityUnit}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.min(usagePercent, 100)}%` }}
                    />
                  </div>
                  <div className="text-right text-xs text-gray-400 mt-0.5">{usagePercent}%</div>
                </div>
                {(loc.temperatureMin != null || loc.temperatureMax != null) && (
                  <div className="text-xs text-gray-500 mb-2">
                    Temp: {loc.temperatureMin ?? '-'}°C - {loc.temperatureMax ?? '-'}°C
                    {(loc.humidityMin != null || loc.humidityMax != null) &&
                      ` | Humidity: ${loc.humidityMin ?? '-'}% - ${loc.humidityMax ?? '-'}%`}
                  </div>
                )}
                {loc.description && <p className="text-xs text-gray-500 mb-3">{loc.description}</p>}
                <div className="flex gap-2 pt-2 border-t border-gray-100">
                  <button
                    onClick={() => openEdit(loc)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(loc.id)}
                    className="text-xs text-red-600 hover:text-red-800"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
          {locations.length === 0 && (
            <div className="col-span-3 text-center py-12 text-gray-500 text-sm">
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Name *</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Code *</label>
                <input
                  type="text"
                  required
                  value={formData.code}
                  onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value }))}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Type</label>
                <select
                  value={formData.type}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      type: e.target.value as StorageLocationType,
                    }))
                  }
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                >
                  {LOCATION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {typeLabels[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Site *</label>
                <select
                  required
                  value={formData.siteId}
                  onChange={(e) => setFormData((prev) => ({ ...prev, siteId: e.target.value }))}
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select Site</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Capacity</label>
                <input
                  type="number"
                  min="0"
                  value={formData.capacity}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      capacity: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Unit</label>
                <select
                  value={formData.capacityUnit}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, capacityUnit: e.target.value }))
                  }
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="m³">m³</option>
                  <option value="kg">kg</option>
                  <option value="L">L</option>
                  <option value="tons">tons</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Temp Min (°C)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.temperatureMin}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      temperatureMin: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Temp Max (°C)</label>
                <input
                  type="number"
                  step="0.1"
                  value={formData.temperatureMax}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      temperatureMax: e.target.value ? Number(e.target.value) : '',
                    }))
                  }
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Humidity Min (%)</label>
                <input
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
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Humidity Max (%)</label>
                <input
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
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Description</label>
              <textarea
                rows={2}
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
            >
              {editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default StorageLocationsTab;
