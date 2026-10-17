/**
 * Platform architecture v4 — §13 Zaman, dönem ve denetim izi.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section13: ArchitectureSection = {
  num: '13',
  title: 'Zaman, dönem ve denetim izi',
  width: 1170,
  height: 420,
  intro:
    'Diğer bölümlerin dayandığı zaman modeli: her kayıtta iki zaman, tarihli bağ kuralları, tek dönem takvimi, düzeltme, denetim izi ve hesap sürümü.',
  boxes: [
    box('z1', 14, 60, 'Kayıt', {
      w: 210,
      sub: 'her kayıt iki zaman taşır · bağ da kayıttır',
      pills: ['olay zamanı', 'kayıt zamanı'],
      kind: 'hub',
    }),
    box('z2', 274, 60, 'Tarihli bağ', {
      w: 210,
      sub: 'başlangıç · bitiş · her an tek ebeveyn · kapsama',
      pills: ['tarihli'],
      kind: 'assign',
    }),
    box('z3', 534, 60, 'Dönem takvimi', {
      w: 210,
      sub: 'gün kapanışı T+2 · dönem kilidi dönem sonu + 5 · operasyon, finans, resmi tek takvim',
      kind: 'calc',
    }),
    box('z4', 794, 60, 'Düzeltme kaydı', {
      w: 190,
      sub: 'eskiyi silmez · kim, neden, hangi kayıt',
    }),
    box('z5', 1004, 60, 'Denetim izi', {
      w: 160,
      sub: 'ayar değişikliği: kim, ne zaman, eski → yeni',
      kind: 'org',
    }),
    box('z7', 14, 260, 'Geç veri', {
      w: 210,
      ref: 'Bölüm 02',
      sub: 'olay zamanı eski, kayıt zamanı yeni · alarm açmaz',
      kind: 'ext',
    }),
    box('z6', 274, 260, 'Hesap sürümü', {
      w: 210,
      sub: 'FCR, biyokütle, dağıtım anahtarı, kalite kuralı · formül sürümlü',
      kind: 'calc',
    }),
    box('z8', 534, 260, 'Rapor sürümü', {
      w: 210,
      ref: 'Bölüm 08',
      sub: 'kilitli dönem ilgili döneme yeni sürüm',
      kind: 'ext',
    }),
    box('z9', 794, 260, 'Finans', {
      w: 190,
      ref: 'Bölüm 06',
      sub: 'cari döneme “önceki dönem düzeltmesi”',
      kind: 'ext',
    }),
    box('z10', 1004, 260, 'Ayarlar', {
      w: 160,
      ref: 'Bölüm 02–07',
      sub: 'eşik, kanal, rol, tarife, şablon, oran',
      kind: 'ext',
    }),
  ],
  links: [
    link('z1', 'z2', ''),
    link('z2', 'z3', 'dönem'),
    link('z3', 'z4', 'kilit'),
    link('z4', 'z5', ''),
    link('z7', 'z1', 'iki zamanla', { k: 'data', fs: 't', ts: 'b' }),
    link('z6', 'z8', 'sürüm'),
    link('z4', 'z8', 'ilgili döneme yeni sürüm', { fs: 'b', ts: 't', ff: 0.3, tf: 0.5, my: 208 }),
    link('z4', 'z9', 'cari döneme', { fs: 'b', ts: 't', ff: 0.7, tf: 0.7 }),
    link('z10', 'z5', 'her değişiklik', { k: 'ctrl', fs: 't', ts: 'b' }),
  ],
  notes: [
    'Her kayıt iki zaman taşır: olayın olduğu zaman ve sisteme yazıldığı zaman. “Eski rapor eski yapıyla kalır”, “geç gelen veri”, “dönem kilidi” ve “düzeltme ayrı kayıt” bu ayrımla çelişmeden yan yana durur.',
    'Tarihli bağ kuralları her bağ için aynıdır (yer ağacı, üyelik, yerleşim, varlık–pozisyon, kanal–tag, hizmet oranı, sorumluluk): her an tek ebeveyn; çocuk dönemi ebeveyn dönemi içinde; açık bağımlılığı olan şey kapatılamaz; geçmişe dönük bağ değişikliği düzeltme kaydıdır.',
    'Tek dönem takvimi: gün kapanışı T+2, dönem kilidi dönem sonu + 5 gün. Kilit operasyonu, finansı ve resmi raporu birlikte kapatır; kilitli döneme kayıt zamanı düşen her şey düzeltme kaydıdır.',
    'Düzeltme eskiyi silmez; kim, neden, hangi kaydı. Operasyonel ve resmi rapor ilgili döneme yeni sürüm olarak yeniden üretilir; finansal etki cari döneme “önceki dönem düzeltmesi” satırıyla işler. İkisi birbirine referans verir.',
    'Denetim izi ayarlar içindir: eşik, kural, raf, kanal bağlama, rol ve kapsam, nöbet, tarife, şablon, hizmet oranı. Kim, ne zaman, eski ve yeni değer. Olaylar zaten değiştirilemez.',
    'Hesap tanımları sürümlüdür (FCR, biyokütle tahmini, dağıtım anahtarı, kalite kuralı); rapor hangi sürümle üretildiğini yazar; eski dönem eski sürümle yeniden üretilebilir.',
  ],
  rules: [
    'Çevrimdışı mobil form: kayıt cihazda kuyruklanır; olay zamanı cihazdan, kayıt zamanı sunucudan gelir; çakışma düzeltme kaydı olarak çözülür.',
    'Aynı kayda aynı olay zamanıyla ikinci yazım üzerine yazmaz, sürüm ekler.',
  ],
};
