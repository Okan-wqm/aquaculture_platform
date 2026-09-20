/**
 * FeedingMatrixEditor Component
 *
 * A spreadsheet-like grid for editing 2D feeding matrix (Temperature x Weight).
 * Allows bilinear interpolation between temperature and weight axes.
 *
 * Example matrix:
 * Temperature (°C) ->    12     14     16     18
 * Weight (g) |
 *     5              [2.5]  [3.0]  [3.5]  [4.0]
 *    10              [2.2]  [2.6]  [3.0]  [3.4]
 *    20              [1.8]  [2.1]  [2.4]  [2.7]
 *    50              [1.4]  [1.6]  [1.8]  [2.0]
 *   100              [1.1]  [1.2]  [1.3]  [1.4]
 */
import React, { useState, useCallback, useMemo } from 'react';
import { Button, colors, Input, Textarea, ToggleButton } from '@aquaculture/shared-ui';
import { TriangleAlert } from 'lucide-react';

export interface FeedingMatrix2D {
  temperatures: number[];
  weights: number[];
  rates: number[][];
  fcrMatrix?: number[][];
  temperatureUnit?: 'celsius' | 'fahrenheit';
  weightUnit?: 'gram' | 'kg';
  notes?: string;
}

interface FeedingMatrixEditorProps {
  matrix: FeedingMatrix2D | null;
  onChange: (matrix: FeedingMatrix2D) => void;
  showFCR?: boolean;
  /** Coverage map from merged matrix: coverageMap[weightIdx][tempIdx] = true if feed covers this cell */
  coverageMap?: boolean[][];
}

// Default empty matrix
const createEmptyMatrix = (): FeedingMatrix2D => ({
  temperatures: [12, 14, 16, 18, 20],
  weights: [5, 10, 20, 50, 100, 200, 500],
  rates: [
    [4.0, 4.2, 4.5, 4.8, 5.0],
    [3.5, 3.8, 4.0, 4.2, 4.5],
    [3.0, 3.2, 3.5, 3.8, 4.0],
    [2.5, 2.7, 3.0, 3.2, 3.5],
    [2.0, 2.2, 2.5, 2.7, 3.0],
    [1.5, 1.7, 2.0, 2.2, 2.5],
    [1.2, 1.4, 1.6, 1.8, 2.0],
  ],
  fcrMatrix: [
    [0.8, 0.82, 0.85, 0.88, 0.9],
    [0.85, 0.88, 0.9, 0.92, 0.95],
    [0.9, 0.92, 0.95, 0.98, 1.0],
    [0.95, 0.98, 1.0, 1.02, 1.05],
    [1.0, 1.02, 1.05, 1.08, 1.1],
    [1.05, 1.08, 1.1, 1.12, 1.15],
    [1.1, 1.12, 1.15, 1.18, 1.2],
  ],
  temperatureUnit: 'celsius',
  weightUnit: 'gram',
});

// Color gradient based on feeding rate value (lower = cooler, higher = warmer)
const getRateColor = (rate: number): string => {
  // Map rate (0-6%) to color
  const normalized = Math.min(Math.max(rate, 0), 6) / 6;
  if (normalized < 0.33) {
    // Blue to green
    const t = normalized / 0.33;
    return `rgb(${Math.round(59 + (34 - 59) * t)}, ${Math.round(130 + (197 - 130) * t)}, ${Math.round(246 + (94 - 246) * t)})`;
  } else if (normalized < 0.66) {
    // Green to yellow
    const t = (normalized - 0.33) / 0.33;
    return `rgb(${Math.round(34 + (234 - 34) * t)}, ${Math.round(197 + (179 - 197) * t)}, ${Math.round(94 + (8 - 94) * t)})`;
  } else {
    // Yellow to red
    const t = (normalized - 0.66) / 0.34;
    return `rgb(${Math.round(234 + (239 - 234) * t)}, ${Math.round(179 + (68 - 179) * t)}, ${Math.round(8 + (68 - 8) * t)})`;
  }
};

const getFCRColor = (fcr: number): string => {
  // Map FCR (0.7-1.5) to color - lower is better (green), higher is worse (red)
  const normalized = Math.min(Math.max(fcr - 0.7, 0), 0.8) / 0.8;
  if (normalized < 0.33) {
    return colors.success[500]; // Green - excellent
  } else if (normalized < 0.66) {
    return colors.warning[500]; // Yellow - good
  } else {
    return colors.error[500]; // Red - needs improvement
  }
};

