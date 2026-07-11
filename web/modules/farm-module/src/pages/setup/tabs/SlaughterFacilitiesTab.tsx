/**
 * Slaughter Facilities Tab
 *
 * Catalog for the slakt reports' godkjenningsnummer (facility approval number).
 * Replaces the single Report-Settings field: a tenant can register several
 * facilities and mark one default; the default feeds the server-side slakt
 * report assembler. The godkjenningsnummer format (1–6 alphanumeric) mirrors
 * the official Mattilsynet schema so an unusable number is rejected here, not
 * at submit time.
 */
import React, { useState } from 'react';
import { Modal } from '@aquaculture/shared-ui';

import {
  SlaughterFacility,
  CreateSlaughterFacilityInput,
  useSlaughterFacilities,
  useCreateSlaughterFacility,
  useUpdateSlaughterFacility,
} from '../../../hooks/useSlaughterFacilities';

const GODKJENNINGSNUMMER_PATTERN = /^[A-Za-z0-9]{1,6}$/;

interface FacilityFormData {
  name: string;
  godkjenningsnummer: string;
  isDefault: boolean;
  address: string;
}

const initialFormData: FacilityFormData = {
  name: '',
  godkjenningsnummer: '',
  isDefault: false,
  address: '',
};

export const SlaughterFacilitiesTab: React.FC = () => {
  const { data: facilities = [], isLoading, error, refetch } = useSlaughterFacilities(true);
  const createFacility = useCreateSlaughterFacility();
  const updateFacility = useUpdateSlaughterFacility();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FacilityFormData>(initialFormData);
  const [formError, setFormError] = useState<string | null>(null);

  const openAddModal = () => {
    setEditingId(null);
    setFormData(initialFormData);
    setFormError(null);
    setIsModalOpen(true);
  };

  const openEditModal = (facility: SlaughterFacility) => {
    setEditingId(facility.id);
    setFormData({
      name: facility.name,
      godkjenningsnummer: facility.godkjenningsnummer,
      isDefault: facility.isDefault,
      address: facility.address ?? '',
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!GODKJENNINGSNUMMER_PATTERN.test(formData.godkjenningsnummer)) {
      setFormError('Godkjenningsnummer must be 1–6 alphanumeric characters.');
      return;
    }

    try {
      if (editingId) {
        await updateFacility.mutateAsync({
          id: editingId,
          name: formData.name,
          godkjenningsnummer: formData.godkjenningsnummer,
          isDefault: formData.isDefault,
          address: formData.address || undefined,
        });
      } else {
        const input: CreateSlaughterFacilityInput = {
          name: formData.name,
          godkjenningsnummer: formData.godkjenningsnummer,
          isDefault: formData.isDefault,
          address: formData.address || undefined,
        };
        await createFacility.mutateAsync(input);
      }
      setIsModalOpen(false);
      setFormData(initialFormData);
      setEditingId(null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to save facility. Please try again.';
      setFormError(message);
    }
  };

  const toggleActive = async (facility: SlaughterFacility) => {
    try {
      await updateFacility.mutateAsync({ id: facility.id, isActive: !facility.isActive });
    } catch {
      // Surfaced by the list refetch / mutation error boundary; a failed
      // toggle simply leaves the row unchanged.
    }
  };

  const pending = createFacility.isPending || updateFacility.isPending;

  return (
    <div>
      {/* Toolbar */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Slaughter Facilities</h2>
          <p className="mt-1 text-sm text-gray-500">
            Approval numbers (godkjenningsnummer) for the Mattilsynet slaughter reports. The default
            facility is used automatically when assembling the report.
          </p>
        </div>
        <button
          onClick={openAddModal}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
        >
          <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v6m0 0v6m0-6h6m-6 0H6"
            />
          </svg>
          Add Facility
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-red-50 rounded-lg border border-red-200">
          <p className="text-red-600">Failed to load slaughter facilities.</p>
          <button onClick={() => refetch()} className="mt-2 text-blue-600 hover:underline">
            Retry
          </button>
        </div>
      )}

      {!isLoading && !error && facilities.length === 0 && (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <h3 className="mt-2 text-sm font-medium text-gray-900">No slaughter facilities yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            Add a facility with its godkjenningsnummer so the slaughter reports can be assembled.
          </p>
        </div>
      )}

      {!isLoading && !error && facilities.length > 0 && (
        <div className="overflow-hidden bg-white rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Godkjenningsnummer
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {facilities.map((facility) => (
                <tr key={facility.id} className={facility.isActive ? '' : 'bg-gray-50'}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{facility.name}</span>
                      {facility.isDefault && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          Default
                        </span>
                      )}
                    </div>
                    {facility.address && (
                      <div className="text-xs text-gray-400">{facility.address}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
                    {facility.godkjenningsnummer}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        facility.isActive
                          ? 'bg-green-100 text-green-800'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {facility.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-3">
                    <button
                      onClick={() => openEditModal(facility)}
                      className="text-blue-600 hover:text-blue-800"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => toggleActive(facility)}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      {facility.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Slaughter Facility' : 'Add Slaughter Facility'}
        size="md"
      >
        <form onSubmit={handleSubmit}>
          {formError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-700">{formError}</p>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Name *</label>
              <input
                type="text"
                required
                maxLength={150}
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g., Nordfjord Slakteri AS"
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Godkjenningsnummer *
              </label>
              <input
                type="text"
                required
                maxLength={6}
                value={formData.godkjenningsnummer}
                onChange={(e) =>
                  setFormData((prev) => ({
                    ...prev,
                    godkjenningsnummer: e.target.value.toUpperCase(),
                  }))
                }
                placeholder="e.g., M12345"
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 uppercase font-mono focus:outline-hidden focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Official approval number, 1–6 alphanumeric characters. Required for slaughter
                reports.
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Address</label>
              <input
                type="text"
                maxLength={255}
                value={formData.address}
                onChange={(e) => setFormData((prev) => ({ ...prev, address: e.target.value }))}
                className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.isDefault}
                onChange={(e) => setFormData((prev) => ({ ...prev, isDefault: e.target.checked }))}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">
                Use as the default facility for slaughter reports
              </span>
            </label>
          </div>

          <div className="mt-6 pt-4 border-t border-gray-200 sm:flex sm:flex-row-reverse">
            <button
              type="submit"
              disabled={pending}
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
            >
              {editingId ? 'Update' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setIsModalOpen(false)}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:mt-0 sm:ml-3 sm:w-auto sm:text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

export default SlaughterFacilitiesTab;
