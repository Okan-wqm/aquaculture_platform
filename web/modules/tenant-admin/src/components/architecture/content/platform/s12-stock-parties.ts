/**
 * Platform architecture v4 — §12 Stok, taraf ve belge.
 *
 * Reference content ported verbatim from the design document "Platform
 * Mimarisi v4"; the body stays in Turkish, the document's own language.
 * Box coordinates are on the section's fixed canvas (width × height) and
 * diagramGeometry routes the links between box sides.
 */
import type { ArchitectureSection } from '../../types';

import { box, link } from './builders';

export const section12: ArchitectureSection = {
  num: '12',
  title: 'Stok, taraf ve belge',
  width: 1170,
  height: 460,
  intro:
    'Yem, ilaç, yavru, yedek parça, kimyasal, oksijen ve yakıt tek stok modelinde; tedarikçi, alıcı, yüklenici ve kurum tek taraf kaydında; her dosya bir belge.',
  boxes: [
    box('s1', 14, 60, 'Taraf', {
      w: 190,
      sub: 'tedarikçi, alıcı, kuluçkahane, yüklenici, laboratuvar, il müdürlüğü',
      kind: 'org',
    }),
    box('s2', 254, 60, 'Mal kabul', { w: 190, sub: 'irsaliye, tarih, kontrol eden kişi, miktar' }),
    box('s3', 494, 60, 'Malzeme lotu', {
      w: 190,
      sub: 'tür: yem, ilaç, yavru, yedek parça, kimyasal, oksijen, yakıt · SKT, analiz',
      kind: 'asset',
    }),
    box('s4', 734, 60, 'Depo hareketi', {
      w: 190,
      sub: 'depo ünitesinde · giriş, çıkış, transfer, sayım · FIFO, karışım',
    }),
    box('s5', 974, 60, 'Tüketim', {
      w: 180,
      sub: 'olayla partiye (04) · iş emriyle varlığa (05) · sanal sayaçla yere (06)',
      kind: 'calc',
    }),
    box('s7', 14, 260, 'Dış hesap', {
      w: 190,
      ref: 'Bölüm 03',
      sub: 'tarafa bağlı · süreli · dar kapsam',
      kind: 'ext',
    }),
    box('s8', 254, 260, 'Sevkiyat', {
      w: 190,
      ref: 'Bölüm 04',
      sub: 'alıcı = taraf · etiket lot no',
      kind: 'ext',
    }),
    box('s6', 494, 260, 'Belge', {
      w: 190,
      sub: 'tür, dosya, tarih, bağlı kayıt, sürüm · silinmez · süresi dolmadan uyarır',
    }),
    box('s9', 734, 260, 'Depo ünitesi', {
      w: 190,
      ref: 'Bölüm 01',
      sub: 'alan altında · yem deposu, ilaç dolabı, silo, yedek parça',
      kind: 'ext',
    }),
    box('s10', 974, 260, 'Stok sayımı', {
      w: 180,
      sub: 'sayılan − hesaplanan → düzeltme · karışım oranı ileriye düzeltilir',
      kind: 'calc',
    }),
  ],
  links: [
    link('s1', 's2', 'teslim'),
    link('s2', 's3', '1 : n'),
    link('s3', 's4', 'giriş'),
    link('s4', 's5', 'çıkış'),
    link('s1', 's7', 'dış hesap', { k: 'assign', fs: 'b', ts: 't' }),
    link('s8', 's1', 'alıcı', { fs: 't', ts: 'b', ff: 0.2, tf: 0.8, my: 208 }),
    link('s6', 's2', 'irsaliye · sertifika', { fs: 't', ts: 'b', ff: 0.5, tf: 0.5, my: 232 }),
    link('s9', 's4', 'yer', { fs: 't', ts: 'b' }),
    link('s10', 's4', 'düzeltme', { fs: 't', ts: 'b', ff: 0.5, tf: 0.9, my: 208 }),
  ],
  notes: [
    'Malzeme lotu girdinin kimliğidir: tedarikçi, irsaliye, üretim ve son kullanma tarihi, analiz sertifikası (belge). Yem, ilaç, yavru, yedek parça, kimyasal, oksijen ve yakıt aynı kayıttır; tür alanı ayırır.',
    'Depo hareketi lot bazında ve depo ünitesinde (Bölüm 01) tutulur: giriş, çıkış, transfer, sayım. Önce giren önce çıkar; siloda karışım oranı hesaplanır ve besleme olayı bu oranı alır (Bölüm 09). Sayım karışım oranını ileriye dönük düzeltir.',
    'Tüketim üç yoldan yazılır: olayla partiye (yem, ilaç, yavru — Bölüm 04), iş emriyle varlığa (yedek parça — Bölüm 05), sanal sayaçla yere (oksijen, yakıt, gaz — Bölüm 06). Aynı hareket iki yere yazılmaz.',
    'Taraf tektir: tedarikçi, alıcı, kuluçkahane, yüklenici, laboratuvar, il müdürlüğü, sertifika kuruluşu. Dış hesaplar (Bölüm 03) tarafa bağlanır; sevkiyat alıcısı (Bölüm 04), mal kabul tedarikçisi ve iş emri yüklenicisi (Bölüm 05) hep buradan seçilir.',
    'Belge bir dosyadır ve bir kayda bağlanır: irsaliye, analiz sertifikası, reçete, ruhsat, sevk belgesi, kalibrasyon sertifikası, fotoğraf. Sürümlü ve silinmez; süresi olan belge (ruhsat, sertifika, yetkinlik) dolmadan önce uyarır.',
  ],
  rules: [
    'Son kullanma tarihi geçmiş lot olayda seçilemez; geçersiz kılma yetkiye bağlı ve gerekçelidir.',
    'Minimum stok altı uyarı üretir; kritik girdide (oksijen, ilaç) alarm sınıfı güvenliktir (Bölüm 07).',
    'Şirketler arası devir: parti başka bir şirkete sevk edildiğinde köken ve sağlık geçmişi alıcının onayıyla kopyalanır; kaynak kayıt değişmez.',
  ],
};