// Bilinear interpolation helper
const bilinearInterpolate = (
  matrix: FeedingMatrix2D,
  temp: number,
  weight: number,
  useRates: boolean = true,
): number | null => {
  const { temperatures, weights, rates, fcrMatrix } = matrix;
  const values = useRates ? rates : fcrMatrix;

  if (!values || !temperatures.length || !weights.length) return null;

  // Find bounding indices
  let ti = 0,
    wi = 0;
  for (let i = 0; i < temperatures.length - 1; i++) {
    if (temp >= temperatures[i]!) ti = i;
  }
  for (let i = 0; i < weights.length - 1; i++) {
    if (weight >= weights[i]!) wi = i;
  }

  const t1 = temperatures[ti] ?? temperatures[0] ?? 15;
  const t2 = temperatures[Math.min(ti + 1, temperatures.length - 1)] ?? t1;
  const w1 = weights[wi] ?? weights[0] ?? 10;
  const w2 = weights[Math.min(wi + 1, weights.length - 1)] ?? w1;

  const f11 = values[wi]?.[ti] ?? 2.0;
  const f21 = values[wi]?.[Math.min(ti + 1, temperatures.length - 1)] ?? f11;
  const f12 = values[Math.min(wi + 1, weights.length - 1)]?.[ti] ?? f11;
  const f22 =
    values[Math.min(wi + 1, weights.length - 1)]?.[Math.min(ti + 1, temperatures.length - 1)] ??
    f11;

  // Edge cases
  if (t1 === t2 && w1 === w2) return f11;
  if (t1 === t2) return f11 + ((f12 - f11) * (weight - w1)) / (w2 - w1);
  if (w1 === w2) return f11 + ((f21 - f11) * (temp - t1)) / (t2 - t1);

  // Bilinear interpolation
  const denom = (t2 - t1) * (w2 - w1);
  return (
    (f11 * (t2 - temp) * (w2 - weight) +
      f21 * (temp - t1) * (w2 - weight) +
      f12 * (t2 - temp) * (weight - w1) +
      f22 * (temp - t1) * (weight - w1)) /
    denom
  );
};

