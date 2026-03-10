import { useState, useEffect, ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowLeftRight, CheckCircle, AlertCircle } from 'lucide-react';
import { List, ListInput, BlockTitle } from 'konsta/react';
import { useTanks } from '@/hooks/useTanks';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';

interface FormErrors {
  sourceTank?: string;
  destinationTank?: string;
  quantity?: string;
  general?: string;
}

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

  useEffect(() => {
    if (tankId) setSourceTankId(tankId);
  }, [tankId]);

  const sourceTank = tanks?.find((t) => t.id === sourceTankId);
  const sourceMetrics = sourceTank?.batchMetrics;

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};
    if (!sourceTankId) newErrors.sourceTank = 'Kaynak tank seciniz';
    if (!sourceMetrics) newErrors.sourceTank = 'Secili tankta aktif batch yok';
    if (!destinationTankId) newErrors.destinationTank = 'Hedef tank seciniz';
    if (sourceTankId === destinationTankId) newErrors.destinationTank = 'Kaynak ve hedef tank ayni olamaz';
    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) newErrors.quantity = 'Miktar en az 1 olmalidir';
    if (sourceMetrics && qty > (sourceMetrics.pieces ?? 0)) {
      newErrors.quantity = `Miktar ${sourceMetrics.pieces} adetten fazla olamaz`;
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
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
      const message = error instanceof Error ? error.message : 'Transfer kaydedilemedi';
      setErrors({ general: message });
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
        <h2 className="text-xl font-bold text-sea-700 dark:text-sea-300">Kaydedildi!</h2>
        <p className="text-sea-600 dark:text-sea-400 text-sm mt-1">
          Senkronizasyon icin kuyruga alindi
        </p>
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
            <h1 className="text-lg font-bold">Transfer Kaydi</h1>
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
                {sourceMetrics.batchNumber ?? '--'} &middot; {(sourceMetrics.pieces ?? 0).toLocaleString()} adet
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
      {!tankId && (
        <>
          <BlockTitle>Kaynak Tank</BlockTitle>
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
              <option value="">-- Tank Seciniz --</option>
              {tanks?.filter((t) => t.batchMetrics).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} - {t.batchMetrics?.batchNumber ?? '--'}
                </option>
              ))}
            </ListInput>
          </List>
          {errors.sourceTank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.sourceTank}</p>}
        </>
      )}

      {/* Destination tank selector */}
      <BlockTitle>Hedef Tank</BlockTitle>
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
          <option value="">-- Tank Seciniz --</option>
          {tanks?.filter((t) => t.id !== sourceTankId).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.batchMetrics ? `- ${t.batchMetrics.batchNumber}` : '(Bos)'}
            </option>
          ))}
        </ListInput>
      </List>
      {errors.destinationTank && <p className="text-red-500 text-sm px-4 -mt-2">{errors.destinationTank}</p>}

      {/* Quantity */}
      <BlockTitle>Adet</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="number"
          placeholder="Transfer edilecek adet"
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
      <BlockTitle>Biyokütle (kg) - Opsiyonel</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="number"
          placeholder="Toplam biyokütle kg"
          value={biomassKg}
          onInput={(e: ChangeEvent<HTMLInputElement>) => setBiomassKg(e.target.value)}
        />
      </List>

      {/* Transfer reason */}
      <BlockTitle>Transfer Nedeni (Opsiyonel)</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          type="textarea"
          placeholder="Transfer nedeni..."
          value={transferReason}
          onInput={(e: ChangeEvent<HTMLTextAreaElement>) => setTransferReason(e.target.value)}
          inputClassName="!h-20"
        />
      </List>

      {/* Submit button */}
      <div className="px-4 pb-28">
        <button
          onClick={handleSubmit}
          disabled={!sourceTankId || !destinationTankId || !quantity || isSubmitting}
          className="w-full py-4 bg-gradient-to-r from-blue-600 to-blue-500 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/25 disabled:opacity-50 disabled:cursor-not-allowed touch-feedback transition-all flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent" />
              Kaydediliyor...
            </>
          ) : (
            <>
              <ArrowLeftRight size={20} />
              Transfer Kaydet
            </>
          )}
        </button>
        {!isOnline && (
          <p className="text-center text-amber-500 text-sm mt-3 font-medium">
            Cevrimdisi - baglaninca senkronize edilecek
          </p>
        )}
      </div>
    </div>
  );
}
