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
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Package,
  CheckCircle,
  AlertCircle,
  Hand,
  Settings,
  Radio,
  Thermometer,
  WifiOff,
} from 'lucide-react';
import { useState, useEffect, ChangeEvent, type JSX } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState } from '@/components/ui';
import { GET_FEEDING_DAY_PLANS } from '@/graphql/operations';
import { useAuth } from '@/hooks/useAuth';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useI18n } from '@/i18n';
import { cacheData, getCachedData } from '@/pwa/offline-queue';
import { graphqlRequest } from '@/services/authenticated-fetch';
import { logger } from '@/utils/logger';
import { createTenantQueryKey } from '@/utils/tenant-query-keys';

// ============================================================================
// TYPES — feedingDayPlans tipli sorgusunun aynası (P-25)
// ============================================================================

type MealStatus = 'SCHEDULED' | 'FED' | 'PARTIALLY_FED' | 'SKIPPED' | 'MISSED' | 'CANCELLED';

interface DayPlanMeal {
  id: string;
  mealIndex: number;
  scheduledAt: string;
  percentOfDaily: number;
  plannedKg: number;
  status: MealStatus;
  actualKg: number;
  varianceKg: number | null;
  variancePercent: number | null;
  feedId: string;
  fedAt?: string | null;
  feedingMethod?: string | null;
  notes?: string | null;
}

interface FeedingDayPlanSlice {
  id: string;
  unitId: string;
  unitName: string;
  unitCode: string;
  planDate: string;
  status: string;
  plannedTotalKg: number;
  unplannedActualKg: number;
  mealsPlanned: number;
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  waterTempC: number | null;
  temperatureSource: string;
  usingDefaultTemperature: boolean;
  feedId: string;
  feedCode: string;
  feedName: string;
  effectiveRatePercent: number;
  expectedFcr: number;
  meals: DayPlanMeal[];
}

type FeedingMethodOption = 'manual' | 'automatic' | 'demand';

