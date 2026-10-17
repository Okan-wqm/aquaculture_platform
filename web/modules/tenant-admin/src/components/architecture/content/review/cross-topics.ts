/**
 * Architecture review — K: cross-cutting topics, each [id, title, text, affects].
 * Ported verbatim from the design document "Mimari İnceleme".
 */
import type { CrossTopicRow } from '../../types';

export const CROSS_TOPICS: readonly CrossTopicRow[] = [
  [
    'K1',
    'İki zaman: olay zamanı ve kayıt zamanı',
    '“Eski raporlar eski yapıyla kalır”, “geç gelen veri”, “dönem kilidi”, “düzeltme ayrı kayıt” — hepsi her kaydın iki zaman taşımasına dayanır: olayın olduğu zaman ve sisteme girildiği zaman. Hiçbir bölüm bunu yazmıyor; yazılmazsa dört ilke birbiriyle çelişir.',
    '02.3 · 08.1 · 08.2 · 09.5 · 11.3',
  ],
  [
    'K2',
    'Tarihli bağın bütünlük kuralları',
    'Her an tek ebeveyn, çocuk dönemi ebeveyn dönemi içinde, açık bağımlılığı olan şey kapatılamaz, geçmişe dönük bağ değişikliği düzeltme kaydıdır. Yer ağacı, üyelik, yerleşim, varlık–pozisyon, kanal–tag için aynı kural seti.',
    '01.6 · 03 · 04 · 05.3',
  ],
  [
    'K3',
    'Denetim izi',
    'Olaylar değiştirilemez deniyor; ama eşik, kanal bağlama, rol, tarife, şablon gibi ayarlar da değişir. Kim, ne zaman, eski ve yeni değer. Denetimde ilk istenen şey budur.',
    '02 · 03 · 06 · 07 · 08',
  ],
  [
    'K4',
    'Tek stok modeli',
    'Malzeme lotu + depo hareketi: yem, ilaç, yavru, yedek parça, kimyasal, oksijen, yakıt. Mal kabul, SKT, FIFO, karışım, sayım bir kez tanımlanır. Ölçülmeyen kaynak tüketimi (tüp, tanker) buradan 06’ya gider.',
    '05.6 · 06.2 · 09.2',
  ],
  [
    'K5',
    'Taraf',
    'Tedarikçi, alıcı, kuluçkahane, yüklenici, laboratuvar, il müdürlüğü, sertifika kuruluşu ayrı ayrı anılıyor. Tek “Taraf” kaydı; dış hesaplar (03.3), sevkiyat (04.2), mal kabul (09) buna bağlanır.',
    '03.3 · 04.2 · 05.7 · 08 · 09',
  ],
  [
    'K6',
    'Belge',
    'İrsaliye, sertifika, reçete, ruhsat, sevk belgesi, fotoğraf: hepsi dosyadır ve bir kayda bağlanır. Sürümlü, silinmez.',
    '01.5 · 05.5 · 08 · 09.4',
  ],
  [
    'K7',
    'Tek dönem takvimi',
    'Operasyon (stok mutabakatı), finans (maliyet merkezi) ve resmi rapor aynı dönemi kullanmalı; kilit tek yerden atılır ve üçünü birden kapatır. Aksi hâlde tank raporu ile beyan farklı rakam verir — tam da 08’in önlemek istediği şey.',
    '06 · 08.1 · 08.2',
  ],
  [
    'K8',
    'Hesap tanımlarının sürümü',
    'FCR, biyokütle tahmini, dağıtım anahtarı, kalite kuralları formüldür ve değişir. Eski raporun yeniden üretilebilmesi için formül sürümü rapora yazılır.',
    '02.2 · 04.3 · 06 · 08',
  ],
  [
    'K9',
    'Çevrimdışı mobil',
    'Edge için tampon var; kafes teknesindeki mobil form için yok. Kuyruk, çakışma, zaman damgası (K1) ve hangi kullanıcıyla gönderildiği.',
    '02.5 · 04 · 09',
  ],
  [
    'K10',
    'Şirketler arası devir',
    'Kuluçkahane bir şirket, büyütme sahası başka şirket olabilir; ikisi de platformdaysa parti kökeni ve sağlık geçmişi devredilir mi, nasıl? Karar verilmeli.',
    '04 · 09 · K5',
  ],
];
