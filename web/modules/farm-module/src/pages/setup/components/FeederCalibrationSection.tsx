/**
 * FeederCalibrationSection
 *
 * Commissions a feeder: what kind of machine it is, what tells it the dose has
 * landed, and how much of each FEED it moves.
 *
 * The form is shaped by the physics rather than by the old flat table. Picking
 * "continuous flow" replaces the grams-per-shot column with grams-per-minute
 * plus the drive speed the figure was measured at, and asks once for the speed
 * band the drive is commissioned over. Picking "measured weight" reveals the
 * mass-sensor field and refuses to save without it — a farm that has no load
 * cells has nothing to type there, and dispensing against a measurement that
 * never arrives is the failure this prevents.
 *
 * Rows are keyed by FEED, not by pellet diameter: two 4 mm feeds flow
 * differently through the same auger, and the feed is what a protocol band
 * selects, so calibrating against it is what lets the feed transition happen
 * with nobody re-entering anything.
 *
 * Only shown in edit mode (when equipmentId exists).
 */
import React, { useState, useEffect, useMemo } from 'react';

import {
  useFeederSetup,
  useSaveFeederSetup,
  type FeederDispenseControl,
  type FeederDosingMode,
  type SaveFeederSetupInput,
} from '../../../hooks/useFeederCalibration';
import { useFeedList } from '../../../hooks/useFeeds';

interface CalibrationRow {
  /** Local key for React rendering. */
  _key: string;
  feedId: string;
  /** Discrete branch only. */
  gramsPerDispensing: number;
  /** Continuous branch only. */
  gramsPerMinute: number;
  referenceSpeedHz: number;
  notes: string;
}

interface FeederCalibrationSectionProps {
  equipmentId: string;
}

let rowKeyCounter = 0;
function nextKey(): string {
  return `cal_${++rowKeyCounter}`;
}

const INPUT_CLASS =
  'border border-gray-300 rounded px-2 py-1 text-sm focus:ring-blue-500 focus:border-blue-500';

