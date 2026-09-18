/**
 * FeederCalibrationSection Component
 * Displays and edits feeder calibration data (feed size → grams per dispensing + silo capacity)
 * Only shown in edit mode (when equipmentId exists)
 */
import React, { useState, useEffect } from 'react';
import {
  useFeederCalibrations,
  useSaveFeederCalibrations,
  FeederCalibrationItemInput,
} from '../../../hooks/useFeederCalibration';

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

  const updateRow = (key: string, field: keyof FeederCalibrationItemInput, value: string | number) => {
    setRows((prev) =>
      prev.map((r) =>
        r._key === key ? { ...r, [field]: value } : r,
      ),
    );
    setIsDirty(true);
  };

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
      alert('Failed to save calibrations. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <div className="py-4 text-center text-sm text-gray-500">
        Loading calibrations...
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
        Feed Calibration
      </h4>
      <p className="text-xs text-gray-400 mb-3">
        Define dispensing grams and silo capacity for each feed size.
      </p>

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  Feed Size (mm)
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  Label
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  Dispensing (g/shot)
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  Silo Capacity (kg)
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                  Notes
                </th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row._key}>
                  <td className="px-3 py-1">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.feedSizeMm}
                      onChange={(e) =>
                        updateRow(row._key, 'feedSizeMm', parseFloat(e.target.value) || 0)
                      }
                      className="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={row.feedSizeLabel || ''}
                      onChange={(e) => updateRow(row._key, 'feedSizeLabel', e.target.value)}
                      placeholder="e.g., Starter"
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.gramsPerDispensing}
                      onChange={(e) =>
                        updateRow(row._key, 'gramsPerDispensing', parseFloat(e.target.value) || 0)
                      }
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.siloCapacityKg}
                      onChange={(e) =>
                        updateRow(row._key, 'siloCapacityKg', parseFloat(e.target.value) || 0)
                      }
                      className="w-24 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={row.notes || ''}
                      onChange={(e) => updateRow(row._key, 'notes', e.target.value)}
                      className="w-32 border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500"
                    />
                  </td>
                  <td className="px-3 py-1">
                    <button
                      type="button"
                      onClick={() => removeRow(row._key)}
                      className="text-red-500 hover:text-red-700"
                      title="Remove row"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 && (
        <p className="text-sm text-gray-400 italic mb-3">No calibration data yet.</p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m6-6H6" />
          </svg>
          Add Row
        </button>

        {isDirty && (
          <button
            type="button"
            onClick={handleSave}
            disabled={saveCalibrations.isPending}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50"
          >
            {saveCalibrations.isPending ? 'Saving...' : 'Save Calibrations'}
          </button>
        )}

        {saveCalibrations.isSuccess && !isDirty && (
          <span className="text-sm text-green-600">Saved</span>
        )}
      </div>
    </div>
  );
};

export default FeederCalibrationSection;
