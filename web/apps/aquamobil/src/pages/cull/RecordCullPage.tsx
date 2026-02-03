import { useState, useEffect, useCallback, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Navbar, List, ListInput, Block, Button, BlockTitle } from 'konsta/react';
import { ArrowLeft, Scissors, CheckCircle, AlertCircle, Minus, Plus } from 'lucide-react';
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
  { value: 'OTHER', label: 'Other', emoji: '📝' },
];

interface FormErrors {
  tank?: string;
  quantity?: string;
  general?: string;
}

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

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const batch = selectedTank?.currentBatch;
  const maxQuantity = batch?.currentQuantity || 1000;

  useEffect(() => {
    if (tankId) setSelectedTankId(tankId);
  }, [tankId]);

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTankId) newErrors.tank = 'Please select a tank';
    if (!batch) newErrors.tank = 'Selected tank has no active batch';
    if (quantity < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (quantity > maxQuantity) newErrors.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantity)) newErrors.quantity = 'Must be a whole number';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTankId, batch, quantity, maxQuantity]);

  const handleSubmit = async () => {
    if (!validateForm() || !batch) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('recordCull', {
        batchId: batch.id,
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
      <div className="flex flex-col items-center justify-center min-h-screen bg-green-50 dark:bg-green-900/20">
        <CheckCircle size={64} className="text-green-500 mb-4" />
        <h2 className="text-xl font-bold text-green-700 dark:text-green-300">Recorded!</h2>
        <p className="text-green-600 dark:text-green-400 text-sm">
          {isOnline ? 'Saved to server' : 'Queued for sync'}
        </p>
      </div>
    );
  }

  return (
    <>
      <Navbar
        title="Record Cull"
        left={
          <button onClick={() => navigate(-1)} className="p-2">
            <ArrowLeft size={24} />
          </button>
        }
      />

      {/* Tank/Batch Info */}
      {selectedTank && batch && (
        <Block className="!mt-0 bg-orange-50 dark:bg-orange-900/20">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-orange-100 dark:bg-orange-800 rounded-full flex items-center justify-center">
              <Scissors className="text-orange-500" size={24} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{selectedTank.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {batch.speciesName} • {batch.currentQuantity.toLocaleString()} fish
              </p>
            </div>
          </div>
        </Block>
      )}

      {/* Error Banner */}
      {errors.general && (
        <Block className="!mt-0 bg-red-100 dark:bg-red-900/30">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300">
            <AlertCircle size={20} />
            <span>{errors.general}</span>
          </div>
        </Block>
      )}

      {/* Tank Selector */}
      {!tankId && (
        <>
          <BlockTitle>Select Tank</BlockTitle>
          <List strongIos insetIos>
            <ListInput
              type="select"
              value={selectedTankId}
              onChange={handleTankChange}
              error={errors.tank}
            >
              <option value="">-- Select Tank --</option>
              {tanks
                ?.filter((t) => t.currentBatch)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} - {t.currentBatch?.speciesName}
                  </option>
                ))}
            </ListInput>
          </List>
          {errors.tank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.tank}</p>}
        </>
      )}

      {/* Quantity */}
      <BlockTitle>Culled Fish Count</BlockTitle>
      <Block>
        <div className="flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => handleQuantityChange(quantity - 1)}
            disabled={quantity <= 1}
            className="w-14 h-14 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center disabled:opacity-50 touch-feedback"
          >
            <Minus size={24} className="text-orange-600" />
          </button>
          <div className="text-4xl font-bold text-gray-900 dark:text-white min-w-[80px] text-center">
            {quantity}
          </div>
          <button
            type="button"
            onClick={() => handleQuantityChange(quantity + 1)}
            disabled={quantity >= maxQuantity}
            className="w-14 h-14 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center disabled:opacity-50 touch-feedback"
          >
            <Plus size={24} className="text-orange-600" />
          </button>
        </div>
        <p className="text-center text-sm text-gray-500 mt-3">
          Max: {maxQuantity.toLocaleString()} fish in tank
        </p>
        {errors.quantity && <p className="text-red-500 text-sm text-center mt-2">{errors.quantity}</p>}
      </Block>

      {/* Reason Selector */}
      <BlockTitle>Cull Reason</BlockTitle>
      <Block>
        <div className="grid grid-cols-3 gap-2">
          {CULL_REASONS.map((r) => (
            <button
              key={r.value}
              onClick={() => setReason(r.value)}
              className={clsx(
                'flex flex-col items-center p-3 rounded-xl border-2 transition-all touch-feedback',
                reason === r.value
                  ? 'border-orange-500 bg-orange-50 dark:bg-orange-900/30'
                  : 'border-gray-200 dark:border-gray-700'
              )}
            >
              <span className="text-2xl mb-1">{r.emoji}</span>
              <span className="text-xs font-medium text-center">{r.label}</span>
            </button>
          ))}
        </div>
      </Block>

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

      {/* Submit Button */}
      <Block className="mb-24">
        <Button
          large
          raised
          onClick={handleSubmit}
          disabled={!selectedTankId || !batch || quantity < 1 || isSubmitting}
          className="w-full !bg-orange-500"
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              Recording...
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Scissors size={20} />
              Record {quantity} Culled Fish
            </span>
          )}
        </Button>
        {!isOnline && (
          <p className="text-center text-amber-600 dark:text-amber-400 text-sm mt-2">
            Offline - will sync when connected
          </p>
        )}
      </Block>
    </>
  );
}
