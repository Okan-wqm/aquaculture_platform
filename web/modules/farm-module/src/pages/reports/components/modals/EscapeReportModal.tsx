/**
 * Escape Report Modal
 * Quick report modal for immediate escape reporting
 * Contact: varsling.akva@mattilsynet.no
 *
 * Features:
 * - Auto-populate from tank/cage data
 * - Multi-unit support (storm damage affecting multiple cages)
 * - Escape count validation with stock percentage
 * - Total biomass calculation
 * - GPS coordinates display
 * - Dynamic species list from tank data
 */
import React, { useState, useCallback, useMemo } from 'react';
import { Modal } from '@aquaculture/shared-ui';
import { EscapeReport, EscapeCause } from '../../types/reports.types';
import { REGULATORY_CONTACTS, ESCAPE_CAUSES } from '../../utils/thresholds';
import { useTanksList } from '../../../../hooks/useTanks';

interface EscapeReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (report: Partial<EscapeReport>) => Promise<void>;
  siteId: string;
  siteName: string;
  siteCode?: string;
  gpsCoordinates?: { lat: number; lng: number };
}

interface AffectedUnitEntry {
  id: string;
  tankId: string;
  unitName: string;
  batchNumber: string;
  species: string;
  originalCount: number;
  escapedCount: number;
  avgWeightG: number;
}

interface FormData {
  species: string;
  cause: EscapeCause;
  causeDescription: string;
  affectedUnits: AffectedUnitEntry[];
  recapturedCount: string;
  recaptureMethod: string;
  ongoingEfforts: boolean;
  nearbyWildPopulations: boolean;
  riverSystems: string[];
  newRiver: string;
  preventiveMeasures: string[];
  newMeasure: string;
}

