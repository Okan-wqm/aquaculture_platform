/**
 * Record Feeding Modal
 *
 * Modal for recording actual feeding amount for a tank.
 * Includes feeder equipment selection and feeding method.
 */
import React, { useState, useMemo, useEffect } from 'react';
import { Modal, Button, useToast } from '@aquaculture/shared-ui';
import {
  type DailyFeedingExecution,
  type FeedingMethodType,
  useRecordDailyFeeding,
  calculateFeedingPreview,
  formatNumber,
  sanitizeErrorMessage,
  MAX_FEED_AMOUNT_KG,
} from '../../../hooks/useDailyFeedingExecution';
import { useTankFeeders } from '../../../hooks/useTankFeeders';

// ============================================================================
// FEEDING METHOD OPTIONS
// ============================================================================

const FEEDING_METHODS: { value: FeedingMethodType; label: string }[] = [
  { value: 'manual', label: 'Manuel' },
  { value: 'automatic', label: 'Otomatik' },
  { value: 'demand', label: 'Demand' },
  { value: 'broadcast', label: 'Broadcast' },
  { value: 'spot', label: 'Spot' },
];

// ============================================================================
// COMPONENT
// ============================================================================

interface RecordFeedingModalProps {
  isOpen: boolean;
  onClose: () => void;
  execution: DailyFeedingExecution;
  onSuccess: () => void;
  onSkip: (executionId: string, reason: string) => Promise<void>;
  date: string;
}