export const FeedingMatrixEditor: React.FC<FeedingMatrixEditorProps> = ({
  matrix: inputMatrix,
  onChange,
  showFCR = true,
  coverageMap,
}) => {
  const matrix = inputMatrix ?? createEmptyMatrix();
  const [editMode, setEditMode] = useState<'rates' | 'fcr'>('rates');
  const [testTemp, setTestTemp] = useState<number | ''>('');
  const [testWeight, setTestWeight] = useState<number | ''>('');

  // Update rate value at specific position
  const updateRate = useCallback(
    (weightIdx: number, tempIdx: number, value: number) => {
      const newRates = matrix.rates.map((row, wi) =>
        row.map((cell, ti) => (wi === weightIdx && ti === tempIdx ? value : cell)),
      );
      onChange({ ...matrix, rates: newRates });
    },
    [matrix, onChange],
  );

  // Update FCR value at specific position
  const updateFCR = useCallback(
    (weightIdx: number, tempIdx: number, value: number) => {
      const newFCR = (matrix.fcrMatrix ?? matrix.rates.map((row) => row.map(() => 1.0))).map(
        (row, wi) => row.map((cell, ti) => (wi === weightIdx && ti === tempIdx ? value : cell)),
      );
      onChange({ ...matrix, fcrMatrix: newFCR });
    },
    [matrix, onChange],
  );

  // Add temperature column
  const addTemperature = useCallback(() => {
    const temps = matrix.temperatures;
    const lastTemp = temps[temps.length - 1] ?? 20;
    const newTemp = lastTemp + 2;
    const newTemps = [...temps, newTemp];
    const newRates = matrix.rates.map((row) => [...row, row[row.length - 1] ?? 2.0]);
    const newFCR = matrix.fcrMatrix?.map((row) => [...row, row[row.length - 1] ?? 1.0]);
    onChange({ ...matrix, temperatures: newTemps, rates: newRates, fcrMatrix: newFCR });
  }, [matrix, onChange]);

  // Remove temperature column
  const removeTemperature = useCallback(
    (idx: number) => {
      if (matrix.temperatures.length <= 2) return; // Keep at least 2
      const newTemps = matrix.temperatures.filter((_, i) => i !== idx);
      const newRates = matrix.rates.map((row) => row.filter((_, i) => i !== idx));
      const newFCR = matrix.fcrMatrix?.map((row) => row.filter((_, i) => i !== idx));
      onChange({ ...matrix, temperatures: newTemps, rates: newRates, fcrMatrix: newFCR });
    },
    [matrix, onChange],
  );

  // Add weight row
  const addWeight = useCallback(() => {
    const weights = matrix.weights;
    const lastWeight = weights[weights.length - 1] ?? 100;
    const newWeight = lastWeight * 2;
    const newWeights = [...weights, newWeight];
    const lastRow = matrix.rates[matrix.rates.length - 1] ?? matrix.temperatures.map(() => 2.0);
    const newRates = [...matrix.rates, lastRow.map((v) => Math.max(v - 0.2, 0.5))];
    const lastFCRRow =
      matrix.fcrMatrix?.[matrix.fcrMatrix.length - 1] ?? matrix.temperatures.map(() => 1.0);
    const newFCR = matrix.fcrMatrix
      ? [...matrix.fcrMatrix, lastFCRRow.map((v) => Math.min(v + 0.05, 1.5))]
      : undefined;
    onChange({ ...matrix, weights: newWeights, rates: newRates, fcrMatrix: newFCR });
  }, [matrix, onChange]);

  // Remove weight row
  const removeWeight = useCallback(
    (idx: number) => {
      if (matrix.weights.length <= 2) return; // Keep at least 2
      const newWeights = matrix.weights.filter((_, i) => i !== idx);
      const newRates = matrix.rates.filter((_, i) => i !== idx);
      const newFCR = matrix.fcrMatrix?.filter((_, i) => i !== idx);
      onChange({ ...matrix, weights: newWeights, rates: newRates, fcrMatrix: newFCR });
    },
    [matrix, onChange],
  );

  // Update temperature value
  const updateTemperature = useCallback(
    (idx: number, value: number) => {
      const newTemps = matrix.temperatures.map((t, i) => (i === idx ? value : t));
      onChange({ ...matrix, temperatures: newTemps });
    },
    [matrix, onChange],
  );

  // Update weight value
  const updateWeight = useCallback(
    (idx: number, value: number) => {
      const newWeights = matrix.weights.map((w, i) => (i === idx ? value : w));
      onChange({ ...matrix, weights: newWeights });
    },
    [matrix, onChange],
  );

  // Check if a test point is within coverage
  const isTestPointCovered = useMemo(() => {
    if (!coverageMap || testTemp === '' || testWeight === '') return true;
    const { temperatures, weights } = matrix;

    // Find the closest weight index
    let wi = 0;
    for (let i = 0; i < weights.length - 1; i++) {
      if (testWeight >= weights[i]!) wi = i;
    }
    // Check if closer to wi or wi+1
    const wi2 = Math.min(wi + 1, weights.length - 1);
    const closestWi =
      Math.abs(testWeight - weights[wi]!) <= Math.abs(testWeight - weights[wi2]!) ? wi : wi2;

    // Find the closest temp index
    let ti = 0;
    for (let i = 0; i < temperatures.length - 1; i++) {
      if (testTemp >= temperatures[i]!) ti = i;
    }
    const ti2 = Math.min(ti + 1, temperatures.length - 1);
    const closestTi =
      Math.abs(testTemp - temperatures[ti]!) <= Math.abs(testTemp - temperatures[ti2]!) ? ti : ti2;

    return coverageMap[closestWi]?.[closestTi] ?? true;
  }, [coverageMap, matrix, testTemp, testWeight]);

  // Calculate interpolated values for test
  const testResult = useMemo(() => {
    if (testTemp === '' || testWeight === '') return null;
    const rate = bilinearInterpolate(matrix, testTemp, testWeight, true);
    const fcr = bilinearInterpolate(matrix, testTemp, testWeight, false);
    return { rate, fcr };
  }, [matrix, testTemp, testWeight]);

  const currentValues = editMode === 'rates' ? matrix.rates : (matrix.fcrMatrix ?? []);

  return (
    <div className="space-y-4">
      {/* Mode Toggle */}
      {showFCR && (
        <div className="flex items-center gap-4 mb-4">
          <span className="text-sm text-gray-600 dark:text-gray-400">Edit:</span>
          <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
            <ToggleButton
              type="button"
              onClick={() => setEditMode('rates')}
              pressed={editMode === 'rates'}
              className="px-4 py-2 text-sm font-medium"
              pressedClassName="bg-info-600 text-white"
              idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              Feeding Rate (%)
            </ToggleButton>
            <ToggleButton
              type="button"
              onClick={() => setEditMode('fcr')}
              pressed={editMode === 'fcr'}
              className="px-4 py-2 text-sm font-medium"
              pressedClassName="bg-info-600 text-white"
              idleClassName="bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              FCR
            </ToggleButton>
          </div>
        </div>
      )}

      {/* Matrix Grid */}
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-2 py-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                Weight (g) ↓<br />
                Temp (°C) →
              </th>
              {matrix.temperatures.map((temp, ti) => (
                <th
                  key={ti}
                  className="border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1 min-w-[70px]"
                >
                  <div className="flex flex-col items-center gap-1">
                    <Input
                      className="text-center"
                      type="number"
                      value={temp}
                      onChange={(e) => updateTemperature(ti, parseFloat(e.target.value) || 0)}
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      type="button"
                      onClick={() => removeTemperature(ti)}
                      title="Remove column"
                    >
                      ×
                    </Button>
                  </div>
                </th>
              ))}
              <th className="border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 px-2">
                <Button
                  variant="ghost"
                  type="button"
                  onClick={addTemperature}
                  title="Add temperature column"
                >
                  +
                </Button>
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.weights.map((weight, wi) => (
              <tr key={wi}>
                <td className="border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800 px-1 py-1">
                  <div className="flex items-center gap-1">
                    <Input
                      className="text-center"
                      type="number"
                      value={weight}
                      onChange={(e) => updateWeight(wi, parseFloat(e.target.value) || 0)}
                    />
                    <Button
                      variant="ghost"
                      size="xs"
                      type="button"
                      onClick={() => removeWeight(wi)}
                      title="Remove row"
                    >
                      ×
                    </Button>
                  </div>
                </td>
                {matrix.temperatures.map((_, ti) => {
                  const isCovered = coverageMap ? (coverageMap[wi]?.[ti] ?? true) : true;
                  const value = currentValues[wi]?.[ti] ?? (editMode === 'rates' ? 2.0 : 1.0);

                  if (!isCovered) {
                    return (
                      <td
                        key={ti}
                        className="border border-gray-300 dark:border-gray-600 px-1 py-1 bg-gray-100 dark:bg-gray-800"
                        title="Bu sicaklik bu yemin kapsami disinda"
                      >
                        <div className="w-14 text-center text-gray-400 dark:text-gray-500 font-medium text-sm py-0.5">
                          ×
                        </div>
                      </td>
                    );
                  }

                  const bgColor = editMode === 'rates' ? getRateColor(value) : getFCRColor(value);
                  return (
                    <td
                      key={ti}
                      className="border border-gray-300 dark:border-gray-600 px-1 py-1"
                      style={{ backgroundColor: bgColor }}
                    >
                      <Input
                        className="text-center"
                        type="number"
                        step={editMode === 'rates' ? '0.1' : '0.01'}
                        min="0"
                        max={editMode === 'rates' ? '10' : '3'}
                        value={value}
                        onChange={(e) => {
                          const newValue = parseFloat(e.target.value) || 0;
                          if (editMode === 'rates') {
                            updateRate(wi, ti, newValue);
                          } else {
                            updateFCR(wi, ti, newValue);
                          }
                        }}
                      />
                    </td>
                  );
                })}
                <td className="border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800" />
              </tr>
            ))}
            <tr>
              <td className="border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 px-2 py-2">
                <Button variant="ghost" type="button" onClick={addWeight} title="Add weight row">
                  + Row
                </Button>
              </td>
              <td
                colSpan={matrix.temperatures.length + 1}
                className="border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800"
              />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-600 dark:text-gray-400">
        <div className="flex items-center gap-2">
          <span>Feeding Rate:</span>
          <div className="flex">
            <div className="w-4 h-4" style={{ backgroundColor: getRateColor(1) }} title="1%" />
            <div className="w-4 h-4" style={{ backgroundColor: getRateColor(2) }} title="2%" />
            <div className="w-4 h-4" style={{ backgroundColor: getRateColor(3) }} title="3%" />
            <div className="w-4 h-4" style={{ backgroundColor: getRateColor(4) }} title="4%" />
            <div className="w-4 h-4" style={{ backgroundColor: getRateColor(5) }} title="5%" />
          </div>
          <span>Low → High</span>
        </div>
        {showFCR && (
          <div className="flex items-center gap-2">
            <span>FCR:</span>
            <div className="flex">
              <div className="w-4 h-4 bg-success-500" title="<0.9" />
              <div className="w-4 h-4 bg-warning-500" title="0.9-1.2" />
              <div className="w-4 h-4 bg-error-500" title=">1.2" />
            </div>
            <span>Good → Poor</span>
          </div>
        )}
      </div>

      {/* Interpolation Calculator */}
      <div className="mt-4 p-4 bg-info-50 dark:bg-info-900/20 rounded-lg">
        <h5 className="text-sm font-medium text-info-800 dark:text-info-200 mb-3">
          Interpolation Calculator (Test your matrix)
        </h5>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-info-700 dark:text-info-300 mb-1">
              Temperature (°C)
            </label>
            <Input
              fullWidth
              type="number"
              step="0.1"
              value={testTemp}
              onChange={(e) => setTestTemp(e.target.value ? parseFloat(e.target.value) : '')}
              placeholder="e.g. 13"
            />
          </div>
          <div>
            <label className="block text-xs text-info-700 dark:text-info-300 mb-1">
              Fish Weight (g)
            </label>
            <Input
              fullWidth
              type="number"
              step="0.1"
              value={testWeight}
              onChange={(e) => setTestWeight(e.target.value ? parseFloat(e.target.value) : '')}
              placeholder="e.g. 7"
            />
          </div>
          <div>
            <label className="block text-xs text-info-700 dark:text-info-300 mb-1">
              Feeding Rate
            </label>
            <div
              className={`py-2 px-3 border rounded-md text-sm font-medium ${
                !isTestPointCovered
                  ? 'bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-700 text-error-700 dark:text-error-300'
                  : 'bg-white dark:bg-gray-900 border-info-300'
              }`}
            >
              {!isTestPointCovered
                ? '× Kapsam disi'
                : testResult?.rate !== null && testResult?.rate !== undefined
                  ? `${testResult.rate.toFixed(2)}% BW`
                  : '-'}
            </div>
          </div>
          <div>
            <label className="block text-xs text-info-700 dark:text-info-300 mb-1">FCR</label>
            <div
              className={`py-2 px-3 border rounded-md text-sm font-medium ${
                !isTestPointCovered
                  ? 'bg-error-50 dark:bg-error-900/20 border-error-300 dark:border-error-700 text-error-700 dark:text-error-300'
                  : 'bg-white dark:bg-gray-900 border-info-300'
              }`}
            >
              {!isTestPointCovered
                ? '× Kapsam disi'
                : testResult?.fcr !== null && testResult?.fcr !== undefined
                  ? testResult.fcr.toFixed(3)
                  : '-'}
            </div>
          </div>
        </div>
        {!isTestPointCovered && testTemp !== '' && testWeight !== '' && (
          <div className="mt-2 flex items-center gap-2 text-xs text-error-700 dark:text-error-300">
            <TriangleAlert className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            <span>
              Bu sicaklik/agirlik kombinasyonu hicbir yemin kapsama alaninda degil. Ilgili yemin
              sicaklik araligini kontrol edin.
            </span>
          </div>
        )}
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Matrix Notes
        </label>
        <Textarea
          fullWidth
          rows={2}
          placeholder="Notes about this feeding matrix (e.g., species, conditions, source)"
          value={matrix.notes || ''}
          onChange={(e) => onChange({ ...matrix, notes: e.target.value })}
        />
      </div>
    </div>
  );
};

export default FeedingMatrixEditor;
