/**
 * Architecture review — Ö: the proposed new sections (all three are now part
 * of v4 as §11–§13) and the flows to add, each [from, to, what, why].
 * Ported verbatim from the design document "Mimari İnceleme".
 */
import type { ProposedFlowRow, ProposedSection } from '../../types';

export const PROPOSED_SECTIONS: readonly ProposedSection[] = [
  {
    num: '11',
    title: 'Kontrol',
    text: 'Platformdan sahaya giden her şey: setpoint, aç/kapa, yemleyici programı, yerel otomatik kural, siren/röle çıkışı. Komut bir kayıttır: kim, hangi yetkiyle, ne zaman, edge’e ulaştı mı, cihaz ne yanıt verdi. Kilitler: bakımdaki ekipmana komut yok, canlı güvenliği eşiğini aşan setpoint yok, iki adımlı onay.',
    parts: ['komut', 'yetki ve onay', 'edge iletimi', 'cihaz yanıtı', 'komut günlüğü', 'kilitler'],
  },
  {
    num: '12',
    title: 'Stok, taraf ve belge',
    text: '09’daki girdi lotları, 05’teki yedek parça ve hiçbir yerde olmayan kimyasal, oksijen ve yakıt tek modelde. Taraf (tedarikçi, alıcı, yüklenici, laboratuvar, kurum) ve Belge kayıtları burada tanımlanır; diğer bölümler referans verir.',
    parts: ['malzeme lotu', 'depo hareketi', 'mal kabul', 'sevkiyat', 'taraf', 'belge'],
  },
  {
    num: '13',
    title: 'Zaman, dönem ve denetim izi',
    text: 'Platformun zaman modeli: iki zaman, tarihli bağ kuralları, dönem takvimi ve kilit, düzeltme kaydı, denetim izi, hesap sürümü. Diğer bölümlerin dayandığı ama hiçbirinin yazmadığı kurallar.',
    parts: [
      'olay / kayıt zamanı',
      'tarihli bağ kuralları',
      'dönem ve kilit',
      'düzeltme',
      'denetim izi',
      'hesap sürümü',
    ],
  },
];

export const PROPOSED_FLOWS: readonly ProposedFlowRow[] = [
  [
    'Alarm',
    'İzlenebilirlik',
    'alarm geçmişi, yerleşim dönemiyle partiye',
    '10’daki ölüm–DO ilişkisi',
  ],
  ['Alarm', 'Raporlama', 'alarm sayısı, onay ve çözüm süresi', 'operasyonel gösterge'],
  [
    'Bakım',
    'Üretim',
    'devam eden iş emri: üniteye stoklama ve transfer uyarısı',
    'bakımdaki tanka balık konmasın',
  ],
  [
    'Üretim',
    'Bakım',
    'ünite doluysa canlı güvenliği kilidi',
    'sistem durdurulamaz, bakım planlanır',
  ],
  ['Kişiler', 'Üretim', 'olayı giren kişi, yetkinlik şartı', 'tedavi ve kimyasal uygulaması'],
  ['Kişiler', 'İzlenebilirlik', '“kim” her olayda', '09 notu tabloda yoktu'],
  ['Raporlama', 'Enerji ve finans', 'dönem kilidi finansı da kilitler', 'K7 tek takvim'],
  ['Stok (12)', 'Üretim', 'SKT ve arınma kontrolü, silo karışım oranı', 'olay girişinde doğrulama'],
  ['Stok (12)', 'Enerji ve finans', 'ölçülmeyen kaynak tüketimi: oksijen, yakıt', '06.2'],
  ['Kontrol (11)', 'Veri', 'komut sonucu ve etkin setpoint tag olarak', 'izlenebilir komut'],
  ['Kontrol (11)', 'Alarm', 'iletilemeyen veya reddedilen komut', 'yeni alarm sınıfı'],
  ['Bakım', 'Kontrol (11)', 'devam eden iş emrinde komut kilidi', 'güvenlik'],
  ['Tesis', 'Alarm · Raporlama', 'izin limitleri eşik, ruhsat kapasitesi rapor', '01.5'],
  ['Üretim', 'Enerji ve finans', 'sevkiyat ve satış → gelir → parti sonucu', '04.2 · 06.4'],
];
