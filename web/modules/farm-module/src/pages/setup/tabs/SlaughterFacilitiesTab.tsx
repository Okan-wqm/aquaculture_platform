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
import {
  Button,
  Checkbox,
  DataTable,
  Input,
  Modal,
  Spinner,
  type DataTableColumn,
} from '@aquaculture/shared-ui';

import {
  SlaughterFacility,
  CreateSlaughterFacilityInput,
  useSlaughterFacilities,
  useCreateSlaughterFacility,
  useUpdateSlaughterFacility,
} from '../../../hooks/useSlaughterFacilities';
import { Plus } from 'lucide-react';

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

  type FacilityRow = (typeof facilities)[number];
  const facilityRowColumns: DataTableColumn<FacilityRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (_value, facility) => (
        <>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {facility.name}
            </span>
            {facility.isDefault && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-info-100 dark:bg-info-900/40 text-info-800 dark:text-info-200">
                Default
              </span>
            )}
          </div>
          {facility.address && (
            <div className="text-xs text-gray-400 dark:text-gray-500">{facility.address}</div>
          )}
        </>
      ),
    },
    {
      key: 'godkjenningsnummer',
      header: 'Godkjenningsnummer',
      render: (_value, facility) => facility.godkjenningsnummer,
    },
    {
      key: 'status',
      header: 'Status',
      render: (_value, facility) => (
        <>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              facility.isActive
                ? 'bg-success-100 dark:bg-success-900/40 text-success-800 dark:text-success-200'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
            }`}
          >
            {facility.isActive ? 'Active' : 'Inactive'}
          </span>
        </>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (_value, facility) => (
        <>
          <Button variant="ghost" onClick={() => openEditModal(facility)}>
            Edit
          </Button>
          <Button variant="ghost" onClick={() => toggleActive(facility)}>
            {facility.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        </>
      ),
    },
  ];

  return (
    <div>
      {/* Toolbar */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Slaughter Facilities
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Approval numbers (godkjenningsnummer) for the Mattilsynet slaughter reports. The default
            facility is used automatically when assembling the report.
          </p>
        </div>
        <Button variant="primary" onClick={openAddModal}>
          <Plus className="w-5 h-5 mr-2" aria-hidden="true" />
          Add Facility
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <Spinner size="lg" />
        </div>
      )}

      {error && (
        <div className="text-center py-12 bg-error-50 dark:bg-error-900/20 rounded-lg border border-error-200 dark:border-error-800">
          <p className="text-error-600 dark:text-error-400">Failed to load slaughter facilities.</p>
          <Button variant="ghost" className="mt-2" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !error && facilities.length === 0 && (
        <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            No slaughter facilities yet
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Add a facility with its godkjenningsnummer so the slaughter reports can be assembled.
          </p>
        </div>
      )}

      {!isLoading && !error && facilities.length > 0 && (
        <DataTable<FacilityRow>
          data={facilities}
          columns={facilityRowColumns}
          keyExtractor={(facility) => facility.id}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingId ? 'Edit Slaughter Facility' : 'Add Slaughter Facility'}
        size="md"
      >
        <form onSubmit={handleSubmit}>
          {formError && (
            <div className="mb-4 p-3 bg-error-50 dark:bg-error-900/20 border border-error-200 dark:border-error-800 rounded-md">
              <p className="text-sm text-error-700 dark:text-error-300">{formError}</p>
            </div>
          )}

          <div className="space-y-4">
            <Input
              label="Name"
              fullWidth
              type="text"
              required
              maxLength={150}
              value={formData.name}
              onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Nordfjord Slakteri AS"
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Godkjenningsnummer *
              </label>
              <Input
                className="uppercase font-mono"
                fullWidth
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
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Official approval number, 1–6 alphanumeric characters. Required for slaughter
                reports.
              </p>
            </div>

            <Input
              label="Address"
              fullWidth
              type="text"
              maxLength={255}
              value={formData.address}
              onChange={(e) => setFormData((prev) => ({ ...prev, address: e.target.value }))}
            />

            <Checkbox
              label="Use as the default facility for slaughter reports"
              checked={formData.isDefault}
              onChange={(e) => setFormData((prev) => ({ ...prev, isDefault: e.target.checked }))}
            />
          </div>

          <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 sm:flex sm:flex-row-reverse">
            <Button
              variant="primary"
              size="lg"
              className="justify-center sm:ml-3 sm:w-auto sm:text-sm"
              type="submit"
              disabled={pending}
            >
              {editingId ? 'Update' : 'Create'}
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

export default SlaughterFacilitiesTab;
