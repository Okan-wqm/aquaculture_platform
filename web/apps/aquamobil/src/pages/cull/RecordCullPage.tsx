import { useState, useEffect, useCallback, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { ArrowLeft, Scissors, CheckCircle, AlertCircle, Minus, Plus, ChevronRight } from 'lucide-react';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { CullReason } from '@/types';
import { clsx } from 'clsx';

const CULL_REASONS: { value: CullReason; label: string; emoji: string }[] = [
  { value: 'SMALL_SIZE', label: 'Small Size', emoji: '📏' },
  { value: 'DEFORMED', label: 'Deformed', emoji: '🔄' },
  { value: 'SICK', label: 'Sick', emoji: '🤒' },
  { value: 'POOR_GROWTH', label: 'Poor Growth', emoji: '📉' },
  { value: 'GRADING', label: 'Grading', emoji: '⚖️' },
  { value: 'QUALITY', label: 'Quality', emoji: '🏅' },
  { value: 'OTHER', label: 'Other', emoji: '📝' },
];

interface FormErrors {
  tank?: string;
  quantity?: string;
  general?: string;
}

// WHY: Confirmation step prevents accidental cull records — culling affects inventory and
// batch performance metrics, so a review step reduces data entry errors in the field.
type FormStep = 'entry' | 'confirm';

export function RecordCullPage() {
  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();
  const { addToQueue, isOnline } = useOfflineQueue();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState<CullReason>('GRADING');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [step, setStep] = useState<FormStep>('entry');

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const maxQuantity = metrics?.pieces || 1000;
  const selectedReason = CULL_REASONS.find((r) => r.value === reason);

  useEffect(() => {
    if (tankId) setSelectedTankId(tankId);
  }, [tankId]);

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTankId) newErrors.tank = 'Please select a tank';
    if (!metrics) newErrors.tank = 'Selected tank has no active batch';
    if (quantity < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (quantity > maxQuantity) newErrors.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantity)) newErrors.quantity = 'Must be a whole number';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTankId, metrics, quantity, maxQuantity]);

  const handleReview = () => {
    if (!validateForm()) return;
    setStep('confirm');
  };

  const handleSubmit = async () => {
    if (!validateForm() || !metrics?.batchId) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('recordCull', {
        batchId: metrics.batchId,
        tankId: selectedTankId,
        quantity,
        reason,
        notes: notes.trim() || undefined,
        culledAt: new Date().toISOString(),
      });

      setShowSuccess(true);
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record cull';
      setErrors({ general: message });
      setStep('entry');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTankChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setSelectedTankId(e.target.value);
    setErrors((prev) => ({ ...prev, tank: undefined }));
  };

  const handleQuantityChange = (val: number) => {
    setQuantity(Math.floor(Math.max(1, Math.min(val, maxQuantity))));
    setErrors((prev) => ({ ...prev, quantity: undefined }));
  };

  const handleNotesChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setNotes(e.target.value);
  };

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-sea-50 dark:bg-sea-900/10">
        <div className="w-20 h-20 bg-sea-100 dark:bg-sea-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-sea-600" />
        </div>
        <h2 className="text-xl font-bold text-sea-700 dark:text-sea-300">Recorded!</h2>
        {/* BUG-08: All submissions go through the offline queue; always show accurate message. */}
        <p className="text-sea-600 dark:text-sea-400 text-sm mt-1">
          Queued for sync
        </p>
      </div>
    );
  }

  // WHY: Confirmation screen — identical pattern to mortality for consistency across all record pages.
  if (step === 'confirm') {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-orange-600 to-cull text-white">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button onClick={() => setStep('entry')} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <Scissors size={22} />
              <h1 className="text-lg font-bold">Confirm Cull</h1>
            </div>
          </div>
        </div>

        <div className="px-4 mt-5">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
            <div className="bg-orange-50 dark:bg-orange-900/20 p-4 border-b border-orange-100 dark:border-orange-800/50">
              <h3 className="text-sm font-bold text-orange-700 dark:text-orange-300 uppercase tracking-wider">Cull Summary</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Tank</span>
                <span className="font-semibold text-gray-900 dark:text-white">{selectedTank?.name}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Batch</span>
                <span className="font-semibold text-gray-900 dark:text-white">{metrics?.batchNumber ?? '--'}</span>
              </div>
              <div className="h-px bg-gray-100 dark:bg-gray-800" />
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Culled Fish</span>
                <span className="text-2xl font-bold text-cull">{quantity}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Reason</span>
                <span className="font-semibold text-gray-900 dark:text-white">
                  {selectedReason?.emoji} {selectedReason?.label}
                </span>
              </div>
              {notes.trim() && (
                <>
                  <div className="h-px bg-gray-100 dark:bg-gray-800" />
                  <div>
                    <span className="text-sm text-gray-500">Notes</span>
                    <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{notes}</p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {errors.general && (
          <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
            <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
            <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
          </div>
        )}

        <div className="px-4 mt-6 space-y-3 pb-28">
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="w-full py-4 bg-gradient-to-r from-orange-600 to-cull text-white font-bold rounded-2xl shadow-lg shadow-orange-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                Recording...
              </>
            ) : (
              <>
                <Scissors size={20} />
                Confirm & Record
              </>
            )}
          </button>
          <button
            onClick={() => setStep('entry')}
            disabled={isSubmitting}
            className="w-full py-3 text-gray-500 font-semibold rounded-2xl border border-gray-200 dark:border-gray-700 touch-feedback transition-all"
          >
            Go Back & Edit
          </button>
          {!isOnline && (
            <p className="text-center text-amber-500 text-sm font-medium">
              Offline -- will sync when connected
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-600 to-cull text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Scissors size={22} />
            <h1 className="text-lg font-bold">Record Cull</h1>
          </div>
        </div>
      </div>

      {/* Tank/Batch Info */}
      {selectedTank && metrics && (
        <div className="mx-4 mt-4 bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-orange-50 dark:bg-orange-900/20 rounded-xl flex items-center justify-center">
              <Scissors className="text-cull" size={22} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{selectedTank.name}</h3>
              <p className="text-sm text-gray-500">
                {metrics.batchNumber ?? '--'} &middot; {(metrics.pieces ?? 0).toLocaleString()} fish
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error Banner */}
      {errors.general && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
        </div>
      )}

      {/* Tank Selector */}
      {/* WHY: Only tanks with active batches are selectable — culling requires a batch context for inventory tracking */}
      {!tankId && (
        <>
          <BlockTitle>Select Tank</BlockTitle>
          <List strongIos insetIos>
            <ListInput type="select" value={selectedTankId} onChange={handleTankChange} error={errors.tank}>
              <option value="">-- Select Tank --</option>
              {tanks?.filter((t) => t.batchMetrics).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} - {t.batchMetrics?.batchNumber ?? '--'}
                </option>
              ))}
              {tanks?.filter((t) => !t.batchMetrics).map((t) => (
                <option key={t.id} value="" disabled>
                  {t.name} (No active batch)
                </option>
              ))}
            </ListInput>
          </List>
          {errors.tank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.tank}</p>}
        </>
      )}

      {/* Quantity */}
      <div className="px-4 mt-5">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Culled Fish Count</h3>
        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-card p-5 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center justify-center gap-5">
            <button
              type="button"
              onClick={() => handleQuantityChange(quantity - 1)}
              disabled={quantity <= 1}
              className="w-14 h-14 rounded-2xl bg-orange-50 dark:bg-orange-900/20 flex items-center justify-center disabled:opacity-30 touch-feedback border border-orange-100 dark:border-orange-800"
            >
              <Minus size={22} className="text-cull" />
            </button>
            <div className="text-5xl font-bold text-gray-900 dark:text-white min-w-[90px] text-center tabular-nums">
              {quantity}
            </div>
            <button
              type="button"
              onClick={() => handleQuantityChange(quantity + 1)}
              disabled={quantity >= maxQuantity}
              className="w-14 h-14 rounded-2xl bg-orange-50 dark:bg-orange-900/20 flex items-center justify-center disabled:opacity-30 touch-feedback border border-orange-100 dark:border-orange-800"
            >
              <Plus size={22} className="text-cull" />
            </button>
          </div>
          <p className="text-center text-xs text-gray-400 mt-3 font-medium">
            Max: {maxQuantity.toLocaleString()} fish in tank
          </p>
          {errors.quantity && <p className="text-red-500 text-sm text-center mt-2">{errors.quantity}</p>}
        </div>
      </div>

      {/* Reason Selector */}
      <div className="px-4 mt-5">
        <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Cull Reason</h3>
        <div className="grid grid-cols-4 gap-2">
          {CULL_REASONS.map((r) => (
            <button
              key={r.value}
              onClick={() => setReason(r.value)}
              className={clsx(
                'flex flex-col items-center p-3 rounded-2xl border-2 transition-all duration-150 ease-out touch-feedback bg-white dark:bg-gray-900',
                reason === r.value
                  ? 'border-cull bg-orange-50 dark:bg-orange-900/20 shadow-glow-orange scale-[1.02]'
                  : 'border-gray-100 dark:border-gray-800'
              )}
            >
              <span className="text-xl mb-1">{r.emoji}</span>
              <span className="text-[10px] font-semibold text-center leading-tight">{r.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Notes */}
      <BlockTitle>Notes (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="textarea"
          placeholder="Additional observations..."
          value={notes}
          onInput={handleNotesChange}
          inputClassName="!h-24"
        />
      </List>

      {/* WHY: "Review" button instead of direct submit — confirmation step prevents accidental entries */}
      <div className="px-4 pb-28">
        <button
          onClick={handleReview}
          disabled={!selectedTankId || !metrics?.batchId || quantity < 1}
          className="w-full py-4 bg-gradient-to-r from-orange-600 to-cull text-white font-bold rounded-2xl shadow-lg shadow-orange-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
        >
          <Scissors size={20} />
          Review {quantity} Culled Fish
          <ChevronRight size={18} className="ml-1" />
        </button>
        {!isOnline && (
          <p className="text-center text-amber-500 text-sm mt-3 font-medium">
            Offline -- will sync when connected
          </p>
        )}
      </div>
    </div>
  );
}
