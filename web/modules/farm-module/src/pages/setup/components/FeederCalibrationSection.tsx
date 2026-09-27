/**
 * FeederCalibrationSection Component
 * Displays and edits feeder calibration data (feed size → grams per dispensing + silo capacity)
 * Only shown in edit mode (when equipmentId exists)
 */
import React, { useState, useEffect } from 'react';
import { useToast, DataTable, type DataTableColumn, Button, Input } from '@aquaculture/shared-ui';
import {
  useFeederCalibrations,
  useSaveFeederCalibrations,
  FeederCalibrationItemInput,
} from '../../../hooks/useFeederCalibration';
import { Plus, X } from 'lucide-react';

interface CalibrationRow extends FeederCalibrationItemInput {
  _key: string; // local key for React rendering
}

interface FeederCalibrationSectionProps {
  equipmentId: string;
}

let rowKeyCounter = 0;
function nextKey(): string {
  return `cal_${++rowKeyCounter}`;
}

export const FeederCalibrationSection: React.FC<FeederCalibrationSectionProps> = ({
  equipmentId,
}) => {
  const { data: calibrations, isLoading } = useFeederCalibrations(equipmentId);
  const saveCalibrations = useSaveFeederCalibrations();
  const [rows, setRows] = useState<CalibrationRow[]>([]);
  const [isDirty, setIsDirty] = useState(false);

  // Sync from server data
  useEffect(() => {
    if (calibrations) {
      setRows(
        calibrations.map((cal) => ({
          _key: nextKey(),
          feedSizeMm: cal.feedSizeMm,
          feedSizeLabel: cal.feedSizeLabel || '',
          gramsPerDispensing: cal.gramsPerDispensing,
          siloCapacityKg: cal.siloCapacityKg,
          notes: cal.notes || '',
        })),
      );
      setIsDirty(false);
    }
  }, [calibrations]);

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        _key: nextKey(),
        feedSizeMm: 0,
        feedSizeLabel: '',
        gramsPerDispensing: 0,
        siloCapacityKg: 0,
        notes: '',
      },
    ]);
    setIsDirty(true);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r._key !== key));
    setIsDirty(true);
  };

  const updateRow = (
    key: string,
    field: keyof FeederCalibrationItemInput,
    value: string | number,
  ) => {
    setRows((prev) => prev.map((r) => (r._key === key ? { ...r, [field]: value } : r)));
    setIsDirty(true);
  };

  const { toast } = useToast();
  const handleSave = async () => {
    const items: FeederCalibrationItemInput[] = rows.map(({ _key, ...rest }) => ({
      ...rest,
      feedSizeMm: Number(rest.feedSizeMm),
      gramsPerDispensing: Number(rest.gramsPerDispensing),
      siloCapacityKg: Number(rest.siloCapacityKg),
      feedSizeLabel: rest.feedSizeLabel || undefined,
      notes: rest.notes || undefined,
    }));

    try {
      await saveCalibrations.mutateAsync({ equipmentId, calibrations: items });
      setIsDirty(false);
    } catch (err) {
      console.error('Failed to save calibrations:', err);
      toast({ title: 'Failed to save calibrations. Please try again.', variant: 'error' });
    }
  };

  if (isLoading) {
    return (
      <div className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
        Loading calibrations...
      </div>
    );
  }

  type RowRow = (typeof rows)[number];
  const rowRowColumns: DataTableColumn<RowRow>[] = [
    {
      key: 'feedSizeMm',
      header: 'Feed Size (mm)',
      render: (_value, row) => (
        <Input
          type="number"
          step="0.01"
          min="0"
          value={row.feedSizeMm}
          onChange={(e) => updateRow(row._key, 'feedSizeMm', parseFloat(e.target.value) || 0)}
        />
      ),
    },
    {
      key: 'label',
      header: 'Label',
      render: (_value, row) => (
        <Input
          type="text"
          value={row.feedSizeLabel || ''}
          onChange={(e) => updateRow(row._key, 'feedSizeLabel', e.target.value)}
          placeholder="e.g., Starter"
        />
      ),
    },
    {
      key: 'dispensingGShot',
      header: 'Dispensing (g/shot)',
      render: (_value, row) => (
        <Input
          type="number"
          step="0.01"
          min="0"
          value={row.gramsPerDispensing}
          onChange={(e) =>
            updateRow(row._key, 'gramsPerDispensing', parseFloat(e.target.value) || 0)
          }
        />
      ),
    },
    {
      key: 'siloCapacityKg',
      header: 'Silo Capacity (kg)',
      render: (_value, row) => (
        <Input
          type="number"
          step="0.01"
          min="0"
          value={row.siloCapacityKg}
          onChange={(e) => updateRow(row._key, 'siloCapacityKg', parseFloat(e.target.value) || 0)}
        />
      ),
    },
    {
      key: 'notes',
      header: 'Notes',
      render: (_value, row) => (
        <Input
          type="text"
          value={row.notes || ''}
          onChange={(e) => updateRow(row._key, 'notes', e.target.value)}
        />
      ),
    },
    {
      key: 'col',
      header: '',
      render: (_value, row) => (
        <>
          <Button
            variant="ghost"
            type="button"
            onClick={() => removeRow(row._key)}
            title="Remove row"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </Button>
        </>
      ),
    },
  ];

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider border-b border-gray-200 dark:border-gray-700 pb-2 mb-4">
        Feed Calibration
      </h4>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">
        Define dispensing grams and silo capacity for each feed size.
      </p>

      {rows.length > 0 && (
        <DataTable<RowRow>
          data={rows}
          columns={rowRowColumns}
          keyExtractor={(row) => row._key}
          emptyMessage="No records found"
          searchable={false}
          sortable={false}
          stickyHeader={false}
        />
      )}

      {rows.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic mb-3">
          No calibration data yet.
        </p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-info-600 dark:text-info-400 bg-info-50 dark:bg-info-900/20 rounded hover:bg-info-100 dark:hover:bg-info-900/50"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
          Add Row
        </button>

        {isDirty && (
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleSave}
            disabled={saveCalibrations.isPending}
          >
            {saveCalibrations.isPending ? 'Saving...' : 'Save Calibrations'}
          </Button>
        )}

        {saveCalibrations.isSuccess && !isDirty && (
          <span className="text-sm text-success-600 dark:text-success-400">Saved</span>
        )}
      </div>
    </div>
  );
};

export default FeederCalibrationSection;
