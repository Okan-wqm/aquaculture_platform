/**
 * RecordFeedingPage — öğün-merkezli mobil yemleme kaydı (Faz 6 cutover, P-26).
 *
 * Kaynak: `feedingDayPlans` TİPLİ sorgusu (P-25 — `snapshot` jsonb tele
 * çıkmaz; eski motorun opak `calculations` blob'u öldü). Kayıt:
 * `recordMealFeeding` offline kuyruğu üzerinden (zarf enqueue'da damgalanır —
 * C-17; kısmi döküm D-8: `finalize` operatörün "öğün bitti" onayıdır).
 *
 * FE-MEDIUM-054 davranışı korunur: son eşitlenen plan şifreli tenant-scoped
 * cache'e yazılır ve çevrimdışı açılışta dürüst bir bantla gösterilir.
 * Enum alanları tel üzerinde AD taşır ('SCHEDULED', 'FED', ...).
 *
 * v4 dönüşümü: Konsta (List/ListInput/BlockTitle) kaldırıldı VE renkler
 * semantik token'lara taşındı (src/styles/tokens.css). İkisi tek geçiştir:
 * Konsta kendi `ios-`/`md-` renk sınıflarını ve kendi karanlık-tema
 * varyantlarını enjekte ettiği için, bileşenler yerli <select>/<textarea>'ya
 * inmeden sayfa tema doğruluğunu kazanamıyordu. Öğün durum renkleri SÜS DEĞİL ANLAMDIR —
 * eşleme MEAL_BADGE üzerinde belgelidir. Alan mantığı (sorgu, kuyruk,
 * doğrulama, adım akışı, gezinme hedefleri) bilerek DOKUNULMADI.
 */
import { useI18n } from '@aquaculture/shared-ui/i18n';
import { clsx } from 'clsx';
import {
  AlertCircle,
  Check,
  Hand,
  Package,
  Radio,
  Settings,
  Thermometer,
  WifiOff,
} from 'lucide-react';
import { useState, useEffect, ChangeEvent, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AlreadyRecordedNotice } from '@/components/AlreadyRecordedNotice';
import { AppHeader } from '@/components/AppHeader';
import { QueuedStatusBadge } from '@/components/QueuedStatusBadge';
import { Button, Card, EmptyState, Select, Spinner, Textarea } from '@/components/ui';
import type { FeedingMethod } from '@/generated/graphql';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTodaysDayPlans, type DayPlanMeal, type MealStatus } from '@/hooks/useTodaysDayPlans';

// MOB-HIGH-022: the method vocabulary is the generated FeedingMethod enum the
// server coerces on the wire — the old lowercase mirror ('manual') was rejected
// by the enum input the moment the server typed the field.
type FeedingMethodOption = Extract<FeedingMethod, 'MANUAL' | 'AUTOMATIC' | 'DEMAND'>;

const FEEDING_METHODS: {
  value: FeedingMethodOption;
  labelKey: 'm.feeding.method.manual' | 'm.feeding.method.automatic' | 'm.feeding.method.demand';
  Icon: typeof Hand;
}[] = [
  { value: 'MANUAL', labelKey: 'm.feeding.method.manual', Icon: Hand },
  { value: 'AUTOMATIC', labelKey: 'm.feeding.method.automatic', Icon: Settings },
  { value: 'DEMAND', labelKey: 'm.feeding.method.demand', Icon: Radio },
];

/**
 * Öğün durumunun rengi ANLAMDIR — bir işçi rozetin tonundan öğünün akıbetini
 * okur, metni okumadan önce. v4 token eşlemesi ve GEREKÇESİ:
 *
 *   FED           → ok    yemleme tamamlandı, teyit rengi.
 *   MISSED        → crit  ALARM: öğün geçti ve balık yemlenmedi; müdahale ister.
 *   SKIPPED       → warn  operatörün BİLEREK verdiği karar (hava, sağlık, hasat
 *                         öncesi perhiz). Kasıtlı bir seçim alarm değildir —
 *                         crit yapmak MISSED ile aynı aciliyeti iddia ederdi.
 *   PARTIALLY_FED → acc   arada: ne bitti ne kaçtı. Teal bu ekranda "sürüyor /
 *                         aktif" halidir ve WARN'a bitişik durmadığı için
 *                         SKIPPED ile karışmaz.
 *   SCHEDULED     → nötr  henüz bir olay yok; renk iddia etmez.
 *   CANCELLED     → sessiz nötr; plandan düşmüştür, dikkat çekmemelidir.
 */
