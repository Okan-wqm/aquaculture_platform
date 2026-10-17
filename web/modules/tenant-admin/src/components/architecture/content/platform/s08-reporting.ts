/**
 * Platform architecture v4 — §08 Raporlama: ünite, parti ve resmi raporlar.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';
import { REPORTING_TABLES } from './s08-reporting-tables';

export const section08: ArchitectureSection = {
  num: '08',
  title: 'Raporlama: ünite, parti ve resmi raporlar',
  width: 1170,
  height: 460,
  intro:
    'Raporlar ayrı veri tutmaz. Hepsi aynı olaylardan ve stok mutabakatından üretilir; tank raporu, parti raporu ve resmi beyan aynı rakamı verir.',
  groups: [group(0, 30, 1170, 182, 'Operasyonel'), group(0, 262, 1170, 180, 'Resmi')],
  boxes: [
    box('q1', 14, 70, 'Olaylar', {
      h: 110,
      ref: 'Bölüm 04',
      sub: 'ölüm, ayıklama, transfer, hasat, kaçış',
      kind: 'ext',
    }),
    box('q2', 234, 70, 'Stok mutabakatı', {
      w: 200,
      h: 110,
      sub: 'açılış + giriş − ölüm − ayıklama − çıkış − hasat = kapanış',
      kind: 'calc',
    }),
    box('q3', 484, 70, 'Ünite ve parti raporları', {
      w: 200,
      h: 110,
      sub: 'günlük ünite, parti yaşam boyu, ölüm analizi, plan–gerçekleşen, alarm',
    }),
    box('q5', 734, 70, 'Ekran ve dışa aktarım', {
      w: 190,
      h: 110,
      sub: 'pano, PDF, Excel, planlı e-posta · formül sürümü raporda',
    }),
    box('q4', 974, 70, 'Sayım', {
      w: 180,
      h: 110,
      sub: 'transfer ve hasatta · sayılan − hesaplanan = sayım farkı olayı',
    }),
    box('q6', 14, 300, 'İzin, ilaç, su kalitesi', {
      h: 110,
      ref: 'Bölüm 01 · 02 · 04',
      sub: 'izin limitleri, reçete, arınma, deşarj',
      kind: 'ext',
    }),
    box('q7', 234, 300, 'Resmi rapor şablonu', {
      w: 200,
      h: 110,
      sub: 'mevzuat biçimi · dönem · saha · onay zinciri',
    }),
    box('q8', 484, 300, 'Onay', {
      w: 200,
      h: 110,
      sub: 'sorumluluk türüne göre · hazırlayan onaylayamaz',
      pills: ['Bölüm 03'],
      kind: 'assign',
    }),
    box('q9', 734, 300, 'Dönem kilidi ve arşiv', {
      w: 190,
      h: 110,
      ref: 'Bölüm 13',
      sub: 'gün kapanışı T+2 · tek takvim · düzeltme sürümlü',
      kind: 'ext',
    }),
    box('q10', 974, 300, 'Gönderim', {
      w: 180,
      h: 110,
      sub: 'il müdürlüğü, denetçi, sertifika kuruluşu (taraf)',
    }),
  ],
  links: [
    link('q1', 'q2', ''),
    link('q2', 'q3', ''),
    link('q3', 'q5', ''),
    link('q4', 'q2', 'sayım farkı', { fs: 't', ts: 't', ff: 0.5, tf: 0.5, my: 48 }),
    link('q2', 'q7', 'stok ve olaylar', { fs: 'b', ts: 't' }),
    link('q6', 'q7', ''),
    link('q7', 'q8', ''),
    link('q8', 'q9', ''),
    link('q9', 'q10', ''),
    link('q9', 'q2', 'kilitler', { k: 'ctrl', fs: 't', ts: 'b', ff: 0.5, tf: 0.8, my: 238 }),
  ],
  notes: [
    'Stok mutabakatı her ünite ve parti için sayıyı kapatır: açılış + giriş − ölüm − ayıklama − transfer çıkışı − hasat = kapanış. Biyokütle tartım ve numuneden güncellenir. Kayıt kapanış penceresi: gün kapanışı T+2, dönem kilidi dönem sonu + 5 gün; pencere içinde giriş serbest, sonrası düzeltme kaydı (Bölüm 13).',
    'Sayım yalnız transfer ve hasatta mümkündür. Fark “sayım farkı” olayı olarak sayım tarihine yazılır, geçmiş yeniden hesaplanmaz, raporlarda ayrı satır gösterilir; kim ve neden bilgisiyle. Eski kayıt silinmez.',
    'Onaylanan dönem kilitlenir; operasyon, finans ve resmi rapor aynı takvimi kullanır (Bölüm 13). Sonradan bulunan hata düzeltme kaydıyla girer: operasyonel ve resmi rapor ilgili döneme yeni sürüm olarak yeniden üretilir; finansal etki cari döneme “önceki dönem düzeltmesi” satırıyla işler. İkisi birbirine referans verir.',
    'Resmi rapor şablonu biçimi, dönemi ve onay zincirini (sıra, zorunlu sorumluluk türleri) tanımlar; ret gerekçeyle taslağa döndürür. Hazırlayan onaylayamaz. Rutin denetimde istenecek kayıtlar her zaman hazır tutulur.',
  ],
  rules: [
    'Rapor hangi formül sürümüyle üretildiğini yazar; eski dönem eski sürümle yeniden üretilir (Bölüm 13).',
    'Kaçış, olağan dışı ölüm ve hastalık bildirimleri olay eşiği aşılınca taslak olarak otomatik hazırlanır; gönderim onay ister.',
  ],
  tables: REPORTING_TABLES,
};
