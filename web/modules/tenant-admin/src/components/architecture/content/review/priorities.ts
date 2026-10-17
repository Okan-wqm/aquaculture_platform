/**
 * Architecture review — "Önce bunlar": the eight items that affect more than
 * one section or produce a wrong result, each [title, text, refs, anchor].
 * Ported verbatim from the design document "Mimari İnceleme".
 */
import type { PriorityRow } from '../../types';

export const PRIORITIES: readonly PriorityRow[] = [
  [
    'Kontrol yolu yok',
    'Setpoint, yemleyici programı ve Kontrol modülü var; komut, yetki, iletim ve günlük tanımsız. “Yalnız ayar iner” cümlesi gerçekle çelişiyor.',
    '02.6 · 11.1 · yeni bölüm 11',
    'r02',
  ],
  [
    'İki zaman modeli yazılmamış',
    'Geç veri, dönem kilidi, düzeltme ve “eski rapor eski yapıyla” aynı temele dayanır; temel yok.',
    'K1 · 02.3 · 08.1 · 08.2',
    'rk',
  ],
  [
    'Bakım modu yanlış anda başlıyor',
    'Planlı iş emri açılır açılmaz alarm bastırılır; gerçek arıza haftalarca görünmez.',
    '05.1 · 07',
    'r05',
  ],
  [
    'Kanal parametresiz bağlanıyor',
    'Kanal → ölçüm noktası; tag nokta + parametre. Aynı noktada iki parametre çakışır.',
    '02.1',
    'r02',
  ],
  [
    'Sorumluluk tek tip',
    'Arıza alarmı ve DO alarmı aynı kişiye; veteriner, çevre, kalite onayı bulunamaz.',
    '03.2 · 07.1 · 08.6',
    'r03',
  ],
  [
    'Sevkiyat ve gelir yok',
    'Alıcıdaki etiket tek partiye zorlanır; parti kârı hesaplanamaz.',
    '04.2 · 06.4 · 09.1',
    'r04',
  ],
  [
    'Enerji yalnız elektrik',
    'Oksijen, dizel ve sera gazı — gerçek giderin büyük kısmı — ağaçta yok.',
    '06.2',
    'r06',
  ],
  [
    'Üç şey iki kez modellenmiş',
    'İki stok, iki dönem kilidi, dağınık taraf listesi. Tek model: stok, taraf, dönem.',
    'K4 · K5 · K7',
    'rk',
  ],
];
