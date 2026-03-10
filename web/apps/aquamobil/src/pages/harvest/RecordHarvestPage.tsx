import { useState, useEffect, useCallback, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { ArrowLeft, Package, CheckCircle, AlertCircle } from 'lucide-react';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { QualityGrade } from '@/types';
import { clsx } from 'clsx';

const QUALITY_GRADES: { value: QualityGrade; label: string; color: string }[] = [
  { value: 'PREMIUM', label: 'Premium', color: 'bg-amber-400' },
  { value: 'GRADE_A', label: 'Grade A', color: 'bg-sea-500' },
  { value: 'GRADE_B', label: 'Grade B', color: 'bg-ocean-500' },
  { value: 'GRADE_C', label: 'Grade C', color: 'bg-gray-400' },
  { value: 'REJECT', label: 'Reject', color: 'bg-mortality' },
];

interface FormErrors {
  tank?: string;
  quantity?: string;
  avgWeight?: string;
  general?: string;
}

export function RecordHarvestPage() {
  const navigate = useNavigate();
  const { tankId } = useParams<{ tankId?: string }>();
  const { data: tanks } = useTanks();
  const { addToQueue, isOnline } = useOfflineQueue();

  const [selectedTankId, setSelectedTankId] = useState(tankId || '');
  const [quantity, setQuantity] = useState('');
  const [avgWeight, setAvgWeight] = useState('');
  const [qualityGrade, setQualityGrade] = useState<QualityGrade>('GRADE_A');
  const [pricePerKg, setPricePerKg] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  const selectedTank = tanks?.find((t) => t.id === selectedTankId);
  const metrics = selectedTank?.batchMetrics;
  const maxQuantity = metrics?.pieces || 1000;

  const quantityNum = parseInt(quantity, 10) || 0;
  const avgWeightNum = parseFloat(avgWeight) || 0;
  const totalBiomass = (quantityNum * avgWeightNum) / 1000;
  const priceNum = parseFloat(pricePerKg) || 0;
  const estimatedValue = priceNum > 0 ? totalBiomass * priceNum : 0;

  useEffect(() => {
    if (tankId) setSelectedTankId(tankId);
  }, [tankId]);

  useEffect(() => {
    if (metrics?.avgWeight != null && !avgWeight) {
      setAvgWeight(metrics.avgWeight.toFixed(0));
    }
  }, [metrics, avgWeight]);

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTankId) newErrors.tank = 'Please select a tank';
    if (!metrics) newErrors.tank = 'Selected tank has no active batch';
    if (quantityNum < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (quantityNum > maxQuantity) newErrors.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantityNum)) newErrors.quantity = 'Must be a whole number';
    if (avgWeightNum <= 0) newErrors.avgWeight = 'Average weight must be greater than 0';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTankId, metrics, quantityNum, avgWeightNum, maxQuantity]);

  const handleSubmit = async () => {
    if (!validateForm() || !metrics?.batchId) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('createHarvestRecord', {
        batchId: metrics.batchId,
        tankId: selectedTankId,
        quantityHarvested: quantityNum,
        averageWeight: avgWeightNum,
        totalBiomass,
        qualityGrade,
        harvestDate: new Date().toISOString().split('T')[0],
        pricePerKg: priceNum > 0 ? priceNum : undefined,
        buyerName: buyerName.trim() || undefined,
        notes: notes.trim() || undefined,
      });

      setShowSuccess(true);
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to record harvest';
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTankChange = (e: ChangeEvent<HTMLSelectElement>) => {
    setSelectedTankId(e.target.value);
    setErrors((prev) => ({ ...prev, tank: undefined }));
  };

  const handleQuantityInput = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9]/g, '');
    const num = parseInt(val, 10) || 0;
    setQuantity(Math.min(num, maxQuantity).toString());
    setErrors((prev) => ({ ...prev, quantity: undefined }));
  };

  const handleAvgWeightInput = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9.]/g, '');
    setAvgWeight(val);
    setErrors((prev) => ({ ...prev, avgWeight: undefined }));
  };

  const handlePriceInput = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/[^0-9.]/g, '');
    setPricePerKg(val);
  };

  const handleBuyerInput = (e: ChangeEvent<HTMLInputElement>) => {
    setBuyerName(e.target.value);
  };

  const handleNotesInput = (e: ChangeEvent<HTMLTextAreaElement>) => {
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

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      {/* Header */}
      <div className="bg-gradient-to-r from-violet-700 to-harvest text-white">
        <div className="flex items-center gap-3 px-4 py-4 pt-safe-top">
          <button onClick={() => navigate(-1)} className="p-2 -ml-2 rounded-xl hover:bg-white/10 touch-feedback">
            <ArrowLeft size={22} />
          </button>
          <div className="flex items-center gap-2.5">
            <Package size={22} />
            <h1 className="text-lg font-bold">Record Harvest</h1>
          </div>
        </div>
      </div>

      {/* Tank/Batch Info */}
      {selectedTank && metrics && (
        <div className="mx-4 mt-4 bg-white dark:bg-gray-900 rounded-2xl shadow-card p-4 border border-gray-100 dark:border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 bg-purple-50 dark:bg-purple-900/20 rounded-xl flex items-center justify-center">
              <Package className="text-harvest" size={22} />
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
            </ListInput>
          </List>
          {errors.tank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.tank}</p>}
        </>
      )}

      {/* Harvest Details */}
      <BlockTitle>Harvest Details</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          label="Quantity (fish)"
          type="number"
          placeholder="Enter fish count"
          value={quantity}
          onInput={handleQuantityInput}
          error={errors.quantity}
        />
        <ListInput
          label="Avg Weight (g)"
          type="number"
          placeholder="Average weight in grams"
          value={avgWeight}
          onInput={handleAvgWeightInput}
          error={errors.avgWeight}
        />
      </List>
      {/* BUG-10: Removed duplicate error paragraphs. ListInput's error prop already
          displays inline errors; these duplicate <p> elements created double display. */}

      {/* Biomass Display */}
      {quantityNum > 0 && avgWeightNum > 0 && (
        <div className="px-4 mt-3">
          <div className="bg-gradient-to-r from-harvest/10 to-violet-600/10 dark:from-harvest/20 dark:to-violet-600/20 rounded-2xl p-4 text-center border border-harvest/20">
            <div className="text-3xl font-bold text-harvest dark:text-violet-300">
              {totalBiomass.toFixed(1)} kg
            </div>
            <div className="text-sm text-harvest/70 dark:text-violet-400 font-medium">Total Biomass</div>
          </div>
        </div>
      )}

      {/* Quality Grade */}
      <div className="px-4 mt-5">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">Quality Grade</h3>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {QUALITY_GRADES.map((g) => (
            <button
              key={g.value}
              onClick={() => setQualityGrade(g.value)}
              className={clsx(
                'flex-shrink-0 px-4 py-3 rounded-2xl border-2 transition-all touch-feedback bg-white dark:bg-gray-900',
                qualityGrade === g.value
                  ? 'border-harvest bg-purple-50 dark:bg-purple-900/20 shadow-glow-purple'
                  : 'border-gray-100 dark:border-gray-800'
              )}
            >
              <div className={clsx('w-4 h-4 rounded-full mx-auto mb-1.5', g.color)} />
              <span className="text-xs font-semibold">{g.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Optional Fields */}
      <BlockTitle>Additional Info (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput label="Price per kg" type="number" placeholder="0.00" value={pricePerKg} onInput={handlePriceInput} />
        <ListInput label="Buyer Name" type="text" placeholder="Enter buyer name" value={buyerName} onInput={handleBuyerInput} />
        <ListInput label="Notes" type="textarea" placeholder="Additional notes..." value={notes} onInput={handleNotesInput} />
      </List>

      {/* Estimated Value */}
      {estimatedValue > 0 && (
        <div className="px-4 mt-1">
          <div className="bg-gradient-to-r from-sea-500/10 to-sea-600/10 dark:from-sea-500/20 dark:to-sea-600/20 rounded-2xl p-4 text-center border border-sea-500/20">
            <div className="text-2xl font-bold text-sea-700 dark:text-sea-300">
              {estimatedValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
            </div>
            <div className="text-sm text-sea-600/70 dark:text-sea-400 font-medium">Estimated Value</div>
          </div>
        </div>
      )}

      {/* Submit Button */}
      <div className="px-4 pt-5 pb-28">
        <button
          onClick={handleSubmit}
          disabled={!selectedTankId || !metrics?.batchId || quantityNum < 1 || avgWeightNum < 1 || isSubmitting}
          className="w-full py-4 bg-gradient-to-r from-violet-700 to-harvest text-white font-bold rounded-2xl shadow-lg shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              Recording...
            </>
          ) : (
            <>
              <Package size={20} />
              Record Harvest
            </>
          )}
        </button>
        {!isOnline && (
          <p className="text-center text-amber-500 text-sm mt-3 font-medium">
            Offline - will sync when connected
          </p>
        )}
      </div>
    </div>
  );
}
