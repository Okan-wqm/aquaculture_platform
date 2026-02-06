/**
 * Storage Locations Tab - CRUD for warehouse/silo/cold room locations
 */
import React, { useState } from 'react';
import { storageLocations as initialLocations } from '../mock';
import type { StorageLocation, StorageLocationType } from '../types/storage.types';

const typeColors: Record<string, string> = {
  WAREHOUSE: 'bg-gray-100 text-gray-800',
  COLD_ROOM: 'bg-blue-100 text-blue-800',
  CHEMICAL_STORE: 'bg-orange-100 text-orange-800',
  FEED_SILO: 'bg-amber-100 text-amber-800',
  OUTDOOR: 'bg-green-100 text-green-800',
  HAZMAT: 'bg-red-100 text-red-800',
};

const typeLabels: Record<string, string> = {
  WAREHOUSE: 'Warehouse', COLD_ROOM: 'Cold Room', CHEMICAL_STORE: 'Chemical Store',
  FEED_SILO: 'Feed Silo', OUTDOOR: 'Outdoor', HAZMAT: 'Hazmat',
};

const LOCATION_TYPES: StorageLocationType[] = ['WAREHOUSE', 'COLD_ROOM', 'CHEMICAL_STORE', 'FEED_SILO', 'OUTDOOR', 'HAZMAT'];

type FormData = Omit<StorageLocation, 'id'>;
const emptyForm: FormData = {
  name: '', code: '', type: 'WAREHOUSE', capacity: 0, capacityUnit: 'm³',
  usedCapacity: 0, description: '', isActive: true, humidityControl: false,
};

export const StorageLocationsTab: React.FC = () => {
  const [locations, setLocations] = useState<StorageLocation[]>(initialLocations);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);

  const openCreate = () => { setEditingId(null); setFormData(emptyForm); setIsModalOpen(true); };
  const openEdit = (loc: StorageLocation) => {
    setEditingId(loc.id);
    const { id, ...rest } = loc;
    setFormData(rest);
    setIsModalOpen(true);
  };
  const handleDelete = (id: string) => {
    if (confirm('Delete this location?')) setLocations(prev => prev.filter(l => l.id !== id));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code) { alert('Name and code required.'); return; }
    if (editingId) {
      setLocations(prev => prev.map(l => l.id === editingId ? { ...formData, id: editingId } : l));
    } else {
      setLocations(prev => [...prev, { ...formData, id: Date.now().toString() }]);
    }
    setIsModalOpen(false);
  };

  const update = <K extends keyof FormData>(k: K, v: FormData[K]) => setFormData(prev => ({ ...prev, [k]: v }));

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <h3 className="text-sm font-medium text-gray-500">{locations.length} locations</h3>
        <button onClick={openCreate}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
          Add Location
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {locations.map(loc => {
          const usagePercent = loc.capacity > 0 ? Math.round((loc.usedCapacity / loc.capacity) * 100) : 0;
          return (
            <div key={loc.id} className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h4 className="text-sm font-semibold text-gray-900">{loc.name}</h4>
                  <span className="text-xs text-gray-500">{loc.code}</span>
                </div>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeColors[loc.type] || 'bg-gray-100 text-gray-800'}`}>
                  {typeLabels[loc.type] || loc.type}
                </span>
              </div>
              <div className="mb-3">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Capacity</span>
                  <span>{loc.usedCapacity} / {loc.capacity} {loc.capacityUnit}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full ${usagePercent > 90 ? 'bg-red-500' : usagePercent > 70 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                    style={{ width: `${Math.min(usagePercent, 100)}%` }}
                  />
                </div>
                <div className="text-right text-xs text-gray-400 mt-0.5">{usagePercent}%</div>
              </div>
              {(loc.temperatureMin !== undefined || loc.temperatureMax !== undefined) && (
                <div className="text-xs text-gray-500 mb-2">
                  Temp: {loc.temperatureMin}°C - {loc.temperatureMax}°C
                  {loc.humidityControl && ' | Humidity controlled'}
                </div>
              )}
              <p className="text-xs text-gray-500 mb-3">{loc.description}</p>
              <div className="flex gap-2 pt-2 border-t border-gray-100">
                <button onClick={() => openEdit(loc)} className="text-xs text-blue-600 hover:text-blue-800">Edit</button>
                <button onClick={() => handleDelete(loc.id)} className="text-xs text-red-600 hover:text-red-800">Delete</button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-lg shadow-xl sm:max-w-md sm:w-full max-h-[90vh] overflow-y-auto">
              <form onSubmit={handleSubmit}>
                <div className="px-6 pt-5 pb-4 space-y-4">
                  <h3 className="text-lg font-medium text-gray-900">{editingId ? 'Edit Location' : 'Add Location'}</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Name *</label>
                      <input type="text" required value={formData.name} onChange={e => update('name', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Code *</label>
                      <input type="text" required value={formData.code} onChange={e => update('code', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Type</label>
                    <select value={formData.type} onChange={e => update('type', e.target.value as StorageLocationType)}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
                      {LOCATION_TYPES.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Capacity</label>
                      <input type="number" min="0" value={formData.capacity} onChange={e => update('capacity', Number(e.target.value))}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Unit</label>
                      <select value={formData.capacityUnit} onChange={e => update('capacityUnit', e.target.value)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500">
                        <option value="m³">m³</option>
                        <option value="kg">kg</option>
                        <option value="L">L</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Used</label>
                      <input type="number" min="0" value={formData.usedCapacity} onChange={e => update('usedCapacity', Number(e.target.value))}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Temp Min (°C)</label>
                      <input type="number" value={formData.temperatureMin ?? ''} onChange={e => update('temperatureMin', e.target.value ? Number(e.target.value) : undefined)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Temp Max (°C)</label>
                      <input type="number" value={formData.temperatureMax ?? ''} onChange={e => update('temperatureMax', e.target.value ? Number(e.target.value) : undefined)}
                        className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={formData.humidityControl} onChange={e => update('humidityControl', e.target.checked)}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded" />
                    <span className="text-sm text-gray-700">Humidity Control</span>
                  </label>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Description</label>
                    <textarea rows={2} value={formData.description} onChange={e => update('description', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500" />
                  </div>
                </div>
                <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
                  <button type="button" onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50">Cancel</button>
                  <button type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">{editingId ? 'Update' : 'Create'}</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StorageLocationsTab;