const FEEDING_METHODS: {
  value: FeedingMethodOption;
  labelKey: 'feeding.method.manual' | 'feeding.method.automatic' | 'feeding.method.demand';
  Icon: typeof Hand;
}[] = [
  { value: 'manual', labelKey: 'feeding.method.manual', Icon: Hand },
  { value: 'automatic', labelKey: 'feeding.method.automatic', Icon: Settings },
  { value: 'demand', labelKey: 'feeding.method.demand', Icon: Radio },
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
// HOOK: useTodaysDayPlans — FE-MEDIUM-054 offline-cache davranışı korunur
// ============================================================================

const DAY_PLANS_CACHE_PREFIX = 'feedingDayPlans_';
// Kısa TTL: bariz bayat bir plan işçiyi yanıltmaktansa süresi dolsun (cache
// kolaylıktır, otorite değildir — recordMealFeeding sunucuda doğrulanır).
const DAY_PLANS_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12h

function useTodaysDayPlans(): {
  plans: FeedingDayPlanSlice[];
  isLoading: boolean;
  /**
   * Sorgu düştü mü. Hata kolu DIŞARI VERİLİR: yutulursa ekran "bugün plan yok"
   * ile "planı okuyamadım"ı ayırt edemez ve outage otoriter bir iddiaya
   * dönüşür — bu uygulamada altı kez bulunmuş kusurun ta kendisi
   * (src/utils/loadable.ts).
   */
  isError: boolean;
  isOfflineCached: boolean;
  retry: () => void;
} {
  const { accessToken, tenantId, isAuthenticated } = useAuth();

  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const cacheKey = `${DAY_PLANS_CACHE_PREFIX}${dateStr}`;

  const [cachedSeed, setCachedSeed] = useState<FeedingDayPlanSlice[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    if (!tenantId) return;
    getCachedData<FeedingDayPlanSlice[]>(tenantId, cacheKey)
      .then((cached) => {
        if (!cancelled && cached) {
          setCachedSeed(cached);
        }
      })
      .catch((error: unknown) => {
        logger.error('[RecordFeedingPage] failed to load cached day-plan seed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, cacheKey]);

  const { data, isLoading, isSuccess, isError, refetch } = useQuery<FeedingDayPlanSlice[]>({
    queryKey: createTenantQueryKey(tenantId, 'feedingDayPlans', tenantId, dateStr),
    queryFn: async () => {
      if (!accessToken || !tenantId) {
        throw new Error('Not authenticated');
      }
      const result = await graphqlRequest<{ feedingDayPlans: FeedingDayPlanSlice[] }>(
        GET_FEEDING_DAY_PLANS,
        { planDate: dateStr },
      );
      const plans = result.feedingDayPlans ?? [];
      await cacheData(tenantId, cacheKey, plans, DAY_PLANS_CACHE_TTL_MS);
      return plans;
    },
    enabled: isAuthenticated && !!accessToken && !!tenantId,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 60,
    refetchOnWindowFocus: true,
  });

  const plans = isSuccess ? (data ?? []) : (cachedSeed ?? []);
  const isOfflineCached = !isSuccess && (cachedSeed?.length ?? 0) > 0;

  return {
    plans,
    isLoading,
    isError,
    isOfflineCached,
    retry: () => {
      void refetch();
    },
  };
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
  const [feedingMethod, setFeedingMethod] = useState<FeedingMethodOption>('manual');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
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
    if (!pourKg || parsedPour <= 0) next.amount = t('feeding.errors.amountRequired');
    if (parsedPour > 10000) next.amount = t('feeding.errors.amountMax');
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = async (): Promise<void> => {
    if (!selectedMeal || !validate()) return;

    setIsSubmitting(true);
    setErrors({});
    try {
      await addToQueue('recordMealFeeding', {
        mealId: selectedMeal.id,
        pourKg: parsedPour,
        finalize,
        feedingMethod,
        notes: notes.trim() || undefined,
      });
      setShowSuccess(true);
      setTimeout(() => navigate('/'), 1500);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('feeding.errors.generic');
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

  if (showSuccess) {
    return (
      // Sayfa tonu kaldırıldı — zemin <body>'nin. Yeşil yalnız anlam taşıdığı
      // yerde kaldı: onay işareti ve başlığı. role=status, ekran okuyucunun
      // kaydın alındığını duyurmasını sağlar (eskiden sessiz bir ekrandı).
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center justify-center min-h-screen"
      >
        <div className="w-20 h-20 bg-surface-2 rounded-full flex items-center justify-center mb-4">
          <CheckCircle size={48} className="text-ok" />
        </div>
        <h2 className="text-head font-bold text-ok">{t('feeding.recorded')}</h2>
        {/* Kayıt her zaman önce kuyruğa gider ve arka planda eşitlenir. */}
        <p className="text-ink-2 text-body mt-1">{t('feeding.queuedForSync')}</p>
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
        title={t('feeding.title')}
        onBack={() => navigate(-1)}
        showAvatar={false}
        actions={<Package size={20} className="text-type-feeding" aria-hidden />}
      />

      {/* FE-MEDIUM-054: dürüst kaynak bandı — plan şifreli offline cache'ten
          geliyorsa işçiye söyle. */}
      {isOfflineCached && (
        <Card className="mx-4 mt-3 p-3 flex items-center gap-2 border-warn">
          <AlertCircle size={18} className="text-warn flex-shrink-0" />
          <span className="text-warn text-body">{t('feeding.offlineCachedBanner')}</span>
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
          title={t('feeding.plansError')}
          description={t('feeding.plansErrorHint')}
          action={
            <Button variant="primary" onClick={retryPlans}>
              {t('common.retry')}
            </Button>
          }
        />
      )}

      {/* Ünite seçimi — bugünün gün planları (protokol atanmış üniteler) */}
      {!tankId && !plansUnavailable && (
        <div className="px-4 mt-4">
          {/* Konsta BlockTitle + ListInput yerine gerçek bir <label> + yerli
              <select>: başlık artık kontrolün erişilebilir ADI (Konsta'nın
              ListInput'u bunu kendi içinde taşıyordu, bölüm başlığı taşımaz). */}
          <label htmlFor="feeding-unit-select" className={clsx(SECTION_HEADING, 'block mb-2')}>
            {t('feeding.selectUnit')}
          </label>
          <select
            id="feeding-unit-select"
            value={selectedUnitId}
            onChange={handleUnitChange}
            className="w-full min-h-touch px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body focus:outline-none focus:ring-2 focus:ring-acc"
          >
            <option value="">{t('feeding.selectUnitPlaceholder')}</option>
            {plans.map((plan) => (
              <option key={plan.unitId} value={plan.unitId}>
                {plan.unitName} ({plan.unitCode})
              </option>
            ))}
          </select>
          {!plansLoading && plans.length === 0 && (
            <Card className="mt-2 p-3 border-warn">
              <p className="text-warn text-body font-medium">{t('feeding.noPlansToday')}</p>
              <p className="text-ink-2 text-meta mt-1">{t('feeding.noPlansTodayHint')}</p>
            </Card>
          )}
        </div>
      )}

      {/* Ünitesi param'dan gelip planı olmayan durum */}
      {selectedUnitId && !plansLoading && !plansUnavailable && !selectedPlan && (
        <Card className="mx-4 mt-4 p-4 border-warn">
          <p className="text-warn text-body font-medium">{t('feeding.noPlanForUnit')}</p>
          <p className="text-ink-2 text-meta mt-1">{t('feeding.noPlanForUnitHint')}</p>
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
              {t('feeding.progress', { done: mealsDone, total: mealsTotal })}
            </span>
          </div>
          {/* İki kuyu da nötr yüzey: buradaki mavi/gri ayrımı ANLAM taşımıyordu,
              süstü. Teal yalnız eylem ve aktif hâl rengidir, duran bir sayıya
              takılmaz. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-2 rounded-xl p-3">
              <p className="text-meta text-ink-3 font-medium">{t('feeding.plannedTotal')}</p>
              <p className="text-head font-mono font-bold text-ink-1 tabular-nums">
                {Number(selectedPlan.plannedTotalKg).toFixed(2)} kg
              </p>
              <p className="text-meta text-ink-3">
                {t('feeding.rate')} {Number(selectedPlan.effectiveRatePercent).toFixed(2)}% ·{' '}
                {t('feeding.expectedFcr')} {Number(selectedPlan.expectedFcr).toFixed(2)}
              </p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3">
              <p className="text-meta text-ink-3 font-medium">{t('feeding.feed')}</p>
              <p className="text-head font-mono font-bold text-ink-1">{selectedPlan.feedCode}</p>
              <p className="text-meta text-ink-3">
                {t('feeding.biomass')} {Number(selectedPlan.biomassKg).toFixed(1)} kg
              </p>
            </div>
          </div>
          {/* Sıcaklık provenansı — P-20: sessiz varsayılan yok */}
          <div className="mt-3 flex items-center gap-2 text-meta">
            <Thermometer size={14} className="text-ink-3" />
            {selectedPlan.usingDefaultTemperature ? (
              <span className="text-warn font-medium">{t('feeding.defaultTempWarning')}</span>
            ) : (
              <span className="text-ink-2">
                {t('feeding.waterTemp')}: {Number(selectedPlan.waterTempC ?? 0).toFixed(1)}°C (
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
            {t('feeding.meals')}
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
                        {t('feeding.meal', { index: meal.mealIndex + 1 })}
                      </span>
                    </div>
                    <span
                      className={clsx(
                        'text-meta font-semibold px-2 py-1 rounded-lg',
                        MEAL_BADGE[meal.status],
                      )}
                    >
                      {t(`feeding.mealStatus.${meal.status}`)}
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
              {t('feeding.pour.amountTitle')}
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
                {t('feeding.pour.remaining', {
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
                  {t('feeding.pour.finalize')}
                </span>
              </label>
              <p id="finalize-meal-hint" className="text-meta text-ink-3 pl-12 pr-4 pb-4">
                {t('feeding.pour.finalizeHint')}
              </p>
            </Card>
          </div>

          {/* Yöntem */}
          <div className="px-4 mt-5">
            <h2 id="feeding-method-heading" className={clsx(SECTION_HEADING, 'mb-3')}>
              {t('feeding.method.title')}
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
            <label htmlFor="feeding-notes" className={clsx(SECTION_HEADING, 'block mb-2')}>
              {t('feeding.notes.title')}
            </label>
            <textarea
              id="feeding-notes"
              rows={4}
              placeholder={t('feeding.notes.placeholder')}
              value={notes}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNotes(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-line bg-surface-1 text-ink-1 text-body placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-acc resize-none"
            />
          </div>

          {/* Kaydet */}
          <div className="px-4 mt-5 pb-28">
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
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-current border-t-transparent" />
                  {t('feeding.recording')}
                </>
              ) : (
                <>
                  <Package size={20} />
                  {parsedPour > 0
                    ? t('feeding.recordKg', { kg: parsedPour.toFixed(2) })
                    : t('feeding.record')}
                </>
              )}
            </Button>
            {!isOnline && (
              <p className="text-center text-warn text-body mt-3 font-medium">
                {t('feeding.offlineWillSync')}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
