import { useState, useEffect, useCallback, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Navbar, List, ListInput, Block, Button, BlockTitle } from 'konsta/react';
import { ArrowLeft, Package, CheckCircle, AlertCircle } from 'lucide-react';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import type { QualityGrade } from '@/types';
import { clsx } from 'clsx';

const QUALITY_GRADES: { value: QualityGrade; label: string; color: string }[] = [
  { value: 'PREMIUM', label: 'Premium', color: 'bg-yellow-400' },
  { value: 'GRADE_A', label: 'Grade A', color: 'bg-green-500' },
  { value: 'GRADE_B', label: 'Grade B', color: 'bg-blue-500' },
  { value: 'GRADE_C', label: 'Grade C', color: 'bg-gray-500' },
  { value: 'REJECT', label: 'Reject', color: 'bg-red-500' },
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
  const batch = selectedTank?.currentBatch;
  const maxQuantity = batch?.currentQuantity || 1000;

  // Calculate biomass
  const quantityNum = parseInt(quantity, 10) || 0;
  const avgWeightNum = parseFloat(avgWeight) || 0;
  const totalBiomass = (quantityNum * avgWeightNum) / 1000; // kg
  const priceNum = parseFloat(pricePerKg) || 0;
  const estimatedValue = priceNum > 0 ? totalBiomass * priceNum : 0;

  useEffect(() => {
    if (tankId) setSelectedTankId(tankId);
  }, [tankId]);

  // Pre-fill average weight from batch
  useEffect(() => {
    if (batch && !avgWeight) {
      setAvgWeight(batch.averageWeight.toFixed(0));
    }
  }, [batch, avgWeight]);

  const validateForm = useCallback((): boolean => {
    const newErrors: FormErrors = {};
    if (!selectedTankId) newErrors.tank = 'Please select a tank';
    if (!batch) newErrors.tank = 'Selected tank has no active batch';
    if (quantityNum < 1) newErrors.quantity = 'Quantity must be at least 1';
    if (quantityNum > maxQuantity) newErrors.quantity = `Cannot exceed ${maxQuantity}`;
    if (!Number.isInteger(quantityNum)) newErrors.quantity = 'Must be a whole number';
    if (avgWeightNum <= 0) newErrors.avgWeight = 'Average weight must be greater than 0';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [selectedTankId, batch, quantityNum, avgWeightNum, maxQuantity]);

  const handleSubmit = async () => {
    if (!validateForm() || !batch) return;

    setIsSubmitting(true);
    setErrors({});

    try {
      await addToQueue('createHarvestRecord', {
        batchId: batch.id,
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
        title="Record Harvest"
        left={
          <button onClick={() => navigate(-1)} className="p-2">
            <ArrowLeft size={24} />
          </button>
        }
      />

      {/* Tank/Batch Info */}
      {selectedTank && batch && (
        <Block className="!mt-0 bg-purple-50 dark:bg-purple-900/20">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-purple-100 dark:bg-purple-800 rounded-full flex items-center justify-center">
              <Package className="text-purple-500" size={24} />
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
      {errors.quantity && <p className="text-red-500 text-sm px-4 -mt-2">{errors.quantity}</p>}
      {errors.avgWeight && <p className="text-red-500 text-sm px-4 -mt-2">{errors.avgWeight}</p>}

      {/* Biomass Display */}
      {quantityNum > 0 && avgWeightNum > 0 && (
        <Block>
          <div className="bg-purple-100 dark:bg-purple-900/30 rounded-xl p-4 text-center">
            <div className="text-3xl font-bold text-purple-700 dark:text-purple-300">
              {totalBiomass.toFixed(1)} kg
            </div>
            <div className="text-sm text-purple-600 dark:text-purple-400">Total Biomass</div>
          </div>
        </Block>
      )}

      {/* Quality Grade */}
      <BlockTitle>Quality Grade</BlockTitle>
      <Block>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {QUALITY_GRADES.map((g) => (
            <button
              key={g.value}
              onClick={() => setQualityGrade(g.value)}
              className={clsx(
                'flex-shrink-0 px-4 py-3 rounded-xl border-2 transition-all touch-feedback',
                qualityGrade === g.value
                  ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/30'
                  : 'border-gray-200 dark:border-gray-700'
              )}
            >
              <div className={clsx('w-4 h-4 rounded-full mx-auto mb-1', g.color)} />
              <span className="text-xs font-medium">{g.label}</span>
            </button>
          ))}
        </div>
      </Block>

      {/* Optional Fields */}
      <BlockTitle>Additional Info (Optional)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          label="Price per kg"
          type="number"
          placeholder="0.00"
          value={pricePerKg}
          onInput={handlePriceInput}
        />
        <ListInput
          label="Buyer Name"
          type="text"
          placeholder="Enter buyer name"
          value={buyerName}
          onInput={handleBuyerInput}
        />
        <ListInput
          label="Notes"
          type="textarea"
          placeholder="Additional notes..."
          value={notes}
          onInput={handleNotesInput}
        />
      </List>

      {/* Estimated Value */}
      {estimatedValue > 0 && (
        <Block>
          <div className="bg-green-100 dark:bg-green-900/30 rounded-xl p-4 text-center">
            <div className="text-2xl font-bold text-green-700 dark:text-green-300">
              ₺{estimatedValue.toLocaleString()}
            </div>
            <div className="text-sm text-green-600 dark:text-green-400">Estimated Value</div>
          </div>
        </Block>
      )}

      {/* Submit Button */}
      <Block className="mb-24">
        <Button
          large
          raised
          onClick={handleSubmit}
          disabled={!selectedTankId || !batch || quantityNum < 1 || avgWeightNum < 1 || isSubmitting}
          className="w-full !bg-purple-500"
        >
          {isSubmitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              Recording...
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              <Package size={20} />
              Record Harvest
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
