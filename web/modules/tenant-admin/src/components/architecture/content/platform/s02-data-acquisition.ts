/**
 * Platform architecture v4 — §02 Veri toplama: sahadan platforma.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';

/**
 * WHY: each field device's protocol line runs straight into the "Sürücüler"
 * column (y 70, height 472). This is the fraction of that column level with a
 * device box's centre (y0 + 40), as the design computed it.
 */
const levelWithDevice = (y0: number): number => (y0 + 40 - 70) / 472;

export const section02: ArchitectureSection = {
  num: '02',
  title: 'Veri toplama: sahadan platforma',
  width: 1170,
  height: 790,
  intro:
    'Sensör ve cihazlardan gelen sinyal edge cihazında hazırlanır, platformda bir tag’e dönüşür. Ters yönde ayar ve komut iner.',
  groups: [
    group(0, 30, 252, 560, 'Saha cihazları'),
    group(372, 30, 408, 560, 'Edge cihazı · pozisyona takılı varlık'),
    group(850, 30, 320, 750, 'Platform · bulut'),
  ],
  boxes: [
    box('f1', 12, 70, 'Analog sensör', {
      w: 228,
      h: 80,
      sub: 'DO, pH, seviye, basınç',
      kind: 'asset',
    }),
    box('f2', 12, 168, 'Dijital sonda', {
      w: 228,
      h: 80,
      sub: 'çok parametreli, RS-485',
      kind: 'asset',
    }),
    box('f3', 12, 266, 'PLC / kontrol paneli', {
      w: 228,
      h: 80,
      sub: 'pompa, blower, vana durumu',
      kind: 'asset',
    }),
    box('f4', 12, 364, 'Enerji analizörü', { w: 228, h: 80, sub: 'kW, kWh, akım', kind: 'asset' }),
    box('f5', 12, 462, 'Kablosuz sensör', {
      w: 228,
      h: 80,
      sub: 'kafes, uzak noktalar',
      kind: 'asset',
    }),
    box('e1', 390, 70, 'Sürücüler', {
      w: 130,
      h: 472,
      sub: 'her protokol için bir okuyucu ve yazıcı',
      kind: 'data',
    }),
    box('e2', 560, 70, 'Örnekleme ve zaman', {
      w: 200,
      h: 84,
      sub: 'ör. 10 sn · NTP saati · sapma ölçülür',
      kind: 'data',
    }),
    box('e3', 560, 196, 'Ölçekleme ve birim', {
      w: 200,
      h: 84,
      sub: '4–20 mA → mg/L · ham değer saklanır',
      kind: 'data',
    }),
    box('e4', 560, 322, 'İlk kalite kontrolü', {
      w: 200,
      h: 84,
      sub: 'iletişim, fiziksel aralık · iyi / şüpheli / kötü',
      kind: 'data',
    }),
    box('e5', 560, 448, 'Tampon ve yerel kural', {
      w: 200,
      h: 94,
      sub: 'bağlantı yoksa 7 gün saklar · kritik alarm ve yerel kural edge’de',
      kind: 'data',
    }),
    box('c8', 864, 70, 'Kalite kuralları', {
      w: 140,
      h: 100,
      sub: 'bayat, donmuş, kalibrasyon, sapma',
      kind: 'data',
    }),
    box('c5', 1018, 70, 'Zaman serisi', {
      w: 140,
      h: 100,
      sub: 'ham + mühendislik · kalite',
      kind: 'data',
    }),
    box('c11', 864, 190, 'Parametre sözlüğü', {
      w: 140,
      h: 100,
      sub: 'ad, birim, aralık, çözünürlük',
      kind: 'data',
    }),
    box('c4', 1018, 190, 'Tag', {
      w: 140,
      h: 100,
      sub: 'nokta + parametre · ölçülen / hesaplanan',
      ex: 'MP-1.DO',
      kind: 'data',
    }),
    box('c7', 864, 310, 'Ölçüm noktası', {
      w: 140,
      h: 100,
      ref: 'Bölüm 01',
      sub: 'ölçülen yer',
      kind: 'ext',
    }),
    box('c3', 1018, 310, 'Kanal bağlama', {
      w: 140,
      h: 100,
      sub: 'kanal → tag · tarihli',
      kind: 'data',
    }),
    box('c2', 864, 430, 'Alım servisi', {
      w: 140,
      h: 100,
      sub: 'doğrular, sıralar, geç veriyi işaretler',
      kind: 'data',
    }),
    box('c9', 1018, 430, 'Özet seri', {
      w: 140,
      h: 100,
      sub: 'saatlik, günlük özet · sınır dışı süre',
      kind: 'calc',
    }),
    box('c1', 864, 550, 'Cihaz kaydı', {
      w: 140,
      h: 100,
      sub: 'kimlik, sertifika, saha, sürüm',
      kind: 'org',
    }),
    box('c6', 1018, 550, 'Numune ve lab', {
      w: 140,
      h: 100,
      sub: 'yer veya parti · alım ve sonuç zamanı',
      kind: 'data',
    }),
    box('c12', 864, 670, 'Komut kuyruğu', {
      w: 140,
      h: 100,
      ref: 'Bölüm 11',
      sub: 'ayar, katsayı, komut',
      kind: 'ext',
    }),
    box('c13', 1018, 670, 'Saklama', {
      w: 140,
      h: 100,
      sub: 'ham 2 yıl · özet süresiz · arşiv',
      kind: 'data',
    }),
  ],
  links: [
    link('f1', 'e1', '4–20 mA · 0–10 V', { k: 'data', tf: levelWithDevice(70) }),
    link('f2', 'e1', 'Modbus RTU · SDI-12', { k: 'data', tf: levelWithDevice(168) }),
    link('f3', 'e1', 'Modbus TCP · OPC UA', { k: 'data', tf: levelWithDevice(266) }),
    link('f4', 'e1', 'Modbus RTU / TCP', { k: 'data', tf: levelWithDevice(364) }),
    link('f5', 'e1', 'LoRaWAN', { k: 'data', tf: levelWithDevice(462) }),
    link('e1', 'e2', '', { k: 'data', ff: 42 / 472 }),
    link('e2', 'e3', '', { k: 'data', fs: 'b', ts: 't' }),
    link('e3', 'e4', '', { k: 'data', fs: 'b', ts: 't' }),
    link('e4', 'e5', '', { k: 'data', fs: 'b', ts: 't' }),
    link('e5', 'c2', 'MQTT · TLS', { k: 'data', ff: 0.447, tf: 0.6 }),
    link('c12', 'e5', 'ayar · katsayı · komut', { k: 'ctrl', fs: 'l', ts: 'r', ff: 0.5, tf: 0.8 }),
    link('c1', 'c2', 'doğrular', { fs: 't', ts: 'b', at: [934, 540] }),
    link('c6', 'c2', 'su numunesi', {
      k: 'data',
      fs: 'l',
      ts: 'r',
      ff: 0.5,
      tf: 0.5,
      at: [1011, 540],
    }),
    link('c2', 'c3', '', { k: 'data', ff: 0.3, tf: 0.7 }),
    link('c3', 'c4', 'tarihli', { k: 'data', fs: 't', ts: 'b', at: [1088, 300] }),
    link('c7', 'c4', 'tanımlar', { k: 'data', at: [1011, 300] }),
    link('c11', 'c4', '', { k: 'data' }),
    link('c4', 'c5', 'yazar', { k: 'data', fs: 't', ts: 'b', at: [1088, 180] }),
    link('c8', 'c5', '', { k: 'data' }),
    link('c5', 'c9', '', { k: 'data', fs: 'r', ts: 'r', mx: 1164 }),
  ],
  notes: [
    'Edge cihazı okur, zaman damgası vurur, birime çevirir, iletişim ve fiziksel aralığı kontrol eder, bağlantı koparsa 7 gün saklar. Bağlantı 4G, fiber ya da uydu olabilir. Platform edge saatinin sapmasını ölçer ve işaretler.',
    'Kanal doğrudan tag’e bağlanır (ölçüm noktası + parametre), tarihli olarak; cihazın takılı olduğu yere değil. Panodaki enerji analizörü P-101’in tüketimini ölçüyorsa veri P-101’in tag’ine yazılır. Sensör değişince kanal aynı kalır, bağ değişmez.',
    'Parametre sözlüğü birim, fiziksel aralık ve çözünürlüğü tek yerde tutar; edge’deki aralık kontrolü buradan iner. Zaman serisi ham ve mühendislik değerini birlikte saklar; kalibrasyon katsayısının sürümü (Bölüm 05) değerle yazılır, geri hesap her zaman mümkündür.',
    'Kalite iki aşamalıdır. Edge iletişimi ve fiziksel aralığı kontrol eder; platform bayat, donmuş, kalibrasyonu geçmiş, manuel numuneyle ve yedek sensörle sapan değerleri işaretler. Geç gelen veri “geç” işaretiyle yazılır: kuralları canlı değil geçmiş modunda değerlendirir, alarm açmaz (Bölüm 07), kapanmış günü yeniden üretir (Bölüm 13).',
    'Bir tag’in birden fazla kaynağı olabilir: birincil sensör, yedek sensör, manuel giriş. Öncelik bu sıradadır; geçerli olan (kalite iyi ve bayat değil) kullanılır, diğerleri karşılaştırma için saklanır.',
    'Numune ve lab sonucu iki zaman taşır: alım ve sonuç. Su parametreleri tag’e yazılır; sağlık sonuçları (histopatoloji, kalıntı) partiye olay olarak yazılır (Bölüm 04). Laboratuvar bir taraftır (Bölüm 12).',
    'Ters yönde ayar, katsayı ve komut Bölüm 11’deki komut kuyruğundan iner; edge uygular ve sonucu tag olarak geri yazar. Ölçekleme böylece tek yerde, edge’de yapılır.',
  ],
  rules: [
    'Hesaplanan tag bir tag’dir: formül, girdi tag’leri ve sürüm taşır (kWh, çalışma saati, yoğunluk). Sürüm değişince eski değerler yeniden hesaplanmaz; yeni sürüm yeni dönemden başlar (Bölüm 13).',
    'Aynı tag’e aynı zaman damgasıyla ikinci değer gelirse üzerine yazılmaz, yeni sürüm olarak eklenir.',
    'Saklama: ham seri 2 yıl, özet seri süresiz; silme değil arşivleme.',
  ],
};
