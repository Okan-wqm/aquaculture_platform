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
import { Modal, useToast, Button, Select, Textarea } from '@aquaculture/shared-ui';
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
          <Select
            label="Storage Location"
            required
            placeholder="Select location..."
            value={storageLocationId}
            onChange={(e) => setStorageLocationId(e.target.value)}
            options={[
              ...(locationsLoading
                ? [{ value: '__loading__', label: 'Loading locations...', disabled: true }]
                : []),
              ...locations.map((loc) => ({
                value: loc.id,
                label: `${loc.name} (${loc.code}) — ${loc.type.replace('_', ' ')}`,
              })),
            ]}
          />

          {/* Notes — optional context for the counting session */}
          <Textarea
            label="Notes"
            fullWidth
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g., Quarterly cycle count, reason for ad-hoc count..."
          />
        </div>

        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!storageLocationId || createCount.isPending}
          >
            {createCount.isPending ? 'Starting...' : 'Start Count'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default StartInventoryCountModal;