export const FeederCalibrationSection: React.FC<FeederCalibrationSectionProps> = ({
  equipmentId,
}) => {
  const { data: setup, isLoading } = useFeederSetup(equipmentId);
  const { data: feedPage } = useFeedList({ isActive: true });
  const saveSetup = useSaveFeederSetup();

  const [dosingMode, setDosingMode] = useState<FeederDosingMode>('CONTINUOUS');
  const [dispenseMode, setDispenseMode] = useState<FeederDispenseControl>('TIME_BASED');
  const [weightSensorId, setWeightSensorId] = useState('');
  const [siloCapacityKg, setSiloCapacityKg] = useState('');
  const [minSpeedHz, setMinSpeedHz] = useState('');
  const [maxSpeedHz, setMaxSpeedHz] = useState('');
  const [rows, setRows] = useState<CalibrationRow[]>([]);
  const [isDirty, setIsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feeds = useMemo(() => feedPage?.items ?? [], [feedPage]);

  // Sync from server data.
  useEffect(() => {
    if (!setup) return;
    const capability = setup.capability;
    setDosingMode(capability?.dosingMode ?? 'CONTINUOUS');
    setDispenseMode(capability?.dispenseControl ?? 'TIME_BASED');
    setWeightSensorId(capability?.weightSensorId ?? '');
    setSiloCapacityKg(capability?.siloCapacityKg != null ? String(capability.siloCapacityKg) : '');
    setMinSpeedHz(capability?.minSpeedHz != null ? String(capability.minSpeedHz) : '');
    setMaxSpeedHz(capability?.maxSpeedHz != null ? String(capability.maxSpeedHz) : '');
    setRows(
      setup.calibrations.map((cal) => ({
        _key: nextKey(),
        feedId: cal.feedId,
        gramsPerDispensing: cal.gramsPerDispensing ?? 0,
        gramsPerMinute: cal.gramsPerMinute ?? 0,
        referenceSpeedHz: cal.referenceSpeedHz ?? 0,
        notes: cal.notes ?? '',
      })),
    );
    setIsDirty(false);
    setError(null);
  }, [setup]);

  const markDirty = (): void => {
    setIsDirty(true);
    setError(null);
  };

  const addRow = (): void => {
    setRows((prev) => [
      ...prev,
      {
        _key: nextKey(),
        feedId: '',
        gramsPerDispensing: 0,
        gramsPerMinute: 0,
        referenceSpeedHz: 0,
        notes: '',
      },
    ]);
    markDirty();
  };

  const removeRow = (key: string): void => {
    setRows((prev) => prev.filter((row) => row._key !== key));
    markDirty();
  };

  const updateRow = (key: string, field: keyof CalibrationRow, value: string | number): void => {
    setRows((prev) => prev.map((row) => (row._key === key ? { ...row, [field]: value } : row)));
    markDirty();
  };

  const handleSave = async (): Promise<void> => {
    const capacity = siloCapacityKg.trim() === '' ? undefined : Number(siloCapacityKg);

    if (rows.some((row) => !row.feedId)) {
      setError('Every calibration row must name the feed it calibrates.');
      return;
    }

    const input: SaveFeederSetupInput = {
      equipmentId,
      dispense: {
        mode: dispenseMode,
        // Sent only on the weight-based branch: a stale sensor id carried by a
        // time-based feeder would never be consulted and never noticed.
        weightSensorId:
          dispenseMode === 'WEIGHT_BASED' ? weightSensorId.trim() || undefined : undefined,
      },
    };

    if (dosingMode === 'DISCRETE') {
      input.discrete = {
        siloCapacityKg: capacity,
        calibrations: rows.map((row) => ({
          feedId: row.feedId,
          gramsPerDispensing: Number(row.gramsPerDispensing),
          notes: row.notes || undefined,
        })),
      };
    } else {
      input.continuous = {
        siloCapacityKg: capacity,
        minSpeedHz: Number(minSpeedHz),
        maxSpeedHz: Number(maxSpeedHz),
        calibrations: rows.map((row) => ({
          feedId: row.feedId,
          gramsPerMinute: Number(row.gramsPerMinute),
          referenceSpeedHz: Number(row.referenceSpeedHz),
          notes: row.notes || undefined,
        })),
      };
    }

    try {
      await saveSetup.mutateAsync(input);
      setIsDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save feeder setup.');
    }
  };

  if (isLoading) {
    return <div className="py-4 text-center text-sm text-gray-500">Loading calibrations...</div>;
  }

  const isContinuous = dosingMode === 'CONTINUOUS';

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-200 pb-2 mb-4">
        Feed Calibration
      </h4>
      <p className="text-xs text-gray-400 mb-3">
        Describe the machine once, then how much of each feed it moves. The drive speed and
        run duration for every dose are derived from these figures.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Dosing physics</label>
          <select
            value={dosingMode}
            onChange={(e) => {
              setDosingMode(e.target.value as FeederDosingMode);
              markDirty();
            }}
            className={`${INPUT_CLASS} w-full`}
          >
            <option value="CONTINUOUS">Continuous flow (VFD auger) — grams per minute</option>
            <option value="DISCRETE">Shot feeder — grams per dispensing</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Silo capacity (kg)</label>
          <input
            type="number"
            step="0.001"
            min="0"
            value={siloCapacityKg}
            onChange={(e) => {
              setSiloCapacityKg(e.target.value);
              markDirty();
            }}
            placeholder="Leave blank if not measured"
            className={`${INPUT_CLASS} w-full`}
          />
        </div>

        {isContinuous && (
          <>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Drive speed band — minimum (Hz)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={minSpeedHz}
                onChange={(e) => {
                  setMinSpeedHz(e.target.value);
                  markDirty();
                }}
                className={`${INPUT_CLASS} w-full`}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Drive speed band — maximum (Hz)
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={maxSpeedHz}
                onChange={(e) => {
                  setMaxSpeedHz(e.target.value);
                  markDirty();
                }}
                className={`${INPUT_CLASS} w-full`}
              />
            </div>
          </>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Dose is judged by</label>
          <select
            value={dispenseMode}
            onChange={(e) => {
              setDispenseMode(e.target.value as FeederDispenseControl);
              markDirty();
            }}
            className={`${INPUT_CLASS} w-full`}
          >
            <option value="TIME_BASED">Elapsed time / shot count</option>
            <option value="WEIGHT_BASED">Measured weight (load cells)</option>
          </select>
        </div>

        {dispenseMode === 'WEIGHT_BASED' && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Silo mass sensor ID
            </label>
            <input
              type="text"
              value={weightSensorId}
              onChange={(e) => {
                setWeightSensorId(e.target.value);
                markDirty();
              }}
              placeholder="Mass sensor UUID"
              className={`${INPUT_CLASS} w-full`}
            />
            <p className="text-xs text-gray-400 mt-1">
              Required. Dosing is refused until this sensor actually reports a weight.
            </p>
          </div>
        )}
      </div>

      {isContinuous && (
        <p className="text-xs text-gray-400 mb-3">
          Flow is taken to rise in proportion to drive speed, which holds inside the band above
          and nowhere else — a dose needing a speed outside it is refused rather than estimated.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm border border-gray-200 rounded">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Feed</th>
                {isContinuous ? (
                  <>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      Flow (g/min)
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                      Measured at (Hz)
                    </th>
                  </>
                ) : (
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">
                    Dispensing (g/shot)
                  </th>
                )}
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500">Notes</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((row) => (
                <tr key={row._key}>
                  <td className="px-3 py-1">
                    <select
                      value={row.feedId}
                      onChange={(e) => updateRow(row._key, 'feedId', e.target.value)}
                      className={`${INPUT_CLASS} w-44`}
                    >
                      <option value="">Select feed…</option>
                      {feeds.map((feed) => (
                        <option key={feed.id} value={feed.id}>
                          {feed.code} — {feed.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  {isContinuous ? (
                    <>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.001"
                          min="0"
                          value={row.gramsPerMinute}
                          onChange={(e) =>
                            updateRow(row._key, 'gramsPerMinute', parseFloat(e.target.value) || 0)
                          }
                          className={`${INPUT_CLASS} w-24`}
                        />
                      </td>
                      <td className="px-3 py-1">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.referenceSpeedHz}
                          onChange={(e) =>
                            updateRow(row._key, 'referenceSpeedHz', parseFloat(e.target.value) || 0)
                          }
                          className={`${INPUT_CLASS} w-24`}
                        />
                      </td>
                    </>
                  ) : (
                    <td className="px-3 py-1">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={row.gramsPerDispensing}
                        onChange={(e) =>
                          updateRow(row._key, 'gramsPerDispensing', parseFloat(e.target.value) || 0)
                        }
                        className={`${INPUT_CLASS} w-24`}
                      />
                    </td>
                  )}
                  <td className="px-3 py-1">
                    <input
                      type="text"
                      value={row.notes}
                      onChange={(e) => updateRow(row._key, 'notes', e.target.value)}
                      className={`${INPUT_CLASS} w-32`}
                    />
                  </td>
                  <td className="px-3 py-1">
                    <button
                      type="button"
                      onClick={() => removeRow(row._key)}
                      className="text-red-500 hover:text-red-700"
                      title="Remove row"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
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

      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 rounded hover:bg-blue-100"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6v12m6-6H6"
            />
          </svg>
          Add Row
        </button>

        {isDirty && (
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={saveSetup.isPending}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-white bg-green-600 rounded hover:bg-green-700 disabled:opacity-50"
          >
            {saveSetup.isPending ? 'Saving...' : 'Save Calibrations'}
          </button>
        )}

        {saveSetup.isSuccess && !isDirty && <span className="text-sm text-green-600">Saved</span>}
      </div>
    </div>
  );
};

export default FeederCalibrationSection;
