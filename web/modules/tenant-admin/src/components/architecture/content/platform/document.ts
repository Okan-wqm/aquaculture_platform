/**
 * Platform architecture v4 — the document's own header and the title of §14's
 * flow table, verbatim from the design document "Platform Mimarisi v4"
 * (Turkish). The page chrome around it (page title, legend, column headers)
 * is localized through the i18n message keys instead.
 */
export const ARCHITECTURE_DOCUMENT = {
  kicker: 'Suderra · platform mimarisi v4',
  headline: 'Platform nasıl bağlanır',
  intro:
    'Her bölüm önce kendi içinde çizildi, son bölüm hepsinin nasıl birleştiğini gösteriyor. Kesikli çerçeveli kutular başka bir bölüme işaret eder. Bu sürümde kontrol yolu, stok ve taraf, zaman modeli eklendi; her bölümün altında artık kurallar var.',
  flowsTitle: 'Bölümler arası akış',
  flowsSub: 'Hangi bölüm hangisine ne verir',
} as const;
