/**
 * Platform architecture v4 — §06 Enerji ve finans.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section06: ArchitectureSection = {
  num: '06',
  title: 'Enerji ve finans',
  width: 1170,
  height: 500,
  intro:
    'Sayaç ağacından tüketime, tüketimden maliyet merkezine, oradan partilere; gelir de aynı yere akar. Tutar tek yoldan gider.',
  boxes: [
    box('n1', 14, 60, 'Ana sayaç', {
      sub: 'sahanın girişi · kaynak türü: elektrik, su, oksijen, gaz, yakıt',
      ex: 'EM-AYV',
      kind: 'asset',
    }),
    box('n2', 234, 60, 'Pano sayacı', { sub: 'dağıtım panosu', ex: 'PANO-1', kind: 'asset' }),
    box('n3', 454, 60, 'Alt sayaç', { sub: 'ekipman ölçer', ex: 'PM-101', kind: 'asset' }),
    box('n4', 674, 60, 'Pozisyon', { ref: 'Bölüm 01', ex: 'P-101', kind: 'ext' }),
    box('n5', 904, 60, 'Dağıtım', {
      w: 250,
      h: 110,
      sub: 'her seviyede: üst − ölçülen alt = kalan → anahtarla · açıklanamayan = genel gider · tutar = tüketim × tarife',
      kind: 'calc',
    }),
    box('fm', 14, 210, 'Fatura mutabakatı', {
      sub: 'ana sayaç × tarife ↔ fatura · fark kalite kaydı',
      kind: 'calc',
    }),
    box('ws', 434, 210, 'İşçilik', {
      w: 190,
      ref: 'Bölüm 03',
      sub: 'puantaj × saat ücreti · iş emri saatleri varlığın yerine',
      kind: 'ext',
    }),
    box('tr', 674, 210, 'Tarife', {
      sub: 'zamanlı tarife, güç bedeli, reaktif · kaynak türüne göre',
      pills: ['tarihli'],
    }),
    box('hz', 904, 210, 'Hizmet oranı', {
      w: 250,
      ref: 'Bölüm 01',
      sub: 'pozisyon → sistem · %60 / %40 · boş ünite merkezde kalır',
      kind: 'ext',
    }),
    box('n7', 194, 360, 'Departman', {
      ref: 'Bölüm 03',
      sub: 'kendi merkezlerinin toplamı',
      kind: 'ext',
    }),
    box('n9', 434, 360, 'Bütçe ve göstergeler', {
      w: 180,
      sub: 'merkez bazında bütçe / gerçekleşen · kWh/kg',
      kind: 'calc',
    }),
    box('n6', 674, 360, 'Maliyet merkezi', { w: 190, sub: 'yere atanır', ex: 'MM-110' }),
    box('n8', 934, 360, 'Parti sonucu', {
      w: 200,
      ref: 'Bölüm 04',
      sub: 'gelir (sevkiyat) − doğrudan (yem, ilaç, yavru) − dolaylı (merkezden)',
      kind: 'ext',
    }),
  ],
  links: [
    link('n1', 'n2', '1 : n'),
    link('n2', 'n3', '1 : n'),
    link('n3', 'n4', 'ölçer · tarihli', { at: [649, 42] }),
    link('n4', 'n5', 'tüketim', { k: 'data', tf: 48 / 110 }),
    link('fm', 'n1', 'fatura ↔ sayaç', { fs: 't', ts: 'b' }),
    link('tr', 'n5', 'fiyat · tarihli', { fs: 't', ts: 'b', ff: 0.5, tf: 0.1, my: 190 }),
    link('n5', 'hz', 'oran', { fs: 'b', ts: 't', ff: 0.5, tf: 0.5 }),
    link('hz', 'n6', 'yere göre', { fs: 'b', ts: 't', ff: 0.5, tf: 0.5, my: 333 }),
    link('ws', 'n6', 'anahtarla', { k: 'assign', fs: 'b', ts: 't', ff: 0.5, tf: 0.15, my: 333 }),
    link('n6', 'n8', 'partiye'),
    link('n9', 'n6', 'bütçe'),
    link('n6', 'n7', 'sorumlu departman', {
      k: 'assign',
      fs: 'b',
      ts: 'b',
      ff: 0.3,
      tf: 0.5,
      my: 482,
    }),
  ],
  notes: [
    'Sayaç ağacı dağıtımı izler, organizasyonu değil. Her sayacın kaynak türü vardır: elektrik, su, oksijen, gaz, yakıt; aynı ağaç ve aynı dağıtım kuralı. Ölçülmeyen kaynak (tüp oksijen, tanker dizel, sera gazı) stok hareketinden sanal sayaç olarak girer (Bölüm 12).',
    'Dağıtım her sayaç seviyesinde yapılır: üst sayaçtan ölçülen alt sayaçlar çıkarılır, kalan ölçülmeyen ekipmana anahtarla (nominal güç × çalışma saati) paylaştırılır. Tahmin sayacı aşamaz; açıklanamayan kısım üst seviyenin maliyet merkezine genel gider olarak düşer. Alt sayaçların toplamı üst sayacı aşarsa kalan negatiftir: kalite bayrağı, dağıtım o gün durur.',
    'Birden fazla yere hizmet eden pozisyonun tüketimi hizmet oranıyla (Bölüm 01) yerlere bölünür, sonra maliyet merkezine gider. Boş ünitenin (temizlik, bekleme) tüketimi partiye değil merkezde kalır.',
    'Tutar = tüketim × o günün tarifesi (zamanlı tarife, güç bedeli, reaktif). Tarife tarihlidir. Aylık fatura ana sayaçla mutabık edilir; fark kalite kaydıdır.',
    'Dolaylı gider tek yoldan akar: dağıtım → maliyet merkezi → o tarihte o ünitelerdeki partiler, biyokütleye göre. Doğrudan gider (yem, ilaç, yavru) olayla partiye yazılır. İşçilik: iş emri saatleri varlığın yerine, kalan puantaj departmanın işlettiği yerlere. Hiçbir tutar iki kez sayılmaz.',
    'Gelir sevkiyat ve satış kaydından (Bölüm 04) partiye akar; parti sonucu = gelir − doğrudan − dolaylı. Bütçe maliyet merkezi bazında tutulur; departman raporu kendi merkezlerinin toplamıdır.',
  ],
  rules: [
    'Amortisman kapsam dışıdır: varlık değeri ve ömrü kayıtlı tutulur, amortisman gideri muhasebeden dönem sonunda maliyet merkezine tek satır olarak alınır.',
    'Finans dönemi Bölüm 13’teki tek takvimdir; kilitli döneme düşen düzeltme cari döneme “önceki dönem düzeltmesi” satırıyla işler.',
  ],
};
