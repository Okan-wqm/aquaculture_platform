/**
 * Platform architecture v4 — §05 Bakım.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section05: ArchitectureSection = {
  num: '05',
  title: 'Bakım',
  width: 1170,
  height: 420,
  intro:
    'Varlıkların planlı, veriye dayalı ve arıza bakımı; iş talebi, kalibrasyon, yedek parça ve maliyet. Kapanış varlığın yerini ve durumunu günceller.',
  boxes: [
    box('m0', 14, 60, 'Varlık', { ref: 'Bölüm 01', pills: ['bakım geçmişi burada'], kind: 'ext' }),
    box('m1', 244, 60, 'Bakım planı', { w: 180, sub: 'takvim · çalışma saati · duruma göre' }),
    box('m2', 484, 60, 'İş emri', {
      w: 190,
      sub: 'önleyici · arıza · kalibrasyon',
      pills: ['açık → planlandı → devam → tamam'],
    }),
    box('m3', 734, 60, 'Teknisyen', {
      ref: 'Bölüm 03 · 12',
      sub: 'iç ekip veya yüklenici · vardiyaya göre',
      kind: 'ext',
    }),
    box('m4', 964, 60, 'Kapanış', {
      w: 190,
      sub: 'süre · parça · maliyet · söküldü / takıldı → varlık geçmişi',
      kind: 'calc',
    }),
    box('x9', 14, 260, 'Veri', {
      ref: 'Bölüm 02',
      sub: 'çalışma saati, akım, titreşim',
      kind: 'ext',
    }),
    box('m5', 244, 260, 'Alarm', {
      w: 180,
      ref: 'Bölüm 07',
      sub: 'arıza, kalibrasyon geçmiş',
      kind: 'ext',
    }),
    box('it', 484, 260, 'İş talebi', {
      w: 190,
      sub: 'operatör bildirimi: yer veya varlık, açıklama, fotoğraf',
    }),
    box('m6', 734, 260, 'Yedek parça lotu', {
      ref: 'Bölüm 12',
      sub: 'depo ünitesinde · minimum stok',
      kind: 'ext',
    }),
    box('m7', 964, 260, 'Maliyet merkezi', { w: 190, ref: 'Bölüm 06', kind: 'ext' }),
  ],
  links: [
    link('m0', 'm1', '1 : n'),
    link('m1', 'm2', 'oluşturur'),
    link('m2', 'm3', 'atanır', { k: 'assign' }),
    link('m3', 'm4', 'tamamlar'),
    link('x9', 'm1', 'çalışma saati, durum', { k: 'data', fs: 't', ts: 'b', tf: 0.3, my: 208 }),
    link('m5', 'm2', 'açar', { fs: 't', ts: 'b', ff: 0.8, tf: 0.4, my: 232 }),
    link('m2', 'm5', 'bakım modu · devam ederken', {
      k: 'ctrl',
      fs: 'b',
      ts: 't',
      ff: 0.1,
      tf: 0.5,
      my: 192,
    }),
    link('it', 'm2', 'iş emrine', { fs: 't', ts: 'b', ff: 0.62, tf: 0.62 }),
    link('m6', 'm2', 'kullanılır', { fs: 't', ts: 'b', ff: 0.3, tf: 0.85, my: 228 }),
    link('m4', 'm7', 'gider', { fs: 'b', ts: 't' }),
    link('m4', 'm0', 'söküldü / takıldı · varlık durumu', {
      k: 'ctrl',
      fs: 't',
      ts: 't',
      ff: 0.5,
      tf: 0.5,
      my: 40,
    }),
  ],
  notes: [
    'Bakım planı takvime, çalışma saatine ya da duruma (akım, titreşim) göre iş emri açar. Varlığın çalışma saati, takılı olduğu pozisyonların durum tag’inin takılı dönemler içindeki toplamıdır (Bölüm 01 bağı × Bölüm 02 serisi).',
    'İş emrinin durumu vardır: açık → planlandı → devam ediyor → tamamlandı. Bakım modu yalnız “devam ediyor” süresince ve yalnız o ekipmanın kendi arıza ve durum alarmlarını bastırır; tanktaki oksijen gibi canlı güvenliği alarmları hiçbir zaman bastırılmaz. Arızadan açılan alarm iş emri kapanana kadar açık kalır.',
    'İş emri üç yoldan açılır: plan, alarm (arıza alarmı otomatik) ve iş talebi (operatör bildirimi, fotoğraflı). Talep değerlendirilir; iş emrine döner ya da gerekçeyle reddedilir.',
    'Bakım geçmişi yere değil varlığa yazılır. Kapanış değişen parçayı yazar: eski varlık söküldü (depoya ya da hurdaya), yenisi takıldı; Bölüm 01’deki varlık–pozisyon bağı ve varlık durumu buradan güncellenir. Sensör değişiminde kanal aynı kalır (Bölüm 02).',
    'Kalibrasyon bir iş emri türüdür: önce/sonra değer, referans çözelti lotu, sertifika (belge), yeni katsayı ve geçerlilik. Katsayı sürümlü olarak varlıkta saklanır ve edge’e iner; tamamlanınca o sensörün verisindeki “kalibrasyon geçmiş” işareti kalkar.',
    'Yedek parça da malzeme lotudur (Bölüm 12); kapanışta tüketilir, maliyeti iş emriyle maliyet merkezine gider. Yüklenici bakımı ve garanti bayrağı iş emrinde tutulur.',
  ],
  rules: [
    'Devam eden iş emri olan ekipmana komut gönderilemez (Bölüm 11); sökülen varlığa bekleyen komutlar düşer.',
    'Hesaplar: duruş süresi, arıza sıklığı (MTBF), varlık başına bakım maliyeti; varlık geçmişinden türetilir.',
  ],
};