const MEAL_BADGE: Record<MealStatus, string> = {
  SCHEDULED: 'bg-surface-2 text-ink-2',
  FED: 'bg-surface-2 text-ok',
  PARTIALLY_FED: 'bg-acc-dim text-acc',
  SKIPPED: 'bg-warn-dim text-warn',
  MISSED: 'bg-crit-dim text-crit',
  CANCELLED: 'bg-surface-2 text-ink-3',
};

/** Bölüm başlığı — v4'te BlockTitle'ın yerini alan tek tipografi. */
const SECTION_HEADING = 'text-body font-semibold text-ink-3 px-1';

/** Döküm alınabilen öğünler (D-8): planlı veya yarım kalmış. */
function isMealOpen(meal: DayPlanMeal): boolean {
  return meal.status === 'SCHEDULED' || meal.status === 'PARTIALLY_FED';
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// ============================================================================

// COMPONENT
// ============================================================================

interface FormErrors {
  amount?: string;
  general?: string;
}

export function RecordFeedingPage(): JSX.Element {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { tankId } = useParams<{ tankId?: string }>();
  const { addToQueue, isOnline } = useOfflineQueue();
  const {
    plans,
    isLoading: plansLoading,
    isError: plansFailed,
    isOfflineCached,
    retry: retryPlans,
  } = useTodaysDayPlans();

  const [selectedUnitId, setSelectedUnitId] = useState(tankId || '');
  const [selectedMealId, setSelectedMealId] = useState<string>('');
  const [pourKg, setPourKg] = useState<string>('');
  const [finalize, setFinalize] = useState(true);
  const [feedingMethod, setFeedingMethod] = useState<FeedingMethodOption>('MANUAL');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Two-phase success UX (C7): the badge tracks the queued op's real sync
  // status; a deduped double-tap renders "Already recorded" (FE-HIGH-050).
  const [queuedOperationId, setQueuedOperationId] = useState('');
  const [wasDuplicate, setWasDuplicate] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});

  useEffect(() => {
    if (tankId) setSelectedUnitId(tankId);
  }, [tankId]);

  const selectedPlan = plans.find((plan) => plan.unitId === selectedUnitId);
  const meals = [...(selectedPlan?.meals ?? [])].sort((a, b) => a.mealIndex - b.mealIndex);
  const selectedMeal = meals.find((meal) => meal.id === selectedMealId);

  /**
   * Sorgu düştü VE elde önbellek yok: ekranın söyleyebileceği tek dürüst şey
   * "planlar bilinmiyor"dur, "plan yok" DEĞİL. Bu iki cümle aynı görünürse
   * işçi, planı olan bir üniteyi plansız sanıp yemlemeden geçer.
   *
   * WHY toLoadable/<DataState> değil: loadable.ts hata kolunu bayat veriden
   * ÖNCE değerlendirir ("callers that genuinely want stale-while-error should
   * read the query directly and say so at the callsite") — bu ekran tam olarak
   * o çağrandır; FE-MEDIUM-054 çevrimdışı planı, sorgu düşmüşken bilerek
   * gösterir. Bu yüzden hata kolu burada elle ayrılır ve <DataState>'in hata
   * kolunun render ettiği bileşenin AYNISI (EmptyState tone="error") kullanılır.
   */
  const plansUnavailable = plansFailed && !isOfflineCached && plans.length === 0;

  // Öğün seçimi olay-güdümlü: seçim anında kalan plan miktarı ön-dolur
  // (kısmi dökümde kalan kadar) — effect + bağımlılık istisnası gerekmez.
  const handleMealSelect = (meal: DayPlanMeal): void => {
    const nextId = meal.id === selectedMealId ? '' : meal.id;
    setSelectedMealId(nextId);
    if (nextId) {
      const remaining = Math.max(0, meal.plannedKg - meal.actualKg);
      setPourKg(remaining > 0 ? remaining.toFixed(2) : '');
      setFinalize(true);
    } else {
      setPourKg('');
    }
    setErrors({});
  };

  const parsedPour = parseFloat(pourKg) || 0;
  const mealsDone = meals.filter((m) => m.status === 'FED' || m.status === 'SKIPPED').length;
  const mealsTotal = meals.filter((m) => m.status !== 'CANCELLED').length;

  const validate = (): boolean => {
    const next: FormErrors = {};
    if (!pourKg || parsedPour <= 0) next.amount = t('m.feeding.errors.amountRequired');
    if (parsedPour > 10000) next.amount = t('m.feeding.errors.amountMax');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!selectedMeal || !validate()) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      const result = await addToQueue('recordMealFeeding', {
        mealId: selectedMeal.id,
        pourKg: parsedPour,
        finalize,
        feedingMethod,
        notes: notes.trim() || undefined,
      });
      setQueuedOperationId(result.id);
      setWasDuplicate(result.status === 'duplicate');
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('m.feeding.errors.generic');
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  /**
   * Öğünü DÖKÜM EKLEMEDEN kapat (W8 — FARM-MEDIUM-269).
   *
   * Balık doyduğunda operatörün yapması gereken "öğün bitti" demektir, kg
   * eklemek değil. Bu yol açılana kadar tek çıkış uydurma bir 0.001 kg
   * dökümdü: sahte bir yem kaydı, sahte bir stok düşümü ve batch'in toplam
   * tüketimine giren sahte bir gram.
   */
  const handleFinalizeOnly = async (): Promise<void> => {
    if (!selectedMeal) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      // Same two-phase UX as the pour path: the badge reports the op's real
      // sync status instead of an unconditional green.
      const result = await addToQueue('finalizeMeal', { mealId: selectedMeal.id });
      setQueuedOperationId(result.id);
      setWasDuplicate(result.status === 'duplicate');
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('m.feeding.errors.generic');
      setErrors({ general: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnitChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    setSelectedUnitId(e.target.value);
    setSelectedMealId('');
    setPourKg('');
    setErrors({});
  };

  // Kayıt her zaman önce kuyruğa gider; ekran gerçek eşitleme durumunu gösterir
  // (Queued → Syncing → Confirmed / Sync Failed), yeşil "kaydedildi" değil.
  // Dedupe edilen çift dokunuş "Already recorded" ile ayrışır (FE-HIGH-050).
  if (queuedOperationId !== '') {
    return (
      // The page tint is gone — the ground belongs to <body>. The receipt is
      // honest about the queue: saved to the device is not yet recorded.
      <div className="flex flex-col items-center justify-center min-h-screen px-6">
        {wasDuplicate ? (
          <AlreadyRecordedNotice />
        ) : (
          <>
            <div className="w-20 h-20 bg-warn-dim rounded-full flex items-center justify-center mb-4">
              <Package size={48} className="text-warn" />
            </div>
            <h2 className="text-head font-bold text-warn">{t('m.feeding.savedToDevice')}</h2>
            <p className="text-ink-2 text-body mt-1 text-center">{t('m.feeding.queuedForSync')}</p>
            <div className="mt-4">
              <QueuedStatusBadge operationId={queuedOperationId} />
            </div>
          </>
        )}
        <Button variant="primary" onClick={() => navigate('/')} className="mt-6">
          {t('m.common.backToHome')}
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* v4: yeşil gradyan bant yerine uygulamanın tek başlığı. Geri hedefi
          değişmedi (navigate(-1)); etiketsiz ArrowLeft düğmesinin yerini
          AppHeader'ın adlandırılmış, 44px tabanlı IconButton'ı aldı. Paket
          simgesi kayıt türünün kendi rengini (type-feeding) taşır. */}
      <AppHeader
        title={t('m.feeding.title')}
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={<Package size={20} className="text-type-feeding" aria-hidden />}
      />

      {/* FE-MEDIUM-054: dürüst kaynak bandı — plan şifreli offline cache'ten
          geliyorsa işçiye söyle. */}
      {isOfflineCached && (
        <Card className="mx-4 mt-3 p-3 flex items-center gap-2 border-warn">
          <AlertCircle size={18} className="text-warn flex-shrink-0" />
          <span className="text-warn text-body">{t('m.feeding.offlineCachedBanner')}</span>
        </Card>
      )}

      {errors.general && (
        <Card role="alert" className="mx-4 mt-3 p-3 flex items-center gap-2 border-crit">
          <AlertCircle size={18} className="text-crit flex-shrink-0" />
          <span className="text-crit text-body">{errors.general}</span>
        </Card>
      )}

      {/* "Okuyamadım" ile "yok" ayrı iddialardır; ayrı görünürler. */}
      {plansUnavailable && (
        <EmptyState
          tone="error"
          icon={<WifiOff size={22} />}
          title={t('m.feeding.plansError')}
          description={t('m.feeding.plansErrorHint')}
          action={
            <Button variant="primary" onClick={retryPlans}>
              {t('m.common.retry')}
            </Button>
          }
        />
      )}

      {/* Ünite seçimi — bugünün gün planları (protokol atanmış üniteler) */}
      {!tankId && !plansUnavailable && (
        <div className="px-4 mt-4">
          <Select
            label={t('m.feeding.selectUnit')}
            value={selectedUnitId}
            onChange={handleUnitChange}
          >
            <option value="">{t('m.feeding.selectUnitPlaceholder')}</option>
            {plans.map((plan) => (
              <option key={plan.unitId} value={plan.unitId}>
                {plan.unitName} ({plan.unitCode})
              </option>
            ))}
          </Select>
          {!plansLoading && plans.length === 0 && (
            <Card className="mt-2 p-3 border-warn">
              <p className="text-warn text-body font-medium">{t('m.feeding.noPlansToday')}</p>
              <p className="text-ink-2 text-meta mt-1">{t('m.feeding.noPlansTodayHint')}</p>
            </Card>
          )}
        </div>
      )}

      {/* Ünitesi param'dan gelip planı olmayan durum */}
      {selectedUnitId && !plansLoading && !plansUnavailable && !selectedPlan && (
        <Card className="mx-4 mt-4 p-4 border-warn">
          <p className="text-warn text-body font-medium">{t('m.feeding.noPlanForUnit')}</p>
          <p className="text-ink-2 text-meta mt-1">{t('m.feeding.noPlanForUnitHint')}</p>
        </Card>
      )}

      {/* Plan kartı — tipli alanlar (P-25) */}
      {selectedPlan && (
        <Card className="mx-4 mt-4 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-type-feeding-dim rounded-xl flex items-center justify-center">
                <Package className="text-type-feeding" size={22} />
              </div>
              <div>
                <h2 className="text-title font-semibold text-ink-1">{selectedPlan.unitName}</h2>
                <p className="text-meta text-ink-3 font-mono">{selectedPlan.unitCode}</p>
              </div>
            </div>
            <span className="text-body font-semibold text-ink-2">
              {t('m.feeding.progress', { done: mealsDone, total: mealsTotal })}
            </span>
          </div>
          {/* İki kuyu da nötr yüzey: buradaki mavi/gri ayrımı ANLAM taşımıyordu,
              süstü. Teal yalnız eylem ve aktif hâl rengidir, duran bir sayıya
              takılmaz. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-2 rounded-xl p-3">
              <p className="text-meta text-ink-3 font-medium">{t('m.feeding.plannedTotal')}</p>
              <p className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {Number(selectedPlan.plannedTotalKg).toFixed(2)} kg
              </p>
              <p className="text-meta text-ink-3">
                {t('m.feeding.rate')} {Number(selectedPlan.effectiveRatePercent).toFixed(2)}% ·{' '}
                {t('m.feeding.expectedFcr')} {Number(selectedPlan.expectedFcr).toFixed(2)}
              </p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3">
              <p className="text-meta text-ink-3 font-medium">{t('m.feeding.feed')}</p>
              <p className="text-head font-mono font-bold text-ink-1">{selectedPlan.feedCode}</p>
              <p className="text-meta text-ink-3">
                {t('m.feeding.biomass')} {Number(selectedPlan.biomassKg).toFixed(1)} kg
              </p>
            </div>
          </div>
          {/* Sıcaklık provenansı — P-20: sessiz varsayılan yok */}
          <div className="mt-3 flex items-center gap-2 text-meta">
            <Thermometer size={14} className="text-ink-3" />
            {selectedPlan.usingDefaultTemperature ? (
              <span className="text-warn font-medium">{t('m.feeding.defaultTempWarning')}</span>
            ) : (
              <span className="text-ink-2">
                {t('m.feeding.waterTemp')}: {Number(selectedPlan.waterTempC ?? 0).toFixed(1)}°C (
                {selectedPlan.temperatureSource})
              </span>
            )}
          </div>
        </Card>
      )}

      {/* Öğün listesi */}
      {selectedPlan && (
        <div className="px-4 mt-5">
          <h2 id="feeding-meals-heading" className={clsx(SECTION_HEADING, 'mb-3')}>
            {t('m.feeding.meals')}
          </h2>
          <div role="group" aria-labelledby="feeding-meals-heading" className="space-y-2">
            {meals.map((meal) => {
              const open = isMealOpen(meal);
              const selected = meal.id === selectedMealId;
              return (
                <button
                  key={meal.id}
                  type="button"
                  disabled={!open}
                  aria-pressed={selected}
                  onClick={() => handleMealSelect(meal)}
                  className={clsx(
                    'w-full text-left min-h-touch bg-surface-1 rounded-2xl p-3 border-2 transition-all touch-feedback',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                    selected ? 'border-acc shadow-acc' : 'border-line',
                    !open && 'opacity-60',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-title font-mono font-bold text-ink-1 tabular-nums">
                        {timeOf(meal.scheduledAt)}
                      </span>
                      <span className="text-body text-ink-3">
                        {t('m.feeding.meal', { index: meal.mealIndex + 1 })}
                      </span>
                    </div>
                    <span
                      className={clsx(
                        'text-meta font-semibold px-2 py-1 rounded-lg',
                        MEAL_BADGE[meal.status],
                      )}
                    >
                      {t(`m.feeding.mealStatus.${meal.status}`)}
                    </span>
                  </div>
                  <div className="mt-1 text-body text-ink-2">
                    {Number(meal.plannedKg).toFixed(2)} kg
                    {meal.actualKg > 0 && (
                      // Dökülen miktar "sürüyor" halidir — rozetteki
                      // PARTIALLY_FED ile aynı tonda okunur.
                      <span className="ml-2 text-acc font-mono tabular-nums">
                        → {Number(meal.actualKg).toFixed(2)} kg
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Döküm formu */}
      {selectedMeal && (
        <>
          <div className="px-4 mt-5">
            {/* Bölüm başlığı DEĞİL, gerçek bir <label>: kahraman rakam alanının
                erişilebilir adı yoktu — ekran okuyucu "sayı girin" diyordu. */}
            <label htmlFor="feeding-pour-kg" className={clsx(SECTION_HEADING, 'block mb-3')}>
              {t('m.feeding.pour.amountTitle')}
            </label>
            <Card className="p-5">
              <input
                id="feeding-pour-kg"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                max="10000"
                value={pourKg}
                aria-invalid={errors.amount !== undefined}
                aria-describedby={clsx(
                  'feeding-pour-remaining',
                  errors.amount !== undefined && 'feeding-pour-error',
                )}
                onChange={(e) => {
                  setPourKg(e.target.value);
                  setErrors((prev) => ({ ...prev, amount: undefined }));
                }}
                className="w-full text-center text-hero font-mono font-bold tabular-nums text-ink-1 bg-transparent border-none rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-acc"
              />
              <p className="text-center text-meta text-ink-3 mt-1 font-medium">kg</p>
              <p id="feeding-pour-remaining" className="text-center text-meta text-ink-3 mt-1">
                {t('m.feeding.pour.remaining', {
                  kg: Math.max(0, selectedMeal.plannedKg - selectedMeal.actualKg).toFixed(2),
                })}
              </p>
              {errors.amount && (
                <p
                  id="feeding-pour-error"
                  role="alert"
                  className="text-crit text-body text-center mt-2"
                >
                  {errors.amount}
                </p>
              )}
            </Card>

            {/* Finalize — D-8 kısmi öğün: kapatmadan döküm eklenebilir.
                Etiket kutuyu SARAR: 20px'lik onay kutusu tek başına 44px
                tabanının altındaydı; şimdi kartın tüm satırı dokunma hedefi. */}
            <Card className="mt-3">
              <label
                htmlFor="finalize-meal"
                className="flex items-start gap-3 px-4 pt-4 min-h-touch cursor-pointer"
              >
                <input
                  id="finalize-meal"
                  type="checkbox"
                  checked={finalize}
                  onChange={(e) => setFinalize(e.target.checked)}
                  aria-describedby="finalize-meal-hint"
                  className="mt-0.5 h-5 w-5 shrink-0 rounded accent-acc"
                />
                <span className="text-body font-semibold text-ink-1">
                  {t('m.feeding.pour.finalize')}
                </span>
              </label>
              <p id="finalize-meal-hint" className="text-meta text-ink-3 pl-12 pr-4 pb-4">
                {t('m.feeding.pour.finalizeHint')}
              </p>
            </Card>
          </div>

          {/* Yöntem */}
          <div className="px-4 mt-5">
            <h2 id="feeding-method-heading" className={clsx(SECTION_HEADING, 'mb-3')}>
              {t('m.feeding.method.title')}
            </h2>
            <div
              role="group"
              aria-labelledby="feeding-method-heading"
              className="grid grid-cols-3 gap-2"
            >
              {FEEDING_METHODS.map((m) => {
                const Icon = m.Icon;
                const active = feedingMethod === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFeedingMethod(m.value)}
                    className={clsx(
                      'flex flex-col items-center p-4 min-h-touch rounded-2xl border-2 transition-all touch-feedback',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-acc',
                      active ? 'border-acc bg-acc-dim shadow-acc' : 'border-line bg-surface-1',
                    )}
                  >
                    <Icon size={24} className={active ? 'text-acc' : 'text-ink-3'} />
                    <span
                      className={clsx(
                        'text-meta font-semibold mt-1.5',
                        active ? 'text-acc' : 'text-ink-2',
                      )}
                    >
                      {t(m.labelKey)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notlar */}
          <div className="px-4 mt-5">
            <Textarea
              label={t('m.feeding.notes.title')}
              rows={4}
              placeholder={t('m.feeding.notes.placeholder')}
              value={notes}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              textareaClassName="resize-none"
            />
          </div>

          {/* Kaydet */}
          <div className="px-4 mt-5">
            <Button
              variant="primary"
              size="save"
              block
              onClick={() => {
                void handleSubmit();
              }}
              disabled={parsedPour <= 0 || isSubmitting}
              className="font-bold"
            >
              {isSubmitting ? (
                <>
                  <Spinner size="md" color="inherit" />
                  {t('m.feeding.recording')}
                </>
              ) : (
                <>
                  <Package size={20} />
                  {parsedPour > 0
                    ? t('m.feeding.recordKg', { kg: parsedPour.toFixed(2) })
                    : t('m.feeding.record')}
                </>
              )}
            </Button>
            {/*
              W8/FARM-MEDIUM-269 — sadece PARTIALLY_FED öğün döküm eklemeden
              kapatılabilir. Hiç dökümü olmayan öğünün doğru fiili "atla"dır;
              0 kg'la "beslendi" demek kaydı yalanlar, o yüzden buton yalnız
              kısmi beslenmiş öğünde çıkar (backend de aynı kısıtı uygular).
            */}
            {selectedMeal.status === 'PARTIALLY_FED' && (
              <Button
                variant="secondary"
                size="save"
                block
                onClick={() => {
                  void handleFinalizeOnly();
                }}
                disabled={isSubmitting}
                className="mt-3 border-2 border-ok text-ok"
              >
                <Check size={20} />
                {t('m.feeding.finalizeOnly')}
              </Button>
            )}
            {!isOnline && (
              <p className="text-center text-warn text-body mt-3 font-medium">
                {t('m.feeding.offlineWillSync')}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
