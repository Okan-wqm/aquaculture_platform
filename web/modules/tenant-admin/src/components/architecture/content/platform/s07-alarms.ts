/**
 * Platform architecture v4 — §07 Alarm ve bildirim.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section07: ArchitectureSection = {
  num: '07',
  title: 'Alarm ve bildirim',
  width: 1170,
  height: 400,
  intro:
    'Bir değerin eşiği aşmasından doğru kişiye ulaşmasına kadar. Alarmın sınıfı kime gideceğini, partinin evresi eşiği belirler.',
  boxes: [
    box('a1', 14, 60, 'Tag', { ref: 'Bölüm 02', ex: 'MP-1.DO', kind: 'ext' }),
    box('a2', 234, 60, 'Kural', {
      w: 190,
      sub: 'sınıf · eşik + süre + ölü bant · bileşik koşul · öncelik',
      ex: 'DO < 6,5 · 5 dk · P1',
    }),
    box('a3', 474, 60, 'Alarm', { sub: 'aktif / normale döndü × onaysız / onaylı · raf' }),
    box('a4', 694, 60, 'Yönlendirme', {
      w: 190,
      sub: 'sınıf → sorumluluk türü · sorumlu → vekil → nöbetçi → üst',
      kind: 'assign',
    }),
    box('a5', 944, 60, 'Bildirim', { w: 200, sub: 'uygulama · SMS · arama · teslim onayı' }),
    box('a10', 14, 270, 'Parti, tür, evre', {
      ref: 'Bölüm 01 · 04',
      sub: 'o tarihte o ünitede · en sıkı eşik · izin limiti',
      kind: 'ext',
    }),
    box('a9', 234, 270, 'İş emri', {
      w: 190,
      ref: 'Bölüm 05',
      sub: 'arıza ise otomatik · devam ederken bakım modu',
      kind: 'ext',
    }),
    box('a8', 474, 270, 'Eskalasyon', { sub: 'önceliğe göre · onaylanmadı · çözülmedi' }),
    box('a6', 694, 270, 'Sorumluluk ataması', {
      w: 190,
      ref: 'Bölüm 03',
      sub: 'yer × tür → kişi + vekil',
      kind: 'ext',
    }),
    box('a7', 944, 270, 'Vardiya, izin, nöbet', { w: 200, ref: 'Bölüm 03', kind: 'ext' }),
  ],
  links: [
    link('a1', 'a2', 'izlenir', { k: 'data' }),
    link('a2', 'a3', 'tetikler'),
    link('a3', 'a4', ''),
    link('a4', 'a5', ''),
    link('a10', 'a2', 'eşik', { fs: 't', ts: 'b', tf: 0.1, my: 228 }),
    link('a6', 'a4', 'kime', { fs: 't', ts: 'b', k: 'assign' }),
    link('a7', 'a6', 'müsait mi', { fs: 'l', ts: 'r', k: 'assign' }),
    link('a3', 'a8', 'onay yoksa', { fs: 'b', ts: 't' }),
    link('a8', 'a6', 'üst', { fs: 'r', ts: 'l', k: 'assign' }),
    link('a3', 'a9', 'arıza ise', { fs: 'b', ts: 't', ff: 0.05, tf: 0.2, my: 213 }),
    link('a9', 'a3', 'bakım modu', { k: 'ctrl', fs: 't', ts: 'b', ff: 0.9, tf: 0.15, my: 244 }),
  ],
  notes: [
    'Alarm bir tag’e, dolayısıyla bir yere bağlıdır ve bir sınıfı vardır: proses, ekipman, veri kalitesi, iletişim, güvenlik. Sınıf hangi sorumluluk türüne gideceğini seçer (Bölüm 03): proses → işletme, ekipman ve iletişim → bakım, güvenlik → saha. Yerin o türde sorumlusu yoksa ağaçta yukarıdaki en yakın sorumluya gider.',
    'Eşik sabit değildir: kural eşiği o tarihte o ünitedeki partinin tür ve evresinden alır; ünitede ya da ortak suda birden fazla parti varsa en sıkı eşik geçerlidir. Deşarj tag’lerinin eşiği izin limitidir (Bölüm 01). Kural ölü bant ve bileşik koşul (DO düşük VE blower durdu) taşıyabilir.',
    'Alarm durumu iki eksendir: aktif / normale döndü × onaysız / onaylı. Kapanış = normale döndü ve onaylı, ya da gerekçeli elle kapatma. Raf: operatör gerekçe ve süreyle bastırır, süre bitince kalkar; kim, ne kadar, neden kaydedilir.',
    'Bakım modu yalnız devam eden iş emrindeki ekipmanın kendi arıza ve durum alarmlarını bastırır (Bölüm 05); canlı güvenliği alarmları asla. Arıza alarmı otomatik iş emri açar ve iş emri kapanana kadar açık kalır.',
    'Eskalasyon süreleri önceliğe göredir; iki zamanlayıcı vardır: onaylanmadı (ör. 15 dk departman, 30 dk saha) ve çözülmedi (onaylı ama normale dönmedi). Sorumlu izinliyse vekil, vardiya dışıysa nöbetçi, o da yoksa üst seviye çağrılır; teslim onayı gelmeyen bildirim sıradakine geçer.',
    'Geç gelen veri (Bölüm 02) alarm açmaz, “geçmiş” olarak işaretlenir. Edge çevrimdışıyken ürettiği yerel alarm kimlik taşır; bağlantı gelince platform aynı kimlikle birleştirir, ikinci alarm açılmaz. Alarm geçmişi yerleşim dönemiyle partiye bağlanır (Bölüm 09) ve rapora sayı ve yanıt süresi olarak gider (Bölüm 08).',
  ],
  rules: [
    'Eşik, kural ve raf değişiklikleri denetim izine yazılır (Bölüm 13).',
    'İletilemeyen ya da reddedilen komut yeni bir alarm sınıfıdır (Bölüm 11). Kritik stok altı (oksijen, ilaç) güvenlik sınıfında alarm üretir (Bölüm 12).',
  ],
};
