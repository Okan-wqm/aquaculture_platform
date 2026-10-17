/**
 * Platform architecture v4 — §04 Üretim: parti yaşam döngüsü.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section04: ArchitectureSection = {
  num: '04',
  title: 'Üretim: parti yaşam döngüsü',
  width: 1170,
  height: 600,
  intro:
    'Balık partisi, bulunduğu ünite, üzerindeki olaylar, plan ve sonuç. Tank bazlı ve parti bazlı rapor aynı kayıtlardan çıkar.',
  boxes: [
    box('u1', 14, 70, 'Tür ve evre', { sub: 'levrek, çipura · larva, yavru, büyütme' }),
    box('u2', 234, 70, 'Parti (lot)', {
      w: 180,
      sub: 'köken, adet, başlangıç ağırlığı',
      ex: 'P-2026-07',
      pills: ['soy ağacı'],
    }),
    box('u3', 464, 70, 'Yerleşim', {
      w: 190,
      sub: 'parti × ünite × tarih aralığı',
      pills: ['tarihli'],
    }),
    box('u4', 704, 70, 'Ünite', { ref: 'Bölüm 01', ex: 'B-03 → B-08', kind: 'ext' }),
    box('pl', 944, 70, 'Üretim planı', {
      w: 200,
      sub: 'stoklama, hedef hasat tarihi ve ağırlığı, kapasiteye karşı kullanım',
      kind: 'calc',
    }),
    box('bp', 14, 256, 'Besleme planı', {
      w: 180,
      h: 110,
      sub: 'yem tablosu: sıcaklık × boy → % biyokütle · günlük hedef',
      kind: 'calc',
    }),
    box('u7', 234, 256, 'Girdi lotları', {
      w: 180,
      h: 110,
      ref: 'Bölüm 12',
      sub: 'yem, ilaç, yavru · SKT ve karışım oranı · depo ünitesinde',
      kind: 'ext',
    }),
    box('u5', 464, 236, 'Olaylar', {
      w: 190,
      h: 210,
      sub: 'ünite + parti + zaman + kim',
      pills: [
        'besleme',
        'ölüm · ayıklama',
        'boylama · aşılama',
        'tedavi',
        'tartım · numune',
        'transfer · bölme · birleştirme',
        'açlık · kaçış',
        'hasat',
      ],
    }),
    box('u6', 704, 256, 'Hesaplar', {
      w: 210,
      h: 130,
      sub: 'biyokütle (büyüme modeli) · FCR · SGR · yaşama oranı · parti sonucu',
      kind: 'calc',
    }),
    box('x2', 964, 256, 'Su kalitesi ve enerji', {
      w: 180,
      h: 110,
      ref: 'Bölüm 02 · 06',
      sub: 'ünite ve sistem tag’leri',
      kind: 'ext',
    }),
    box('rc', 14, 486, 'Reçete', {
      w: 180,
      sub: 'veteriner hekim · ilaç lotu, doz, süre, arınma',
      kind: 'org',
    }),
    box('u8', 464, 486, 'Hasat', { w: 190, sub: 'parti, adet, kg, boy sınıfı · arınma kontrolü' }),
    box('sv', 704, 486, 'Sevkiyat ve satış', {
      w: 210,
      sub: 'n parti × adet × kg · araç, belge · tutar',
      ex: 'etiket lot no = sevkiyat no',
    }),
    box('al', 964, 486, 'Alıcı', { w: 180, ref: 'Bölüm 12', sub: 'taraf', kind: 'ext' }),
  ],
  links: [
    link('u1', 'u2', '1 : n'),
    link('u2', 'u3', '1 : n'),
    link('u3', 'u4', 'ünite'),
    link('u3', 'u5', 'olay yazılır', { fs: 'b', ts: 't' }),
    link('bp', 'u5', 'günlük yem planı', { fs: 't', ts: 't', ff: 0.5, tf: 0.2, my: 216 }),
    link('u7', 'u5', 'tüketilir', { tf: (311 - 236) / 210, at: [439, 296] }),
    link('u5', 'u6', '', { ff: (321 - 236) / 210 }),
    link('x2', 'u6', 'dağıtılır', { k: 'data', fs: 'l', ts: 'r', tf: (311 - 256) / 130 }),
    link('pl', 'u2', 'hedef · kapasiteye karşı', { fs: 't', ts: 't', ff: 0.5, tf: 0.5, my: 40 }),
    link('u6', 'pl', 'gerçekleşen', { fs: 't', ts: 'b', ff: 0.9, tf: 0.5, my: 206 }),
    link('rc', 'u5', 'reçeteli tedavi', { tf: (430 - 236) / 210, at: [329, 482] }),
    link('u5', 'u8', 'hasat olayı', { fs: 'b', ts: 't' }),
    link('u8', 'sv', 'sevk'),
    link('sv', 'u6', 'gelir', { fs: 't', ts: 'b' }),
    link('sv', 'al', 'alıcı'),
  ],
  notes: [
    'Parti bir tanka sabitlenmez. Yerleşim kaydı hangi tarihte hangi ünitede olduğunu tutar. Üretim planı partiye hedef verir: stoklama tarihi, hedef hasat tarihi ve ağırlığı; ruhsat kapasitesine (Bölüm 01) karşı kullanım burada izlenir.',
    'Her olay ünite + parti + zaman + kim ile kaydedilir. Parti o tarihte o ünitede değilse kayıt reddedilir; ünitede birden fazla parti varsa olay partiyi seçer. Ölü balığın partisi bilinmiyorsa olay ünite düzeyinde girilir ve adet ya da biyokütle oranıyla paylaştırılır; anahtar olayda saklanır.',
    'Transferde parti bölünebilir ya da birleşebilir; yeni parti eskilere bağlanır (soy ağacı). Tedavi altındaki partinin transferi uyarı verir; yetkili onayıyla geçilir, gerekçe olayda kalır.',
    'Yem, ilaç ve yavru lot kaydıyla (Bölüm 12) partiye doğrudan maliyet yazar; son kullanma tarihi geçmiş lot seçilemez. Tedavi reçeteye bağlıdır; reçetesiz tedavi girilemez. Arınma süresi dolmadan hasat girilemez; süre bölünen partiye geçer, birleşmede en uzun süre kalır; üniteye uygulanan tedavi (banyo) o anki tüm partilere yazılır.',
    'Besleme planı yem tablosundan günlük hedef üretir; gerçekleşen besleme plana karşı raporlanır. Biyokütle iki tartım arasında büyüme modeliyle tahmin edilir; tartım geldiğinde model düzeltilir, formül sürümü hesapta saklanır (Bölüm 13).',
    'Hasat olayı Hasat kaydını, hasat sevkiyatı besler. Sevkiyat birden fazla partiyi taşıyabilir; etiketteki lot numarası sevkiyat numarasıdır (Bölüm 09). Satış tutarı gelir olarak Hesaplar’a gider; parti sonucu = gelir − doğrudan − dolaylı gider (Bölüm 06).',
    'Tür ve evre alarm eşiklerini belirler (Bölüm 07). Aynı yapı Sera’da da çalışır: parti bitki partisi, ünite sera bölmesi, olaylar ekim, sulama, gübreleme, ilaçlama (hasat öncesi bekleme süresi = arınma) ve hasat.',
  ],
  rules: [
    'Parti kapanışı: stok 0 ve açık yerleşim yok → kapanış önerilir; kapanış onaylı ve tarihlidir, sonrası düzeltme kaydıdır. Kapanmadan parti sonucu kesinleşmez.',
    'Olay türleri yönetilen bir sözlüktür; her türün adet, kg, maliyet ve resmi bildirim etkisi tanımlıdır. Kaçış olayı Bölüm 08’e bildirim taslağı açar.',
    'Devam eden iş emri olan üniteye stoklama ve transfer uyarı verir (Bölüm 05).',
  ],
};
