/**
 * Platform architecture v4 — §11 Kontrol: platformdan sahaya.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section11: ArchitectureSection = {
  num: '11',
  title: 'Kontrol: platformdan sahaya',
  width: 1170,
  height: 420,
  intro:
    'Setpoint, aç/kapa, yemleyici programı, yerel kural: sahaya giden her şey bir komut kaydıdır. Yetki, kilit, iletim, yanıt ve günlük.',
  boxes: [
    box('k1', 14, 60, 'Komut', {
      w: 190,
      sub: 'setpoint · aç/kapa · yemleyici programı · örnekleme süresi · katsayı',
      ex: 'P-101 setpoint 7,0',
    }),
    box('k2', 254, 60, 'Yetki ve onay', {
      w: 190,
      ref: 'Bölüm 03',
      sub: 'rol × kapsam · kritik komutta iki adım, farklı kişi',
      kind: 'ext',
    }),
    box('k3', 494, 60, 'Kilitler', {
      w: 190,
      sub: 'bakımdaki ekipman · canlı güvenliği eşiği · edge çevrimdışı',
      kind: 'calc',
    }),
    box('k4', 734, 60, 'Komut kuyruğu', {
      w: 190,
      sub: 'edge’e iletim · zaman aşımı · tekrar',
      kind: 'data',
    }),
    box('k5', 974, 60, 'Edge uygulama', {
      w: 180,
      ref: 'Bölüm 02',
      sub: 'sürücü yazar · cihaz yanıtı: kabul, hata, zaman aşımı',
      kind: 'ext',
    }),
    box('k6', 14, 260, 'Komut günlüğü', {
      w: 190,
      sub: 'kim, ne, ne zaman, sonuç · değiştirilemez · izlenebilirlik şeridi',
      kind: 'org',
    }),
    box('k9', 254, 260, 'Yerel otomatik kural', {
      w: 190,
      sub: 'edge’de, bağlantı yokken de: DO < 5 → yedek blower aç',
      kind: 'data',
    }),
    box('k10', 494, 260, 'İş emri', {
      w: 190,
      ref: 'Bölüm 05',
      sub: 'devam ediyor → komut yok',
      kind: 'ext',
    }),
    box('k8', 734, 260, 'Alarm', {
      w: 190,
      ref: 'Bölüm 07',
      sub: 'iletilemedi · reddedildi · sınıf: komut',
      kind: 'ext',
    }),
    box('k7', 974, 260, 'Sonuç tag’i', {
      w: 180,
      ref: 'Bölüm 02',
      sub: 'etkin setpoint · komut durumu · zaman serisinde',
      kind: 'ext',
    }),
  ],
  links: [
    link('k1', 'k2', 'ister'),
    link('k2', 'k3', 'onaylı'),
    link('k3', 'k4', 'geçer'),
    link('k4', 'k5', 'MQTT', { k: 'data' }),
    link('k5', 'k4', 'yanıt', { k: 'ctrl', fs: 'l', ts: 'r', ff: 0.8, tf: 0.8 }),
    link('k1', 'k6', 'günlüğe', { fs: 'b', ts: 't' }),
    link('k9', 'k1', 'program olarak iner', {
      k: 'ctrl',
      fs: 't',
      ts: 'b',
      ff: 0.5,
      tf: 0.8,
      my: 208,
    }),
    link('k10', 'k3', 'kilit', { k: 'ctrl', fs: 't', ts: 'b' }),
    link('k4', 'k8', 'zaman aşımı', { fs: 'b', ts: 't' }),
    link('k5', 'k7', 'sonucu yazar', { k: 'data', fs: 'b', ts: 't' }),
  ],
  notes: [
    'Platformdan sahaya giden her şey komuttur: setpoint, aç/kapa, yemleyici programı, örnekleme süresi, kalibrasyon katsayısı, yerel otomatik kural, siren ve röle çıkışı. Komut bir kayıttır ve silinmez.',
    'Yetki rol × kapsamdan gelir (Bölüm 03). Kritik komutlar (sistem durdurma, canlı güvenliği eşiğine yakın setpoint) iki adımlı onay ister: isteyen ve onaylayan farklı kişidir.',
    'Kilitler komutu gönderilmeden reddeder: devam eden iş emri olan ekipmana komut yok (Bölüm 05); canlı güvenliği eşiğini aşan setpoint yok; edge çevrimdışıysa kuyrukta bekler, süresi dolunca düşer. Her ret günlüğe ve alarma yazılır.',
    'Edge komutu uygular; cihazın yanıtını ve etkin değeri tag olarak geri yazar (Bölüm 02). Böylece “o gün setpoint neydi” sorusu bir veri sorgusudur.',
    'Yerel otomatik kural edge’de çalışır ve bağlantı yokken de devreye girer; platformdan program olarak iner, aynı onay ve günlükten geçer.',
    'Komut günlüğü izlenebilirlik şerididir (Bölüm 09): otomatik yemleyicide “programı kuran kişi” buradan bulunur.',
  ],
  rules: [
    'Komut pozisyona gider; pozisyon o anda hangi varlığı taşıyorsa ona uygulanır (Bölüm 01). Bakım kapanışıyla sökülen varlığa bekleyen komutlar düşer.',
    'Kritik komutu isteyen kişi onaylayamaz (Bölüm 03).',
  ],
};
