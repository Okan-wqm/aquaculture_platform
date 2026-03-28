/**
 * Start Inventory Count Modal
 *
 * Allows warehouse staff to initiate a new cycle count for a storage location.
 * The backend will snapshot current inventory at the selected location as
 * expected quantities, so counting can begin immediately after creation.
 *
 * Only active locations are shown — decommissioned locations cannot be counted.
 */
import React, { useState, useEffect } from 'react';
import { useToast } from '@aquaculture/shared-ui';
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

  /* Close modal on Escape key press for keyboard accessibility */
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="modal-title-start-inventory-count">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} />
        <div className="relative bg-white rounded-lg shadow-xl w-full max-w-md">
          <form onSubmit={handleSubmit}>
            <div className="px-6 pt-5 pb-4 space-y-4">
              <h3 id="modal-title-start-inventory-count" className="text-lg font-medium text-gray-900">Start Inventory Count</h3>
              <p className="text-sm text-gray-500">
                Select a storage location to begin a new cycle count. The system will
                automatically populate expected quantities from current inventory records.
              </p>

              {/* Location selector — only active locations are available */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Storage Location *</label>
                <select
                  value={storageLocationId}
                  onChange={e => setStorageLocationId(e.target.value)}
                  required
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                >
                  <option value="">Select location...</option>
                  {locationsLoading && <option disabled>Loading locations...</option>}
                  {locations.map(loc => (
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
                  onChange={e => setNotes(e.target.value)}
                  placeholder="e.g., Quarterly cycle count, reason for ad-hoc count..."
                  className="mt-1 block w-full border border-gray-300 rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 text-sm"
                />
              </div>
            </div>

            <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3">
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
        </div>
      </div>
    </div>
  );
};

export default StartInventoryCountModal;
