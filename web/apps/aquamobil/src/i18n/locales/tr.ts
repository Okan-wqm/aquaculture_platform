/**
 * AquaMobil Türkçe mesajları (P-28 — mobil i18n, Faz 6).
 *
 * `Record<MessageKey, string>` tipi en.ts ile birebir anahtar paritesini
 * derleme zamanında zorlar — eksik anahtar compile hatasıdır.
 */
import type { MessageKey } from './en';

export const tr: Record<MessageKey, string> = {
  // ── Ortak ──
  'common.loading': 'Yükleniyor...',
  'common.cancel': 'İptal',
  'common.close': 'Kapat',
  'common.optional': 'İsteğe bağlı',

  // ── Yemleme (öğün cutover'ı) ──
  'feeding.title': 'Yemleme Kaydı',
  'feeding.offlineCachedBanner':
    'Çevrimdışı — son eşitlenen plan gösteriliyor. Bağlantı gelince yenilenecek.',
  'feeding.selectUnit': 'Ünite Seç',
  'feeding.selectUnitPlaceholder': '-- Ünite Seç --',
  'feeding.noPlanForUnit': 'Bu ünite için bugün yemleme planı yok',
  'feeding.noPlanForUnitHint': 'Bu üniteye atanmış aktif bir yemleme protokolü yok.',
  'feeding.noPlansToday': 'Bugün için yemleme planı yok',
  'feeding.noPlansTodayHint':
    'Gün planları, aktif protokol ataması olan üniteler için her sabah üretilir.',
  'feeding.progress': '{done}/{total} öğün',
  'feeding.plannedTotal': 'Planlanan toplam',
  'feeding.feed': 'Yem',
  'feeding.biomass': 'Biyokütle',
  'feeding.rate': 'Oran',
  'feeding.expectedFcr': 'Beklenen FCR',
  'feeding.waterTemp': 'Su sıcaklığı',
  'feeding.defaultTempWarning': 'Sıcaklık kaynağı yok — taban oran uygulanıyor (düzeltme yok).',
  'feeding.meals': 'Öğünler',
  'feeding.meal': 'Öğün {index}',
  'feeding.mealStatus.SCHEDULED': 'Planlı',
  'feeding.mealStatus.FED': 'Yemlendi',
  'feeding.mealStatus.PARTIALLY_FED': 'Kısmen yemlendi',
  'feeding.mealStatus.SKIPPED': 'Atlandı',
  'feeding.mealStatus.MISSED': 'Kaçırıldı',
  'feeding.mealStatus.CANCELLED': 'İptal edildi',
  'feeding.pour.amountTitle': 'Döküm Miktarı (kg)',
  'feeding.pour.remaining': 'Plandan kalan: {kg} kg',
  'feeding.pour.finalize': 'Öğünü bitir',
  'feeding.pour.finalizeHint':
    'Öğünü yemlendi olarak işaretler: varyans, büyüme ve kalan öğün yeniden hesabı bitişte koşar.',
  'feeding.method.title': 'Yemleme Yöntemi',
  'feeding.method.manual': 'Elle',
  'feeding.method.automatic': 'Otomatik',
  'feeding.method.demand': 'Talep',
  'feeding.notes.title': 'Notlar (İsteğe bağlı)',
  'feeding.notes.placeholder': 'Ek gözlemler...',
  'feeding.record': 'Yemleme Kaydet',
  'feeding.recordKg': '{kg} kg Kaydet',
  // W8/FARM-MEDIUM-269 — kısmi öğünü döküm eklemeden kapat.
  'feeding.finalizeOnly': 'Öğünü bitir (yem eklemeden)',
  'feeding.recording': 'Kaydediliyor...',
  'feeding.recorded': 'Kaydedildi!',
  'feeding.queuedForSync': 'Eşitleme kuyruğuna alındı',
  'feeding.savedToDevice': 'Cihaza kaydedildi',
  'common.backToHome': 'Ana sayfaya dön',
  'feeding.offlineWillSync': 'Çevrimdışı - bağlanınca eşitlenecek',
  'feeding.errors.amountRequired': "Miktar 0'dan büyük olmalı",
  'feeding.errors.amountMax': 'Miktar 10000 kg üzerinde olamaz',
  'feeding.errors.generic': 'Yemleme kaydedilemedi',
};