function createEmptyUnit(): AffectedUnitEntry {
  return {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `unit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    tankId: '',
    unitName: '',
    batchNumber: '',
    species: '',
    originalCount: 0,
    escapedCount: 0,
    avgWeightG: 0,
  };
}

const initialFormData: FormData = {
  species: 'Atlantic Salmon',
  cause: 'unknown',
  causeDescription: '',
  affectedUnits: [createEmptyUnit()],
  recapturedCount: '0',
  recaptureMethod: '',
  ongoingEfforts: true,
  nearbyWildPopulations: false,
  riverSystems: [],
  newRiver: '',
  preventiveMeasures: [],
  newMeasure: '',
};

const DEFAULT_SPECIES = ['Atlantic Salmon', 'Rainbow Trout', 'Brown Trout'];

function mapSpeciesToDropdown(speciesCode?: string): string {
  if (!speciesCode) return 'Atlantic Salmon';
  const codeMap: Record<string, string> = {
    SAL: 'Atlantic Salmon',
    SALMON: 'Atlantic Salmon',
    ATLANTIC_SALMON: 'Atlantic Salmon',
    RBT: 'Rainbow Trout',
    RAINBOW_TROUT: 'Rainbow Trout',
    BRT: 'Brown Trout',
    BROWN_TROUT: 'Brown Trout',
  };
  return codeMap[speciesCode.toUpperCase()] || speciesCode;
}

const causeOptions = Object.values(ESCAPE_CAUSES);

export const EscapeReportModal: React.FC<EscapeReportModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  siteId,
  siteName,
  siteCode,
  gpsCoordinates,
}) => {
  const [formData, setFormData] = useState<FormData>(initialFormData);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Submission-level error (e.g. Mattilsynet rejection). Surfaced in a
  // persistent role=alert region; the modal stays OPEN so the operator can
  // act on a legally-immediate report instead of the error being swallowed.
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Fetch tank data for auto-population
  const { data: tanksData } = useTanksList({ isActive: true });
  const tanks = tanksData?.items || [];
  const tankOptions = useMemo(
    () =>
      tanks.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        batchNumber: t.batchMetrics?.batchNumber,
        speciesCode: t.batchMetrics?.speciesCode,
        pieces: t.batchMetrics?.pieces,
        avgWeight: t.batchMetrics?.avgWeight,
        biomass: t.batchMetrics?.biomass,
      })),
    [tanks],
  );

  // Build dynamic species list from tank data + defaults
  const speciesOptions = useMemo(() => {
    const speciesSet = new Set<string>(DEFAULT_SPECIES);
    tankOptions.forEach((t) => {
      if (t.speciesCode) {
        const mapped = mapSpeciesToDropdown(t.speciesCode);
        speciesSet.add(mapped);
      }
    });
    return Array.from(speciesSet);
  }, [tankOptions]);

  // Calculate totals across all affected units
  const totalEscaped = useMemo(() => {
    return formData.affectedUnits.reduce((sum, u) => sum + (u.escapedCount || 0), 0);
  }, [formData.affectedUnits]);

  const totalBiomassKg = useMemo(() => {
    return formData.affectedUnits.reduce((sum, u) => {
      return sum + ((u.escapedCount || 0) * (u.avgWeightG || 0)) / 1000;
    }, 0);
  }, [formData.affectedUnits]);

  const handleChange = useCallback(
    (field: keyof FormData, value: string | boolean | string[] | AffectedUnitEntry[]) => {
      setFormData((prev) => ({ ...prev, [field]: value }));
      if (errors[field]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[field];
          return next;
        });
      }
    },
    [errors],
  );

  const handleUnitChange = useCallback(
    (unitIndex: number, field: keyof AffectedUnitEntry, value: string | number) => {
      setFormData((prev) => {
        const units = [...prev.affectedUnits];
        units[unitIndex] = { ...units[unitIndex], [field]: value };
        return { ...prev, affectedUnits: units };
      });
      // Clear unit-level errors
      const errorKey = `unit_${unitIndex}_${field}`;
      if (errors[errorKey]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[errorKey];
          return next;
        });
      }
    },
    [errors],
  );

  const handleTankSelect = useCallback(
    (unitIndex: number, tankId: string) => {
      const tank = tankOptions.find((t) => t.id === tankId);
      if (tank) {
        setFormData((prev) => {
          const units = [...prev.affectedUnits];
          units[unitIndex] = {
            ...units[unitIndex],
            tankId: tank.id,
            unitName: `${tank.name} (${tank.code})`,
            batchNumber: tank.batchNumber || '',
            species: mapSpeciesToDropdown(tank.speciesCode),
            originalCount: tank.pieces || 0,
            avgWeightG: tank.avgWeight || 0,
            escapedCount: 0,
          };
          // Auto-set the main species from the first unit
          const newSpecies =
            unitIndex === 0 ? mapSpeciesToDropdown(tank.speciesCode) : prev.species;
          return { ...prev, affectedUnits: units, species: newSpecies };
        });
      } else {
        // Clear tank selection
        setFormData((prev) => {
          const units = [...prev.affectedUnits];
          units[unitIndex] = {
            ...units[unitIndex],
            tankId: '',
            unitName: '',
            batchNumber: '',
            species: '',
            originalCount: 0,
            avgWeightG: 0,
            escapedCount: 0,
          };
          return { ...prev, affectedUnits: units };
        });
      }
    },
    [tankOptions],
  );

  const addUnit = useCallback(() => {
    setFormData((prev) => ({
      ...prev,
      affectedUnits: [...prev.affectedUnits, createEmptyUnit()],
    }));
  }, []);

  const removeUnit = useCallback(
    (unitIndex: number) => {
      if (formData.affectedUnits.length <= 1) return;
      setFormData((prev) => ({
        ...prev,
        affectedUnits: prev.affectedUnits.filter((_, i) => i !== unitIndex),
      }));
    },
    [formData.affectedUnits.length],
  );

  const addItem = useCallback(
    (listField: 'riverSystems' | 'preventiveMeasures', inputField: 'newRiver' | 'newMeasure') => {
      const value = formData[inputField].trim();
      if (value) {
        setFormData((prev) => ({
          ...prev,
          [listField]: [...prev[listField], value],
          [inputField]: '',
        }));
      }
    },
    [formData],
  );

  const removeItem = useCallback(
    (listField: 'riverSystems' | 'preventiveMeasures', index: number) => {
      setFormData((prev) => ({
        ...prev,
        [listField]: prev[listField].filter((_, i) => i !== index),
      }));
    },
    [],
  );

  const validateForm = useCallback((): boolean => {
    const newErrors: Record<string, string> = {};

    if (totalEscaped <= 0) {
      newErrors.estimatedCount = 'At least one unit must have escaped fish count > 0';
    }

    if (!formData.species.trim()) {
      newErrors.species = 'Species is required';
    }

    if (!formData.cause) {
      newErrors.cause = 'Cause is required';
    }

    if (!formData.causeDescription.trim()) {
      newErrors.causeDescription = 'Cause description is required';
    }

    // Validate each affected unit
    formData.affectedUnits.forEach((unit, idx) => {
      if (!unit.unitName.trim() && !unit.tankId) {
        newErrors[`unit_${idx}_unitName`] = 'Unit name or tank selection is required';
      }
    });

    if (formData.preventiveMeasures.length === 0) {
      newErrors.preventiveMeasures = 'At least one preventive measure is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [formData, totalEscaped]);

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) return;

    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const now = new Date();
      const avgWeightG =
        formData.affectedUnits.length > 0
          ? Math.round(
              formData.affectedUnits.reduce(
                (sum, u) => sum + (u.avgWeightG || 0) * (u.escapedCount || 0),
                0,
              ) / (totalEscaped || 1),
            )
          : 3500;

      const report: Partial<EscapeReport> = {
        siteId,
        siteName,
        reportType: 'escape',
        status: 'pending',
        escapeStatus: 'detected',
        detectedAt: now,
        contactEmail: REGULATORY_CONTACTS.MATTILSYNET_EMAIL,
        createdAt: now,
        updatedAt: now,
        escape: {
          estimatedCount: totalEscaped,
          species: formData.species,
          speciesId: formData.species === 'Atlantic Salmon' ? 'SALMON' : 'OTHER',
          avgWeightG,
          totalBiomassKg: Math.round(totalBiomassKg * 100) / 100,
          cause: formData.cause,
          causeDescription: formData.causeDescription,
        },
        affectedUnits: formData.affectedUnits.map((unit) => ({
          unitId: unit.tankId || 'unit-temp',
          unitName: unit.unitName || 'Unknown unit',
          unitType: 'cage' as const,
          batchId: unit.batchNumber ? `batch-${unit.batchNumber}` : 'unknown',
          batchNumber: unit.batchNumber || 'unknown',
          originalCount: unit.originalCount || 0,
          escapedCount: unit.escapedCount || 0,
        })),
        recovery: {
          recapturedCount: parseInt(formData.recapturedCount) || 0,
          recaptureMethod: formData.recaptureMethod || undefined,
          ongoingEfforts: formData.ongoingEfforts,
          estimatedRemaining: totalEscaped - (parseInt(formData.recapturedCount) || 0),
        },
        environmentalImpact: {
          nearbyWildPopulations: formData.nearbyWildPopulations,
          riverSystems: formData.riverSystems,
          assessmentRequired: formData.nearbyWildPopulations || formData.riverSystems.length > 0,
        },
        preventiveMeasures: formData.preventiveMeasures,
      };

      await onSubmit(report);
      setFormData(initialFormData);
      onClose();
    } catch (error) {
      // Keep the modal open and surface the failure — a swallowed error on a
      // legally-immediate report would leave the operator believing it was
      // filed when Mattilsynet / Fiskeridirektoratet rejected it.
      setSubmitError(
        error instanceof Error
          ? error.message
          : 'Failed to submit escape report. Please review and retry.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [
    formData,
    siteId,
    siteName,
    siteCode,
    gpsCoordinates,
    onSubmit,
    onClose,
    validateForm,
    totalEscaped,
    totalBiomassKg,
  ]);

  const hasTanks = tankOptions.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Report Fish Escape"
      description={`Immediate report to ${REGULATORY_CONTACTS.MATTILSYNET_EMAIL}`}
      size="lg"
    >
      <div className="max-h-[60vh] overflow-y-auto space-y-6">
        {/* Submission error (persistent, screen-reader announced) */}
        {submitError && (
          <div
            role="alert"
            aria-live="assertive"
            className="rounded-md bg-red-50 border border-red-300 p-3 text-sm text-red-800"
          >
            {submitError}
          </div>
        )}

        {/* Site Info + GPS */}
        <div className="bg-gray-50 rounded-md p-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-gray-500">Site: </span>
              <span className="text-sm font-medium text-gray-900">{siteName}</span>
              {siteCode && <span className="text-sm text-gray-500 ml-2">({siteCode})</span>}
            </div>
            {gpsCoordinates && (
              <div className="text-sm text-gray-500">
                {'\uD83D\uDCCD'} {gpsCoordinates.lat.toFixed(5)}, {gpsCoordinates.lng.toFixed(5)}
              </div>
            )}
          </div>
        </div>

        {/* Total Summary Banner */}
        {totalEscaped > 0 && (
          <div className="bg-red-100 border border-red-300 rounded-md p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-2xl font-bold text-red-700">
                  {totalEscaped.toLocaleString()}
                </div>
                <div className="text-xs text-red-600">Total Escaped Fish</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-red-700">{totalBiomassKg.toFixed(1)}</div>
                <div className="text-xs text-red-600">Total Biomass (kg)</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-red-700">
                  {formData.affectedUnits.length}
                </div>
                <div className="text-xs text-red-600">Affected Units</div>
              </div>
            </div>
            {totalEscaped > 1000 && (
              <div className="mt-3 p-2 bg-red-200 rounded text-center">
                <span className="text-sm font-bold text-red-800">
                  IMMEDIATE REPORTING REQUIRED to Fiskeridirektoratet
                </span>
              </div>
            )}
          </div>
        )}

        {/* Escape Details - Species & Cause */}
        <div className="p-4 bg-red-50 rounded-md border border-red-200">
          <h4 className="text-sm font-medium text-gray-900 mb-3">Escape Details</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-700 mb-1">
                Species <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.species}
                onChange={(e) => handleChange('species', e.target.value)}
                className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.species ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
              >
                {speciesOptions.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}
                  </option>
                ))}
                <option value="Other">Other</option>
              </select>
              {errors.species && <p className="mt-1 text-xs text-red-600">{errors.species}</p>}
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">
                Escape Cause <span className="text-red-500">*</span>
              </label>
              <select
                value={formData.cause}
                onChange={(e) => handleChange('cause', e.target.value as EscapeCause)}
                className={`
                        block w-full rounded-md shadow-sm text-sm
                        ${errors.cause ? 'border-red-300' : 'border-gray-300'}
                        focus:ring-blue-500 focus:border-blue-500
                      `}
              >
                {causeOptions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label} - {option.description}
                  </option>
                ))}
              </select>
              {errors.cause && <p className="mt-1 text-sm text-red-600">{errors.cause}</p>}
            </div>
          </div>
          <div className="mt-4">
            <label className="block text-sm text-gray-700 mb-1">
              Cause Description <span className="text-red-500">*</span>
            </label>
            <textarea
              value={formData.causeDescription}
              onChange={(e) => handleChange('causeDescription', e.target.value)}
              rows={2}
              className={`
                      block w-full rounded-md shadow-sm text-sm
                      ${errors.causeDescription ? 'border-red-300' : 'border-gray-300'}
                      focus:ring-blue-500 focus:border-blue-500
                    `}
              placeholder="Describe how the escape occurred..."
            />
            {errors.causeDescription && (
              <p className="mt-1 text-sm text-red-600">{errors.causeDescription}</p>
            )}
          </div>
        </div>

        {/* Affected Units - Multi-unit support */}
        <div className="p-4 bg-yellow-50 rounded-md border border-yellow-200">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-900">Affected Units</h4>
            <button
              type="button"
              onClick={addUnit}
              className="inline-flex items-center px-2 py-1 text-xs font-medium text-yellow-700 bg-yellow-100 border border-yellow-300 rounded hover:bg-yellow-200 focus:outline-hidden"
            >
              <svg className="w-3 h-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6v6m0 0v6m0-6h6m-6 0H6"
                />
              </svg>
              Add Affected Unit
            </button>
          </div>

          {errors.estimatedCount && (
            <p className="mb-3 text-sm text-red-600">{errors.estimatedCount}</p>
          )}

          <div className="space-y-4">
            {formData.affectedUnits.map((unit, idx) => {
              const escapePercent =
                unit.originalCount > 0
                  ? ((unit.escapedCount / unit.originalCount) * 100).toFixed(1)
                  : null;
              const exceedsStock = unit.originalCount > 0 && unit.escapedCount > unit.originalCount;
              const unitBiomass = ((unit.escapedCount || 0) * (unit.avgWeightG || 0)) / 1000;

              return (
                <div key={unit.id} className="p-3 bg-white rounded-md border border-yellow-200">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-500 uppercase">
                      Unit {idx + 1}
                    </span>
                    {formData.affectedUnits.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeUnit(idx)}
                        className="text-gray-400 hover:text-red-500"
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
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {/* Tank/Unit Selection */}
                    <div className="col-span-2">
                      <label className="block text-sm text-gray-700 mb-1">
                        Cage/Tank <span className="text-red-500">*</span>
                      </label>
                      {hasTanks ? (
                        <select
                          value={unit.tankId}
                          onChange={(e) => handleTankSelect(idx, e.target.value)}
                          className={`
                                  block w-full rounded-md shadow-sm text-sm
                                  ${errors[`unit_${idx}_unitName`] ? 'border-red-300' : 'border-gray-300'}
                                  focus:ring-blue-500 focus:border-blue-500
                                `}
                        >
                          <option value="">Select cage/tank...</option>
                          {tankOptions.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.code}) - {t.batchNumber || 'No batch'}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={unit.unitName}
                          onChange={(e) => handleUnitChange(idx, 'unitName', e.target.value)}
                          className={`
                                  block w-full rounded-md shadow-sm text-sm
                                  ${errors[`unit_${idx}_unitName`] ? 'border-red-300' : 'border-gray-300'}
                                  focus:ring-blue-500 focus:border-blue-500
                                `}
                          placeholder="e.g., Cage 3"
                        />
                      )}
                      {errors[`unit_${idx}_unitName`] && (
                        <p className="mt-1 text-xs text-red-600">
                          {errors[`unit_${idx}_unitName`]}
                        </p>
                      )}
                    </div>

                    {/* Batch Number */}
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">Batch Number</label>
                      <input
                        type="text"
                        value={unit.batchNumber}
                        onChange={(e) => handleUnitChange(idx, 'batchNumber', e.target.value)}
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="e.g., NF-2025-001"
                        readOnly={!!unit.tankId}
                      />
                    </div>

                    {/* Average Weight */}
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">Avg Weight (g)</label>
                      <input
                        type="number"
                        value={unit.avgWeightG || ''}
                        onChange={(e) =>
                          handleUnitChange(idx, 'avgWeightG', parseFloat(e.target.value) || 0)
                        }
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="e.g., 3500"
                      />
                    </div>

                    {/* Original Stock Count */}
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">Original Stock</label>
                      <input
                        type="number"
                        value={unit.originalCount || ''}
                        onChange={(e) =>
                          handleUnitChange(idx, 'originalCount', parseInt(e.target.value) || 0)
                        }
                        className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                        placeholder="Stock before escape"
                        readOnly={!!unit.tankId}
                      />
                    </div>

                    {/* Escaped Count */}
                    <div>
                      <label className="block text-sm text-gray-700 mb-1">
                        Escaped Count <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="number"
                        value={unit.escapedCount || ''}
                        onChange={(e) =>
                          handleUnitChange(idx, 'escapedCount', parseInt(e.target.value) || 0)
                        }
                        className={`
                                block w-full rounded-md shadow-sm text-sm
                                ${exceedsStock ? 'border-orange-400 ring-1 ring-orange-300' : 'border-gray-300'}
                                focus:ring-blue-500 focus:border-blue-500
                              `}
                        placeholder="Number escaped"
                      />
                    </div>
                  </div>

                  {/* Validation warnings */}
                  {exceedsStock && (
                    <div className="mt-2 p-2 bg-orange-50 border border-orange-200 rounded text-xs text-orange-700">
                      Warning: Escape count exceeds original stock (
                      {unit.originalCount.toLocaleString()})
                    </div>
                  )}

                  {/* Escape percentage & biomass info */}
                  {unit.escapedCount > 0 && (
                    <div className="mt-2 flex items-center gap-4 text-xs text-gray-600">
                      {escapePercent !== null && (
                        <span>
                          Estimated escape:{' '}
                          <span className="font-semibold text-red-600">{escapePercent}%</span> of
                          stock
                        </span>
                      )}
                      {unitBiomass > 0 && (
                        <span>
                          Biomass:{' '}
                          <span className="font-semibold">{unitBiomass.toFixed(1)} kg</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Recovery Efforts */}
        <div className="p-4 bg-blue-50 rounded-md border border-blue-200">
          <h4 className="text-sm font-medium text-gray-900 mb-3">Recovery Efforts</h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-700 mb-1">Recaptured Count</label>
              <input
                type="number"
                value={formData.recapturedCount}
                onChange={(e) => handleChange('recapturedCount', e.target.value)}
                className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                placeholder="0"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700 mb-1">Recapture Method</label>
              <input
                type="text"
                value={formData.recaptureMethod}
                onChange={(e) => handleChange('recaptureMethod', e.target.value)}
                className="block w-full rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                placeholder="e.g., Seine netting"
              />
            </div>
          </div>
          <div className="mt-4">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.ongoingEfforts}
                onChange={(e) => handleChange('ongoingEfforts', e.target.checked)}
                className="h-4 w-4 text-blue-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Recovery efforts ongoing</span>
            </label>
          </div>
        </div>

        {/* Environmental Impact */}
        <div className="p-4 bg-green-50 rounded-md border border-green-200">
          <h4 className="text-sm font-medium text-gray-900 mb-3">Environmental Impact</h4>
          <div className="space-y-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={formData.nearbyWildPopulations}
                onChange={(e) => handleChange('nearbyWildPopulations', e.target.checked)}
                className="h-4 w-4 text-blue-600 border-gray-300 rounded"
              />
              <span className="text-sm text-gray-700">Nearby wild salmon populations</span>
            </label>

            <div>
              <label className="block text-sm text-gray-700 mb-1">Nearby River Systems</label>
              <div className="space-y-2">
                {formData.riverSystems.map((river, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 bg-white px-3 py-2 rounded-md border"
                  >
                    <span className="flex-1 text-sm text-gray-700">{river}</span>
                    <button
                      type="button"
                      onClick={() => removeItem('riverSystems', index)}
                      className="text-gray-400 hover:text-red-500"
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
                  </div>
                ))}
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  type="text"
                  value={formData.newRiver}
                  onChange={(e) => handleChange('newRiver', e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addItem('riverSystems', 'newRiver');
                    }
                  }}
                  className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
                  placeholder="Add river system..."
                />
                <button
                  type="button"
                  onClick={() => addItem('riverSystems', 'newRiver')}
                  className="px-3 py-2 bg-white text-gray-700 rounded-md hover:bg-gray-50 text-sm border"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Preventive Measures */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Preventive Measures Implemented <span className="text-red-500">*</span>
          </label>
          <div className="space-y-2">
            {formData.preventiveMeasures.map((measure, index) => (
              <div key={index} className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-md">
                <span className="flex-1 text-sm text-gray-700">{measure}</span>
                <button
                  type="button"
                  onClick={() => removeItem('preventiveMeasures', index)}
                  className="text-gray-400 hover:text-red-500"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={formData.newMeasure}
              onChange={(e) => handleChange('newMeasure', e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addItem('preventiveMeasures', 'newMeasure');
                }
              }}
              className="flex-1 rounded-md border-gray-300 shadow-sm text-sm focus:ring-blue-500 focus:border-blue-500"
              placeholder="e.g., Emergency net repair completed..."
            />
            <button
              type="button"
              onClick={() => addItem('preventiveMeasures', 'newMeasure')}
              className="px-3 py-2 bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 text-sm"
            >
              Add
            </button>
          </div>
          {errors.preventiveMeasures && (
            <p className="mt-1 text-sm text-red-600">{errors.preventiveMeasures}</p>
          )}
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
        <p className="text-xs text-gray-500">
          This report will be sent to Mattilsynet immediately upon submission.
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 flex items-center gap-2"
          >
            {isSubmitting ? (
              <>
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Submitting...
              </>
            ) : (
              'Submit Report'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default EscapeReportModal;
