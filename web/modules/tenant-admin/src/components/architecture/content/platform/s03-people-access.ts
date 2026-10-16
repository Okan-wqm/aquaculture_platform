/**
 * Platform architecture v4 — §03 Kişiler ve erişim.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, group, link } from './builders';

export const section03: ArchitectureSection = {
  num: '03',
  title: 'Kişiler ve erişim',
  width: 1170,
  height: 580,
  intro:
    'Çalışan kaydı, giriş hesabı, rol ve sorumluluk birbirinden ayrı dört kavramdır; sorumluluğun türü, nöbet ve dış hesaplar bunları tamamlar.',
  groups: [group(0, 30, 800, 150, 'Organizasyon ağacı')],
  boxes: [
    box('o1', 14, 66, 'Şirket', { ex: 'Tenant', kind: 'org' }),
    box('o2', 214, 66, 'Saha organizasyonu', { ex: 'Ayvalık ekibi', kind: 'org' }),
    box('o3', 414, 66, 'Departman', {
      sub: 'saha veya şirket',
      ex: 'A-BES · Besleme',
      kind: 'org',
    }),
    box('o4', 614, 66, 'Ekip', { ex: 'Gündüz vardiyası', kind: 'org' }),
    box('x3', 800, 66, 'Taraf', {
      w: 150,
      ref: 'Bölüm 12',
      sub: 'veteriner, yüklenici, denetçi',
      kind: 'ext',
    }),
    box('x2', 970, 66, 'Yer ağacı', {
      w: 190,
      ref: 'Bölüm 01',
      sub: 'işlettiği alan ve sistemler',
      kind: 'ext',
    }),
    box('p0', 14, 240, 'Vardiya, izin, nöbet', {
      h: 104,
      sub: 'plan, puantaj, izin onayı · nöbet: yer × dönem × kişi',
      kind: 'org',
    }),
    box('eg', 214, 240, 'Eğitim ve yetkinlik', {
      h: 104,
      sub: 'konu, geçerlilik, belge · olay girişinde şart',
      kind: 'org',
    }),
    box('p1', 414, 240, 'Çalışan kaydı', {
      h: 104,
      sub: 'İK kaydı · maaş yalnız İK',
      pills: ['tek üyelik'],
      kind: 'org',
    }),
    box('p2', 700, 240, 'Kullanıcı hesabı', {
      w: 190,
      h: 104,
      sub: 'davet, SSO, iki adımlı doğrulama · dış hesap tarafa bağlı, süreli',
      pills: ['çalışan 0..1'],
      kind: 'org',
    }),
    box('r1', 970, 240, 'Rol tanımı', {
      w: 190,
      h: 104,
      sub: 'modül bazlı yetki matrisi',
      pills: ['görüntüle · oluştur · onayla · komut'],
      kind: 'org',
    }),
    box('r2', 700, 410, 'Rol ataması', {
      w: 190,
      h: 104,
      sub: 'kullanıcı × modül × rol',
      pills: ['kapsam: yer düğümü · dept · kendi'],
      kind: 'org',
    }),
    box('r3', 414, 410, 'Sorumluluk ataması', {
      w: 200,
      h: 104,
      sub: 'yer × tür → kişi + vekil',
      pills: ['tarihli'],
      kind: 'assign',
    }),
    box('st', 214, 410, 'Sorumluluk türü', {
      h: 104,
      sub: 'işletme, bakım, balık sağlığı, çevre, kalite, teknik müdür',
      kind: 'org',
    }),
    box('x1', 14, 410, 'Yer ağacı', {
      h: 104,
      sub: 'saha, alan, sistem, pozisyon',
      ref: 'Bölüm 01',
      kind: 'ext',
    }),
  ],
  links: [
    link('o1', 'o2', '1 : n'),
    link('o2', 'o3', '1 : n'),
    link('o3', 'o4', '1 : n'),
    link('o1', 'o3', 'veya doğrudan · şirket geneli', { fs: 't', ts: 't', my: 46 }),
    link('p1', 'o4', 'üye · tarihli', { fs: 't', ts: 'b', ff: 0.88, tf: 0.4, my: 208 }),
    link('p0', 'p1', 'müsaitlik · nöbet', {
      k: 'assign',
      fs: 't',
      ts: 't',
      ff: 0.5,
      tf: 0.2,
      my: 208,
    }),
    link('eg', 'p1', '', { k: 'assign' }),
    link('p1', 'p2', '0..1 hesap'),
    link('x3', 'p2', 'dış hesap', { k: 'assign', fs: 'b', ts: 't', ff: 0.5, tf: 0.5 }),
    link('p2', 'r2', 'erişim', { fs: 'b', ts: 't' }),
    link('r1', 'r2', 'rol seçilir', { fs: 'b', ts: 'r' }),
    link('p1', 'r3', 'sorumlu olur', { fs: 'b', ts: 't', tf: 0.425, k: 'assign' }),
    link('st', 'r3', '', { k: 'assign' }),
    link('r3', 'x1', 'yere', { fs: 'b', ts: 'b', ff: 0.5, tf: 0.5, my: 540, k: 'assign' }),
    link('r3', 'r2', 'yetki şartı', { k: 'assign' }),
    link('o3', 'x2', 'işletir · tarihli', {
      k: 'assign',
      fs: 't',
      ts: 't',
      ff: 0.8,
      tf: 0.5,
      my: 40,
    }),
  ],
  notes: [
    'Çalışan bir İK kaydıdır, giriş hesabı ayrıdır. Hesabı olmayan çalışan da puantaja, vardiyaya ve göreve girer. Çalışanı olmayan hesap da vardır: dış veteriner, denetçi, yüklenici teknisyen; bir tarafa bağlanır (Bölüm 12), süreli ve dar kapsamlıdır.',
    'Çalışan tek bir birime üye olur: ekibe, ekip yoksa departmana; departman ekipten türetilir. Başka departmana yardıma gitmek tarihli geçici görevlendirme olarak girer; vardiya ve sorumluluk onu da görür.',
    'Departman bir sahaya ya da doğrudan şirkete bağlanır ve işlettiği yerlere tarihli olarak atanır. “Kapsam: departman” yetkisi ve eskalasyondaki departman sorumlusu bu bağdan bulunur.',
    'Erişim = rol × kapsam; kapsam yer ağacının herhangi bir düğümü, departman ya da kişinin kendi kayıtları olabilir. Sorumlu atanan kişinin o düğümde görüntüleme ve alarm onaylama yetkisi yoksa eksik yetki atama sırasında önerilir; onaysız atama yapılamaz.',
    'Sorumluluğun türü vardır: işletme, bakım, balık sağlığı, çevre, kalite, teknik sorumlu müdür. Alarm sınıfı hangi türe gideceğini seçer (Bölüm 07); resmi rapor şablonu onaylayan türü seçer (Bölüm 08). Aynı yerde her türden bir sorumlu ve vekil olabilir.',
    'Vardiya ve izin kimin müsait olduğunu söyler; vardiya dışı saatlerde nöbet listesi geçerlidir. Yönlendirme sırası: sorumlu → vekil → nöbetçi → üst seviye. Maaş ve bordro yalnız İK rolüne açıktır.',
    'Eğitim ve yetkinlik kaydı: tedavi, kimyasal uygulama, elektrik işi gibi olaylar yetkinlik şartı taşır; süresi dolmuş yetkinlikle olay girilemez. Sertifika denetim dosyası (Bölüm 08) buradan beslenir.',
  ],
  rules: [
    'Görev ayrılığı: raporu hazırlayan onaylayamaz; iş emrini yapan kapanışı tek başına doğrulayamaz; kritik komutu isteyen onaylayamaz (Bölüm 11).',
    'Rol, kapsam, sorumluluk ve nöbet değişiklikleri denetim izine yazılır (Bölüm 13).',
  ],
};
