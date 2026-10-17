/**
 * Platform architecture v4 — §09 İzlenebilirlik: bir partinin hayat hikâyesi.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';

export const section09: ArchitectureSection = {
  num: '09',
  title: 'İzlenebilirlik: bir partinin hayat hikâyesi',
  width: 1170,
  height: 480,
  intro:
    'Bir parti için geriye (köken, yem, su, ilaç) ve ileriye (hasat, sevkiyat, alıcı) her kayıt aynı anahtarla bulunur: parti + yerleşim + zaman.',
  groups: [group(0, 30, 1170, 182, 'Girdi lotları · Bölüm 12'), group(0, 262, 1170, 180, 'Parti')],
  boxes: [
    box('t1', 14, 70, 'Tedarikçi', {
      h: 110,
      ref: 'Bölüm 12',
      sub: 'taraf: yem fabrikası, kuluçkahane, ilaç deposu',
      kind: 'ext',
    }),
    box('t2', 234, 70, 'Mal kabul', {
      w: 200,
      h: 110,
      ref: 'Bölüm 12',
      sub: 'irsaliye (belge), tarih, kontrol eden kişi',
      kind: 'ext',
    }),
    box('t3', 484, 70, 'Malzeme lotu', {
      w: 200,
      h: 110,
      ref: 'Bölüm 12',
      sub: 'içerik, analiz sertifikası, son kullanma',
      pills: ['protein · yağ · kül · nem'],
      kind: 'ext',
    }),
    box('t4', 734, 70, 'Silo ve depo hareketi', {
      w: 190,
      h: 110,
      ref: 'Bölüm 12',
      sub: 'lot bazında giriş ve çıkış · karışım oranı',
      kind: 'ext',
    }),
    box('t5', 974, 70, 'Besleme olayı', {
      w: 180,
      h: 110,
      ref: 'Bölüm 04',
      sub: 'ünite, parti, kg, kim',
      kind: 'ext',
    }),
    box('k1', 14, 300, 'Köken', { h: 110, sub: 'anaç, yumurta, yavru · sağlık sertifikası' }),
    box('k2', 234, 300, 'Parti', {
      w: 200,
      h: 110,
      sub: 'soy ağacı · birleşmede oranlı devralma',
      ex: 'P-2026-07',
      kind: 'hub',
    }),
    box('k3', 484, 300, 'Yerleşim × zaman', {
      w: 200,
      h: 110,
      sub: 'hangi ünitede, hangi dönem',
      pills: ['tarihli'],
    }),
    box('k4', 734, 300, 'Hayat hikâyesi', {
      w: 190,
      h: 110,
      sub: 'su kimyası, yem, tedavi, alarm, komut, sağlık, transfer',
      kind: 'calc',
    }),
    box('k5', 974, 300, 'Sevkiyat → alıcı', {
      w: 180,
      h: 110,
      ref: 'Bölüm 04',
      sub: 'etiketteki lot no = sevkiyat no · n parti',
      kind: 'ext',
    }),
  ],
  links: [
    link('t1', 't2', ''),
    link('t2', 't3', '1 : n'),
    link('t3', 't4', 'stoka girer', { at: [709, 54] }),
    link('t4', 't5', 'lot ve oran', { at: [949, 54] }),
    link('t5', 'k4', 'yem lotu ve içeriği', {
      k: 'data',
      fs: 'b',
      ts: 't',
      ff: 0.5,
      tf: 0.5,
      my: 238,
    }),
    link('k1', 'k2', 'köken'),
    link('k2', 'k3', ''),
    link('k3', 'k4', 'dönemle çeker', { k: 'data', at: [709, 284] }),
    link('k4', 'k5', ''),
    link('k5', 'k2', 'geri izleme', { k: 'ctrl', fs: 'b', ts: 'b', ff: 0.5, tf: 0.5, my: 456 }),
  ],
  notes: [
    'Malzeme lotu girdinin kimliğidir: tedarikçi, irsaliye, üretim ve son kullanma tarihi, analiz sertifikası (protein, yağ, kül, nem, katkı, hammadde kaynağı, ilaçlı mı). Yem, ilaç, yavru, yedek parça ve kimyasal için aynı kayıt kullanılır (Bölüm 12); son kullanma tarihi geçmiş lot olayda seçilemez.',
    'Silo ve depo hareketi lot bazında tutulur, önce giren önce çıkar. Siloda lotlar karışınca karışım oranı hesaplanır; besleme olayı hangi lottan ne oranda verildiğini bu hesaptan alır. Silo sayımı oranı ileriye dönük düzeltir.',
    'Su kimyası partiye ayrıca yazılmaz. Yerleşim kaydındaki her dönem için ünitenin kendi ölçüm noktalarından çekilir; parametre yoksa üst sistemin noktası kullanılır; ikisi varsa ünite önceliklidir, sistem karşılaştırma için saklanır. Sonuç dönem ortalaması ve sınır dışı kalınan süredir.',
    'Aynı ünitede birden fazla parti varsa yem, enerji ve ilaç biyokütle payına göre bölünür. Birleşen partinin geçmişi atalarından birleşme oranıyla devralınır. Alarm geçmişi (Bölüm 07) ve komut günlüğü (Bölüm 11) de yerleşim dönemiyle çekilen şeritlerdir.',
    '“Kim” her olayda saklanır: elle girilen kayıtta kullanıcı, otomatik yemleyicide programı kuran kişi (komut günlüğü) ve vardiya sorumlusu. Kayıtlar değiştirilemez; düzeltme ayrı kayıttır. Belgeler (irsaliye, sertifika, reçete) ilgili kayda bağlı ve sürümlüdür (Bölüm 12).',
    'İz iki yönlüdür: alıcıdaki etiket lot numarasından sevkiyata, sevkiyattan partilere ve oranlarına, oradan şeritlere; bir yem lotundan ileriye besleme olaylarına, partilere, sevkiyatlara ve alıcılara. Geri çağırma bu listeyle yapılır.',
  ],
};
