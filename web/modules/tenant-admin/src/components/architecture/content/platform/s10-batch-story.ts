/**
 * Platform architecture v4 — §10 Parti hayat hikâyesi: örnek P-2026-07.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';

export const section10: ArchitectureSection = {
  num: '10',
  title: 'Parti hayat hikâyesi: örnek P-2026-07',
  width: 1170,
  height: 660,
  intro:
    'Bir partinin 107 günlük geçmişi, şeritler hâlinde. Her şerit ayrı bir kaynaktan gelir, hepsi aynı anahtarla birleşir.',
  groups: [
    group(200, 30, 275, 516, 'Temmuz'),
    group(475, 30, 275, 516, 'Ağustos'),
    group(750, 30, 267, 516, 'Eylül'),
    group(1017, 30, 133, 516, 'Ekim'),
  ],
  boxes: [
    box('l1', 14, 60, 'Yerleşim', { w: 170, h: 56, ref: 'Bölüm 04', kind: 'ext' }),
    box('y1', 200, 60, 'B-03 · RAS-1', { w: 440, h: 56, kind: 'place' }),
    box('y2', 644, 60, 'B-08 · RAS-2', { w: 502, h: 56, kind: 'place' }),
    box('l2', 14, 130, 'Su kimyası', { w: 170, h: 56, ref: 'Bölüm 02', kind: 'ext' }),
    box('w1', 200, 130, 'DO ort. 7,6 · 3 gün sınır dışı', { w: 440, h: 56, kind: 'data' }),
    box('w2', 644, 130, 'DO ort. 7,9 · 1 gün sınır dışı', { w: 502, h: 56, kind: 'data' }),
    box('l3', 14, 200, 'Yem lotu', { w: 170, h: 56, ref: 'Bölüm 09 · 12', kind: 'ext' }),
    box('f1', 200, 200, 'BF-2207 · 2 mm', { w: 307, h: 56, kind: 'asset' }),
    box('f2', 511, 200, 'BF-2231 · 3 mm', { w: 449, h: 56, kind: 'asset' }),
    box('f3', 964, 200, 'SK-0912', { w: 182, h: 56, kind: 'asset' }),
    box('l4', 14, 270, 'Tedavi', { w: 170, h: 56, ref: 'Bölüm 04', kind: 'ext' }),
    box('d1', 573, 270, 'OTC · reçete', { w: 85, h: 56, kind: 'calc' }),
    box('d2', 662, 270, 'arınma · hasat kilitli · bölünen partiye geçti', {
      w: 484,
      h: 56,
      kind: 'hatch',
    }),
    box('l5', 14, 340, 'Ölüm', { w: 170, h: 56, ref: 'Bölüm 04', kind: 'ext' }),
    box('m1', 200, 340, 'normal · 5–14 / gün', { w: 351, h: 56, kind: 'place' }),
    box('m2', 555, 340, 'ölüm tepesi', { w: 138, h: 56, kind: 'warn' }),
    box('m3', 697, 340, 'normal', { w: 449, h: 56, kind: 'place' }),
    box('l6', 14, 410, 'Olaylar', { w: 170, h: 56, ref: 'Bölüm 04', kind: 'ext' }),
    box('e1', 555, 410, 'numune', { w: 76, h: 56, kind: 'place' }),
    box('e2', 644, 410, 'transfer · bölme · uyarı onaylı', { w: 180, h: 56, kind: 'place' }),
    box('e3', 875, 410, 'ayıklama', { w: 85, h: 56, kind: 'place' }),
    box('l7', 14, 480, 'Alarm', { w: 170, h: 56, ref: 'Bölüm 07', kind: 'ext' }),
    box('al1', 540, 480, 'DO düşük · 3 alarm · ort. onay 6 dk', { w: 230, h: 56, kind: 'warn' }),
    box('r1', 200, 570, 'Hayat hikâyesi raporu', {
      w: 440,
      h: 76,
      sub: 'şeritler parti + yerleşim + zaman anahtarıyla birleşir',
      kind: 'calc',
    }),
    box('r2', 690, 570, 'Geri ve ileri izleme', {
      w: 460,
      h: 76,
      sub: 'etiket lot no → sevkiyat → parti → bu şeritler · yem lotu → onu yiyen tüm partiler',
    }),
  ],
  links: [
    link('l1', 'y1', ''),
    link('l2', 'w1', '', { k: 'data' }),
    link('l3', 'f1', ''),
    link('l4', 'd1', '', { mx: 192 }),
    link('l5', 'm1', ''),
    link('l6', 'e1', '', { mx: 192 }),
    link('l7', 'al1', '', { mx: 192 }),
    link('y1', 'w1', 'dönemle çekilir', {
      k: 'data',
      fs: 'b',
      ts: 't',
      ff: 0.5,
      tf: 0.5,
      at: [422, 123],
    }),
  ],
  notes: [
    'Rapor için ayrıca veri girilmez. Şeritlerin hepsi olay, yerleşim, ölçüm, alarm ve lot kayıtlarından çekilir ve parti + yerleşim + zaman anahtarıyla birleşir.',
    'Su kimyası yerleşim dönemine göre çekilir: B-03 dönemi RAS-1’in, B-08 dönemi RAS-2’nin ölçüm noktalarından. Sonuç dönem ortalaması ve sınır dışı kalınan gün sayısıdır.',
    'Yem şeridi silo hareketinden gelir. 22–24.09’da siloda BF-2231 ile SK-0912 %60/%40 karıştı; o günlerdeki besleme iki lota bu oranla yazıldı. Her lottan içerik, tedarikçi ve besleyen kişiye inilir.',
    'Ölüm tepesi aynı günlerdeki üç DO alarmı ve 24 °C sıcaklıkla birlikte görülür; analiz parti serisinde yapılır, transfer seriyi kesmez. Tedavi reçeteye bağlıdır ve arınma süresini başlatır; tedavi sırasındaki transfer uyarı verdi, yetkili onayıyla geçildi.',
    'Transferde bölünen P-2026-07B bu hikâyeyi ve arınma kilidini 20.08’e kadar devralır; sonrası kendi şeritleridir.',
  ],
};
