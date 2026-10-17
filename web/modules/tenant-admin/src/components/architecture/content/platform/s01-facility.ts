/**
 * Platform architecture v4 — §01 Tesis yapısı: yer, varlık, izin.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';

export const section01: ArchitectureSection = {
  num: '01',
  title: 'Tesis yapısı: yer, varlık, izin',
  width: 1170,
  height: 470,
  intro:
    'Platformun omurgası. Her şey bir yere bağlanır; yerlere takılan fiziksel parçalar, yere bağlı izinler ve birden fazla yere hizmet eden pozisyonlar ayrı tutulur.',
  groups: [
    group(0, 30, 1170, 172, 'Yer ağacı · bağlar tarihli · alan ve sistem isteğe bağlı'),
    group(0, 272, 544, 160, 'İzin ve hizmet'),
    group(572, 272, 598, 160, 'Varlık · değişir, tarihli takılır'),
  ],
  boxes: [
    box('co', 14, 76, 'Şirket', { w: 165, h: 104, sub: 'platformdaki müşteri', ex: 'Tenant' }),
    box('si', 206, 76, 'Saha', {
      w: 165,
      h: 104,
      sub: 'coğrafi konum · ruhsat ve izinler',
      ex: 'SITE-A · Ayvalık',
    }),
    box('al', 398, 76, 'Alan', {
      w: 165,
      h: 104,
      sub: 'bina, salon, kafes alanı',
      ex: 'Büyütme salonu',
    }),
    box('sy', 590, 76, 'Sistem', {
      w: 165,
      h: 104,
      sub: 'proses hattı · kafeste atlanır',
      ex: 'RAS-1',
    }),
    box('un', 782, 76, 'Ünite', {
      w: 165,
      h: 104,
      sub: 'tür: tank, kafes, havuz, silo, depo · hacim',
      ex: 'B-03',
    }),
    box('po', 974, 76, 'Pozisyon', {
      w: 180,
      h: 104,
      sub: 'ekipman yeri veya ölçüm noktası',
      ex: 'P-101 · MP-1',
    }),
    box('iz', 14, 308, 'İzin ve belge', {
      w: 230,
      h: 108,
      sub: 'ruhsat kapasitesi (tür, ton/yıl) · deşarj izni limitleri · geçerlilik',
      pills: ['Bölüm 12 belge', 'süresi dolmadan uyarır'],
    }),
    box('hz', 300, 308, 'Hizmet ataması', {
      w: 230,
      h: 108,
      sub: 'pozisyon → sistem veya ünite · oran',
      ex: 'BL-1: RAS-1 %60 · RAS-2 %40',
      pills: ['tarihli'],
      kind: 'assign',
    }),
    box('ty', 590, 308, 'Varlık türü', {
      w: 165,
      h: 108,
      sub: 'pompa, blower, sensör, sayaç, edge cihazı',
      kind: 'asset',
    }),
    box('md', 782, 308, 'Varlık modeli', {
      w: 165,
      h: 108,
      sub: 'üretici, güç, bakım aralığı',
      ex: 'Grundfos NB 65-200',
      kind: 'asset',
    }),
    box('as', 974, 308, 'Varlık', {
      w: 180,
      h: 108,
      sub: 'seri no · durum: depoda, takılı, bakımda, hurda',
      ex: 'GF-98213-0447',
      kind: 'asset',
    }),
  ],
  links: [
    link('co', 'si', '1 : n'),
    link('si', 'al', '1 : n'),
    link('al', 'sy', '1 : n'),
    link('sy', 'un', '1 : n'),
    link('un', 'po', '1 : n'),
    link('si', 'po', 'her seviyeye bağlanabilir', { fs: 't', ts: 't', ff: 0.5, tf: 0.3, my: 54 }),
    link('iz', 'si', 'sahaya · süreli', { fs: 't', ts: 'b', ff: 0.5, tf: 0.5, my: 244 }),
    link('hz', 'sy', 'sisteme · oran', {
      k: 'assign',
      fs: 't',
      ts: 'b',
      ff: 0.5,
      tf: 0.3,
      my: 230,
    }),
    link('po', 'hz', 'pozisyon', { k: 'assign', fs: 'b', ts: 't', ff: 0.2, tf: 0.8, my: 262 }),
    link('ty', 'md', '1 : n'),
    link('md', 'as', '1 : n'),
    link('as', 'po', 'takılı · tarihli', { fs: 't', ts: 'b', ff: 0.5, tf: 0.5 }),
  ],
  notes: [
    'Raporlar, veri, sorumluluk ve maliyet hep yere bağlanır. Alan ve Sistem isteğe bağlıdır: kafes sahasında kafes doğrudan alana bağlanır; raporlar boş seviyeyi atlayarak yukarı toplar.',
    'Yer ağacının kendi bağları da tarihlidir: tank başka bir sisteme bağlanabilir, alan bölünebilir. Eski raporlar eski yapıyla kalır (Bölüm 13).',
    'Pozisyon süreçteki bir yerdir: pompa yeri P-101 ya da ölçüm noktası MP-1. Pompa değişse de P-101 kalır. Pozisyon her seviyeye bağlanabilir: ana sayaç sahaya, salon sıcaklığı alana, pompa sisteme, DO ölçümü üniteye.',
    'Depo bir ünite türüdür: yem deposu, ilaç dolabı, yedek parça deposu, silo. Proses dışıdır, doğrudan alana bağlanır; stok hareketi Bölüm 12’de.',
    'Birden fazla sisteme hizmet eden pozisyon (BL-1) hizmet atamasıyla oranlanır; Bölüm 06 dağıtımı bu oranı kullanır. Oran tarihlidir.',
    'Varlığın durumu vardır: depoda, takılı, bakımda, hurda. Takılma ve sökülme bakım kapanışıyla yazılır (Bölüm 05). Operasyon geçmişi yere, bakım geçmişi varlığa yazılır. Edge cihazı, sensör ve sayaç da varlıktır; bu kayıt bakım içindir, verinin nereye yazılacağını belirlemez (Bölüm 02).',
    'İzin ve belge sahaya bağlıdır: ruhsat kapasitesi, deşarj izni limitleri, geçerlilik. Limitler Bölüm 07’ye eşik, kapasite Bölüm 08’e rapor olur.',
  ],
  rules: [
    'Her yer her an tek ebeveyne bağlıdır; çocuğun dönemi ebeveynin dönemi içindedir (Bölüm 13).',
    'Açık yerleşimi, takılı varlığı ya da devam eden iş emri olan yer kapatılamaz.',
    'Ünitenin hacmi ve azami yoğunluğu zorunludur; yoğunluk eşiği (kg/m³) buradan hesaplanır.',
  ],
};