export const RecordFeedingModal: React.FC<RecordFeedingModalProps> = ({
  isOpen,
  onClose,
  execution,
  onSuccess,
  onSkip,
  date,
}) => {
  // Use 0 as initial value — not plannedAmountKg — so field is visibly empty and user
  // must enter the actual amount. Prevents accidental submission of planned value (BUG-010).
  const [actualAmountKg, setActualAmountKg] = useState<number>(0);
  const [notes, setNotes] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isSkipMode, setIsSkipMode] = useState(false);
  const [skipReason, setSkipReason] = useState<string>('');
  const [feedingMethod, setFeedingMethod] = useState<FeedingMethodType | undefined>(undefined);
  const [feederEquipmentId, setFeederEquipmentId] = useState<string | undefined>(undefined);

  const recordMutation = useRecordDailyFeeding(date);
  const { toast } = useToast();

  // Fetch feeders for this tank
  const showFeederDropdown = feedingMethod === 'automatic' || feedingMethod === 'demand';
  const { data: feeders } = useTankFeeders(showFeederDropdown ? execution.equipmentId : undefined);

  // Reset state when execution changes — always start with 0 so user enters actual amount
  useEffect(() => {
    if (execution) {
      setActualAmountKg(0);
      setNotes('');
      setError(null);
      setIsSkipMode(false);
      setSkipReason('');
      setFeedingMethod(undefined);
      setFeederEquipmentId(undefined);
    }
  }, [execution?.id]);

  // Preview
  const preview = useMemo(() => {
    if (actualAmountKg <= 0) return null;
    return calculateFeedingPreview(execution, actualAmountKg);
  }, [execution?.id, execution?.fishCount, execution?.biomassKg, execution?.avgWeightG, execution?.expectedSGR, actualAmountKg]);

  // Difference from planned
  const difference = actualAmountKg - execution.plannedAmountKg;
  const differencePercent =
    execution.plannedAmountKg > 0 ? (difference / execution.plannedAmountKg) * 100 : 0;

  const handleAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === '') {
      setActualAmountKg(0);
      setError(null);
      return;
    }
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      setError('Please enter a valid non-negative number');
      return;
    }
    if (parsed > MAX_FEED_AMOUNT_KG) {
      setError(`Maximum feed amount is ${MAX_FEED_AMOUNT_KG.toLocaleString()} kg`);
      // Clamp but do not set — let user correct the input
      return;
    }
    setError(null);
    setActualAmountKg(parsed);
  };

  const handleSubmit = async () => {
    if (actualAmountKg <= 0) {
      setError('Feed amount must be greater than 0');
      return;
    }

    try {
      await recordMutation.mutateAsync({
        executionId: execution.id,
        actualKg: actualAmountKg,
        notes: notes || undefined,
        feedingMethod,
        feederEquipmentId: showFeederDropdown ? feederEquipmentId : undefined,
      });
      toast({
        title: 'Success',
        description: `Feeding recorded for ${execution.tankName}`,
        variant: 'success',
      });
      onSuccess();
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to record feeding:', err);
      const errorMessage = sanitizeErrorMessage(err);
      setError(errorMessage);
      toast({ title: 'Error', description: errorMessage, variant: 'error' });
    }
  };

  const handleSkip = async () => {
    if (!skipReason.trim()) {
      setError('Please provide a reason for skipping');
      return;
    }

    try {
      await onSkip(execution.id, skipReason.trim());
      toast({
        title: 'Feeding Skipped',
        description: `Feeding skipped for ${execution.tankName}`,
        variant: 'info',
      });
      onClose();
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to skip feeding:', err);
      const errorMessage = sanitizeErrorMessage(err);
      setError(errorMessage);
      toast({ title: 'Error', description: errorMessage, variant: 'error' });
    }
  };

  const handleClose = () => {
    setActualAmountKg(0);
    setNotes('');
    setError(null);
    setIsSkipMode(false);
    setSkipReason('');
    setFeedingMethod(undefined);
    setFeederEquipmentId(undefined);
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={isSkipMode ? 'Skip Feeding' : 'Record Feeding'} size="lg">
      <div className="space-y-6">
        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center">
              <span className="text-red-500 mr-2">{'\u26A0\uFE0F'}</span>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          </div>
        )}

        {/* Tank Info */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Tank</p>
              <p className="font-medium text-gray-900">{execution.tankName}</p>
              <p className="text-sm text-gray-500">{execution.tankCode}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Biomass</p>
              <p className="font-medium text-gray-900">{formatNumber(execution.biomassKg, 1)} kg</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Fish Count</p>
              <p className="font-medium text-gray-900">{formatNumber(execution.fishCount, 0)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Feed Type</p>
              <p className="font-medium text-gray-900">{execution.feedName || execution.feedCode || '-'}</p>
            </div>
          </div>
        </div>

        {/* Transition Warning */}
        {execution.isTransitionDay && (
          <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
            <div className="flex items-start">
              <span className="text-xl mr-2">{'\u26A0\uFE0F'}</span>
              <div>
                <h4 className="font-medium text-orange-800">Feed Transition Day</h4>
                <p className="text-sm text-orange-700">
                  Transitioning to <strong>{execution.transitionToFeed}</strong>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Planned Amount */}
        <div className="bg-blue-50 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-blue-800">Planned Amount</p>
              <p className="text-xs text-blue-600">
                Feeding Rate: {formatNumber(execution.feedingRatePercent, 2)}%
              </p>
            </div>
            <p className="text-2xl font-bold text-blue-900">
              {formatNumber(execution.plannedAmountKg, 2)} kg
            </p>
          </div>
        </div>

        {/* Skip Mode */}
        {isSkipMode ? (
          <div>
            <label htmlFor="skipReason" className="block text-sm font-medium text-gray-700">
              Reason for Skipping <span className="text-red-500">*</span>
            </label>
            <textarea
              id="skipReason"
              rows={3}
              maxLength={500}
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Enter reason for skipping this feeding..."
            />
          </div>
        ) : (
          <>
            {/* Actual Feed Given */}
            <div>
              <label htmlFor="actualAmount" className="block text-sm font-medium text-gray-700">
                Actual Feed Given (kg) <span className="text-red-500">*</span>
              </label>
              <div className="mt-1 relative">
                <input
                  type="number"
                  id="actualAmount"
                  min="0"
                  max={MAX_FEED_AMOUNT_KG}
                  step="0.1"
                  value={actualAmountKg || ''}
                  onChange={handleAmountChange}
                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm pr-16"
                  placeholder="Enter actual amount"
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                  <span className="text-gray-500 sm:text-sm">kg</span>
                </div>
              </div>
              {difference !== 0 && (
                <p className={`mt-1 text-sm ${difference > 0 ? 'text-orange-600' : 'text-green-600'}`}>
                  {difference > 0 ? '+' : ''}{formatNumber(difference, 2)} kg ({differencePercent > 0 ? '+' : ''}{formatNumber(differencePercent, 1)}% from plan)
                </p>
              )}
            </div>

            {/* Feeding Method */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Feeding Method</label>
              <div className="grid grid-cols-5 gap-2">
                {FEEDING_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => {
                      setFeedingMethod(feedingMethod === m.value ? undefined : m.value);
                      if (m.value !== 'automatic' && m.value !== 'demand') {
                        setFeederEquipmentId(undefined);
                      }
                    }}
                    className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                      feedingMethod === m.value
                        ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Feeder Equipment (only for automatic/demand) */}
            {showFeederDropdown && (
              <div>
                <label htmlFor="feederEquipment" className="block text-sm font-medium text-gray-700">
                  Feeder Equipment
                </label>
                <select
                  id="feederEquipment"
                  value={feederEquipmentId || ''}
                  onChange={(e) => setFeederEquipmentId(e.target.value || undefined)}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
                >
                  <option value="">-- Select Feeder --</option>
                  {feeders?.map((f) => (
                    <option key={f.id} value={f.id}>{f.name} ({f.code})</option>
                  ))}
                </select>
                {feeders?.length === 0 && (
                  <p className="text-xs text-gray-500 mt-1">No feeder equipment found for this tank</p>
                )}
              </div>
            )}
          </>
        )}

        {/* Preview */}
        {!isSkipMode && preview && actualAmountKg > 0 && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-3">Expected Results</h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">FCR (Estimated)</p>
                {preview.fcr !== null ? (
                  <p className={`text-xl font-bold ${
                    preview.fcr <= 1.2 ? 'text-green-600' : preview.fcr <= 1.5 ? 'text-yellow-600' : 'text-red-600'
                  }`}>
                    {formatNumber(preview.fcr, 2)}
                  </p>
                ) : (
                  <p className="text-xl font-bold text-gray-400" title="Weight gain too small to compute FCR">N/A</p>
                )}
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">Expected Growth</p>
                <p className="text-xl font-bold text-blue-600">+{formatNumber(preview.expectedGrowthG, 1)} g</p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">New Biomass</p>
                <p className="text-xl font-bold text-gray-900">{formatNumber(preview.newBiomassKg, 1)} kg</p>
              </div>
              <div className="bg-white rounded-lg p-3 border border-gray-200">
                <p className="text-xs text-gray-500 mb-1">Actual Feeding Rate</p>
                <p className={`text-xl font-bold ${
                  Math.abs(preview.feedingRateActualPercent - execution.feedingRatePercent) < 0.2
                    ? 'text-green-600' : 'text-orange-600'
                }`}>
                  {formatNumber(preview.feedingRateActualPercent, 2)}%
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Notes */}
        {!isSkipMode && (
          <div>
            <label htmlFor="notes" className="block text-sm font-medium text-gray-700">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              rows={2}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
              placeholder="Add any observations..."
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between pt-4 border-t">
          <div>
            {!isSkipMode && execution.status !== 'COMPLETED' && execution.status !== 'SKIPPED' && (
              <Button variant="secondary" onClick={() => setIsSkipMode(true)} className="text-gray-600 hover:text-gray-800">
                Skip Feeding
              </Button>
            )}
            {isSkipMode && (
              <Button variant="secondary" onClick={() => { setIsSkipMode(false); setSkipReason(''); setError(null); }}>
                Back to Record
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="secondary" onClick={handleClose}>Cancel</Button>
            {isSkipMode ? (
              <Button variant="primary" onClick={handleSkip} disabled={!skipReason.trim()} className="bg-gray-600 hover:bg-gray-700">
                Confirm Skip
              </Button>
            ) : (
              <Button variant="primary" onClick={handleSubmit} disabled={actualAmountKg <= 0 || recordMutation.isPending}>
                {recordMutation.isPending ? 'Saving...' : 'Save & Calculate'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
};
