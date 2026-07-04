/**
 * Start Inventory Count Modal
 *
 * Allows warehouse staff to initiate a new cycle count for a storage location.
 * The backend will snapshot current inventory at the selected location as
 * expected quantities, so counting can begin immediately after creation.
 *
 * Only active locations are shown — decommissioned locations cannot be counted.
 */
import React, { useState } from 'react';
import { Modal, useToast } from '@aquaculture/shared-ui';
import { useCreateInventoryCount } from '../../../hooks/useInventoryCounts';
import { useStorageLocationList } from '../../../hooks/useStorageLocations';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const StartInventoryCountModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const [storageLocationId, setStorageLocationId] = useState('');
  const [notes, setNotes] = useState('');

  const createCount = useCreateInventoryCount();
  const { toast } = useToast();

  /* Only show active locations — decommissioned ones have no countable inventory */
  const { data: locationsData, isLoading: locationsLoading } = useStorageLocationList({
    isActive: true,
  });

  const locations = locationsData?.items || [];

  const resetForm = () => {
    setStorageLocationId('');
    setNotes('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!storageLocationId) return;

    try {
      await createCount.mutateAsync({
        storageLocationId,
        notes: notes || undefined,
      });
      toast({
        title: 'Count Started',
        description: 'Inventory count has been created. You can now begin counting items.',
        variant: 'success',
      });
      resetForm();
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to create inventory count:', err);
      toast({
        title: 'Error',
        description: 'Failed to start inventory count. Please try again.',
        variant: 'error',
      });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Start Inventory Count"
      description="Select a storage location to begin a new cycle count. The system will automatically populate expected quantities from current inventory records."
      size="sm"
    >
      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {/* Location selector — only active locations are available */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Storage Location *</label>
            <select
              value={storageLocationId}
              onChange={(e) => setStorageLocationId(e.target.value)}
              required
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            >
              <option value="">Select location...</option>
              {locationsLoading && <option disabled>Loading locations...</option>}
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name} ({loc.code}) — {loc.type.replace('_', ' ')}
                </option>
              ))}
            </select>
          </div>

          {/* Notes — optional context for the counting session */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Notes</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., Quarterly cycle count, reason for ad-hoc count..."
              className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
            />
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-sm text-gray-700 bg-white hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!storageLocationId || createCount.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createCount.isPending ? 'Starting...' : 'Start Count'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default StartInventoryCountModal;
