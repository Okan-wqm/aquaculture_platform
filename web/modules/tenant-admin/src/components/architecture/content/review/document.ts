/**
 * Architecture review — the document's own header and the headings of its
 * closing parts, verbatim from the design document "Mimari İnceleme"
 * (Turkish). `mark` is the letter the review numbers the part with; `toc` is
 * the shorter title its table of contents uses.
 */
export const REVIEW_DOCUMENT = {
  kicker: 'Suderra · platform mimarisi v3 · inceleme',
  headline: 'Uçtan uca mantık incelemesi',
  intro:
    'On bir bölüm tek tek ve birbirine karşı okundu. Her bulgu bir çelişki, bir boşluk, yazılmamış bir kural ya da hesaba katılmamış bir uç durumdur; yanında öneri var. Sonda kesişen konular, önerilen yeni bölümler ve yirmi senaryoyla sağlama.',
  priorities: {
    title: 'Önce bunlar',
    intro: 'Birden fazla bölümü etkileyen ya da yanlış sonuç üreten sekiz madde.',
  },
  cross: {
    mark: 'K',
    title: 'Kesişen konular',
    toc: 'Kesişen konular',
    intro:
      'Tek bir bölüme ait olmayan, birçok bulgunun kökündeki ilkeler. Bunlar yazılınca yukarıdaki maddelerin yarısı kendiliğinden kapanır.',
  },
  proposals: {
    mark: 'Ö',
    title: 'Önerilen yeni bölümler ve eklenecek akışlar',
    toc: 'Yeni bölümler ve akışlar',
    intro:
      'Mevcut on bölümün yanına üç bölüm (11 Kontrol, 12 Stok, 13 Zaman; Hepsi birlikte 14 olur); akış tablosuna “hangi bölüm hangisine ne verir” tablosuna on iki satır.',
  },
  scenarios: {
    mark: 'S',
    title: 'Senaryo sağlaması',
    toc: 'Senaryo sağlaması',
    intro:
      'Sahada olacak yirmi şey ve mimarinin bugünkü hâliyle ne yaptığı. “Kısmen”: yol var, kural eksik. “Kapsanmıyor”: kayıt ya da akış yok.',
  },
} as const;
