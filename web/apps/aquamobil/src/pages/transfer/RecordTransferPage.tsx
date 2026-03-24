import { useState, useEffect, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowLeftRight, CheckCircle, AlertCircle, ChevronRight } from 'lucide-react';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';

interface FormErrors {
  sourceTank?: string;
  destinationTank?: string;
  quantity?: string;
  general?: string;
}

// WHY: Confirmation step prevents accidental transfers — moving fish between tanks
// is operationally significant and cannot be easily reversed.
type FormStep = 'entry' | 'confirm';

export function RecordTransferPage() {
  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();
  const { addToQueue, isOnline } = useOfflineQueue();

  const [sourceTankId, setSourceTankId] = useState(tankId || '');
  const [destinationTankId, setDestinationTankId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [biomassKg, setBiomassKg] = useState('');
  const [transferReason, setTransferReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [step, setStep] = useState<FormStep>('entry');

  useEffect(() => {
    if (tankId) setSourceTankId(tankId);
  }, [tankId]);

  const sourceTank = tanks?.find((t) => t.id === sourceTankId);
  const sourceMetrics = sourceTank?.batchMetrics;
  const destTank = tanks?.find((t) => t.id === destinationTankId);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};
    if (!sourceTankId) newErrors.sourceTank = 'Please select source tank';
    if (!sourceMetrics) newErrors.sourceTank = 'Selected tank has no active batch';
    if (!destinationTankId) newErrors.destinationTank = 'Please select destination tank';
    if (sourceTankId === destinationTankId) newErrors.destinationTank = 'Source and destination tank cannot be the same';
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (sourceMetrics && qty > (sourceMetrics.pieces ?? 0)) {
      newErrors.quantity = `Quantity cannot exceed ${sourceMetrics.pieces} pieces`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleReview = () => {
    if (!validateForm()) return;
    setStep('confirm');
  };

  const handleSubmit = async () => {
    if (!validateForm()) return;
    if (!sourceMetrics?.batchId) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('recordTransfer', {
        batchId: sourceMetrics.batchId,
        sourceTankId,
        destinationTankId,
        quantity: parseInt(quantity, 10),
        biomassKg: biomassKg ? parseFloat(biomassKg) : undefined,
        transferReason: transferReason.trim() || undefined,
        transferredAt: new Date().toISOString(),
      });

      setShowSuccess(true);
      setTimeout(() => navigate(-1), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save transfer';
      setErrors({ general: message });
      setStep('entry');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (showSuccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-sea-50 dark:bg-sea-900/10">
        <div className="w-20 h-20 bg-sea-100 dark:bg-sea-900/30 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-sea-600" />
        </div>
        <h2 className="text-xl font-bold text-sea-700 dark:text-sea-300">Saved!</h2>
        <p className="text-sea-600 dark:text-sea-400 text-sm mt-1">
          Queued for synchronization
        </p>
      </div>
    );
  }

  // WHY: Confirmation screen shows source, destination, and quantity in a clear summary card.
  // This is critical for transfers because wrong tank assignments cause inventory confusion.
  if (step === 'confirm') {
    const qty = parseInt(quantity, 10);
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="bg-gradient-to-r from-blue-600 to-blue-500 text-white">
          <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
            <button onClick={() => setStep('entry')} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
              <ArrowLeft size={22} />
            </button>
            <div className="flex items-center gap-2.5">
              <ArrowLeftRight size={22} />
              <h1 className="text-lg font-bold">Confirm Transfer</h1>
            </div>
          </div>
        </div>

        <div className="px-4 mt-5">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-lg border border-gray-100 dark:border-gray-800 overflow-hidden">
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 border-b border-blue-100 dark:border-blue-800/50">
              <h3 className="text-sm font-bold text-blue-700 dark:text-blue-300 uppercase tracking-wider">Transfer Summary</h3>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">From</span>
                <span className="font-semibold text-gray-900 dark:text-white">{sourceTank?.name}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Batch</span>
                <span className="font-semibold text-gray-900 dark:text-white">{sourceMetrics?.batchNumber ?? '--'}</span>
              </div>
              <div className="flex justify-center">
                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                  <ArrowLeftRight size={16} className="text-blue-600" />
                </div>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">To</span>
                <span className="font-semibold text-gray-900 dark:text-white">
                  {destTank?.name}{!destTank?.batchMetrics ? ' (Empty)' : ''}
                </span>
              </div>
              <div className="h-px bg-gray-100 dark:bg-gray-800" />
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500">Quantity</span>
                <span className="text-2xl font-bold text-blue-600">{qty.toLocaleString()} pcs</span>
              </div>
              {biomassKg && (
                <div className="flex justify-between items-center">
                  <span className="text-sm text-gray-500">Biomass</span>
                  <span className="font-semibold text-gray-900 dark:text-white">{parseFloat(biomassKg).toFixed(1)} kg</span>
                </div>
              )}
              {transferReason.trim() && (
                <>
                  <div className="h-px bg-gray-100 dark:bg-gray-800" />
                  <div>
                    <span className="text-sm text-gray-500">Reason</span>
                    <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{transferReason}</p>
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
            className="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <>
                <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
                Saving...
              </>
            ) : (
              <>
                <ArrowLeftRight size={20} />
                Confirm Transfer
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
      <div className="bg-gradient-to-r from-blue-600 to-blue-500 text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <ArrowLeftRight size={22} />
            <h1 className="text-lg font-bold">Transfer Record</h1>
          </div>
        </div>
      </div>

      {/* Source tank info */}
      {sourceTank && sourceMetrics && (
        <div className="mx-4 mt-4 bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-blue-50 dark:bg-blue-900/20 rounded-xl flex items-center justify-center">
              <ArrowLeftRight className="text-blue-600" size={22} />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{sourceTank.name}</h3>
              <p className="text-sm text-gray-500">
                {sourceMetrics.batchNumber ?? '--'} &middot; {(sourceMetrics.pieces ?? 0).toLocaleString()} pcs
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {errors.general && (
        <div className="mx-4 mt-3 bg-red-50 dark:bg-red-900/20 rounded-xl p-3 flex items-center gap-2 border border-red-200 dark:border-red-800">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <span className="text-red-600 dark:text-red-300 text-sm">{errors.general}</span>
        </div>
      )}

      {/* Source tank selector */}
      {/* WHY: Source must have an active batch — you can only transfer fish that exist in a batch context */}
      {!tankId && (
        <>
          <BlockTitle>Source Tank</BlockTitle>
          <List strongIos insetIos>
            <ListInput
              type="select"
              value={sourceTankId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                setSourceTankId(e.target.value);
                setErrors((prev) => ({ ...prev, sourceTank: undefined }));
              }}
              error={errors.sourceTank}
            >
              <option value="">-- Select Tank --</option>
              {tanks?.filter((t) => t.batchMetrics).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} - {t.batchMetrics?.batchNumber ?? '--'}
                </option>
              ))}
              {/* WHY: Show batchless tanks as disabled so users know the tank exists but has no fish to transfer */}
              {tanks?.filter((t) => !t.batchMetrics).map((t) => (
                <option key={t.id} value="" disabled>
                  {t.name} (No active batch)
                </option>
              ))}
            </ListInput>
          </List>
          {errors.sourceTank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.sourceTank}</p>}
        </>
      )}

      {/* Destination tank selector */}
      {/* WHY: Destination tanks are sorted — empty tanks first (ideal transfer targets), then tanks with
          batches. The source tank is excluded to prevent self-transfer. Capacity info helps users choose. */}
      <BlockTitle>Destination Tank</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="select"
          value={destinationTankId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            setDestinationTankId(e.target.value);
            setErrors((prev) => ({ ...prev, destinationTank: undefined }));
          }}
          error={errors.destinationTank}
        >
          <option value="">-- Select Tank --</option>
          {/* WHY: Empty tanks appear first — they are the preferred transfer destination (no mixing risk) */}
          {tanks?.filter((t) => t.id !== sourceTankId && !t.batchMetrics).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} (Empty{t.maxBiomass > 0 ? ` - ${t.maxBiomass}kg capacity` : ''})
            </option>
          ))}
          {/* WHY: Tanks with batches are shown below — user may want to merge batches, but with a clear label */}
          {tanks?.filter((t) => t.id !== sourceTankId && t.batchMetrics).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} - {t.batchMetrics?.batchNumber} ({(t.batchMetrics?.pieces ?? 0).toLocaleString()} fish)
            </option>
          ))}
        </ListInput>
      </List>
      {errors.destinationTank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.destinationTank}</p>}

      {/* Quantity */}
      <BlockTitle>Quantity</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="number"
          placeholder="Number of pieces to transfer"
          value={quantity}
          onInput={(e: ChangeEvent<HTMLInputElement>) => {
            setQuantity(e.target.value);
            setErrors((prev) => ({ ...prev, quantity: undefined }));
          }}
          error={errors.quantity}
        />
      </List>
      {errors.quantity && <p className="text-red-500 text-sm px-4 -mt-2">{errors.quantity}</p>}

      {/* Biomass */}
      <BlockTitle>Biomass (kg) - Optional</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="number"
          placeholder="Total biomass kg"
          value={biomassKg}
          onInput={(e: ChangeEvent<HTMLInputElement>) => setBiomassKg(e.target.value)}
        />
      </List>

      {/* Transfer reason */}
      <BlockTitle>Transfer Reason (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="textarea"
          placeholder="Transfer reason..."
          value={transferReason}
          onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setTransferReason(e.target.value)}
          inputClassName="!h-20"
        />
      </List>

      {/* WHY: "Review" button triggers confirmation step — transfer operations affect two tanks simultaneously */}
      <div className="px-4 pb-28">
        <button
          onClick={handleReview}
          disabled={!sourceTankId || !destinationTankId || !quantity}
          className="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
        >
          <ArrowLeftRight size={20} />
          Review Transfer
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
