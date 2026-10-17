/**
 * Architecture review — S: the twenty-scenario check, each
 * [scenario, what happens today, status, finding refs, anchor of the finding].
 * Ported verbatim from the design document "Mimari İnceleme".
 */
import type { ScenarioRow } from '../../types';

export const SCENARIOS: readonly ScenarioRow[] = [
  [
    'P-101’deki pompa değişti',
    'İş emri kapanır; varlık–pozisyon bağı elle güncellenmezse eski pompa takılı görünür.',
    'part',
    '05.3',
    'r05',
  ],
  [
    'Tank B-03 RAS-2’ye bağlandı',
    'Tarihli ağaç bağı; eski raporlar RAS-1 ile kalır.',
    'ok',
    '01 · K2',
    'r01',
  ],
  [
    'Edge 3 gün çevrimdışı kaldı, sonra bağlandı',
    'Tampon boşalır; eski değerler canlı alarm üretir, kapanmış gün raporu sessizce değişir.',
    'part',
    '02.3 · K1',
    'r02',
  ],
  [
    'Gece 03:00 DO alarmı, sorumlu izinli, vekil yok',
    'Zincir üst seviyeye çıkar; o saatte müsait kimse bulunmaz, nöbet kavramı yok.',
    'no',
    '03.4',
    'r03',
  ],
  [
    'Aynı tankta iki parti, banyo tedavisi',
    'Olay partiyi seçmek ister; iki partinin de arınma kilidi alması yazılmamış.',
    'part',
    '04.5',
    'r04',
  ],
  [
    'Hasatta sayım farkı −%6 çıktı',
    'Düzeltme kaydı var; farkın geçmişe dağıtılıp dağıtılmayacağı yok.',
    'part',
    '08.3',
    'r08',
  ],
  ['Kafesten kaçış oldu', 'Olay türü yok, resmi bildirim yok.', 'no', '04.1 · 08.4', 'r04'],
  [
    'Lab sonucu kilitli döneme geldi',
    'Düzeltme kaydı; hangi döneme işleyeceği belirsiz.',
    'part',
    '08.1 · 08.2',
    'r08',
  ],
  [
    'Elektrik kesildi, jeneratör 6 saat çalıştı',
    'Alarm üretilir; dizel tüketimi ve maliyeti kayda girmez.',
    'no',
    '06.2',
    'r06',
  ],
  [
    'Yem lotu BF-2231 geri çağrıldı',
    'Lot → besleme olayları → partiler bulunur; alıcı listesi sevkiyat olmadığı için parti bazında kalır.',
    'part',
    '09.1',
    'r09',
  ],
  [
    'Çalışan departman değiştirdi',
    'Tarihli üyelik; eski alarm ve görevler eski departmanda kalır.',
    'ok',
    '03',
    'r03',
  ],
  [
    'İl müdürlüğü form biçimini değiştirdi',
    'Şablon yeni sürüm; eski dönemler eski şablonla.',
    'ok',
    '08',
    'r08',
  ],
  ['Sera bölmelerine ısıtma gazı maliyeti', 'Gaz sayacı ve kaynak türü yok.', 'no', '06.2', 'r06'],
  [
    'Planlı bakım iş emri açıldı, pompa 2 hafta içinde arızalandı',
    'Bakım modu alarmı bastırır; arıza görünmez.',
    'no',
    '05.1',
    'r05',
  ],
  [
    'BL-1 iki sisteme hava veriyor; enerji maliyeti',
    'Hizmet oranı notta; dağıtım kullanmaz, gider tek sisteme yazılır.',
    'part',
    '01.3 · 06.1',
    'r06',
  ],
  [
    'Dış veteriner reçete yazıp raporu onaylıyor',
    'Çalışan kaydı olmayan hesap tanımlı değil.',
    'no',
    '03.3 · 04.6',
    'r03',
  ],
  [
    'Operatör yemleyici programını değiştirdi',
    'Komut yolu, yetki ve günlük yok; 09 “programı kuran kişi”yi ister.',
    'no',
    '02.6 · 11',
    'r02',
  ],
  [
    'DO sensörü kalibre edildi; önceki 3 günün verisi',
    'Kalibrasyon işareti kalkar; ham değer yoksa geri hesap yapılamaz.',
    'part',
    '02.4 · 05.5',
    'r02',
  ],
  [
    'Bir kamyonda iki parti alıcıya gitti',
    'Etiket tek partiye bağlanmak ister; sevkiyat kaydı yok.',
    'no',
    '09.1 · 04.2',
    'r09',
  ],
  [
    'Eşik değerini kim ne zaman değiştirdi?',
    'Olay günlüğü değişmez; ayar değişiklikleri için denetim izi yok.',
    'no',
    'K3',
    'rk',
  ],
];
