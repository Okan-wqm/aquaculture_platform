/**
 * Platform architecture v4 — §08's two report tables: the operational reports
 * (per unit and batch, from the same events) and the official reports and
 * records (templates whose form and frequency follow regulation).
 *
 * Ported verbatim from the design document "Platform Mimarisi v4" (Turkish).
 */
import type { SectionTable } from '../../types';

export const REPORTING_TABLES: readonly SectionTable[] = [
  {
    title: 'Operasyonel raporlar',
    sub: 'Ünite ve parti bazında, aynı olaylardan',
    cols: ['Rapor', 'İçerik', 'Sıklık', 'Sorumlu'],
    rows: [
      [
        'Günlük ünite raporu',
        'açılış ve kapanış adedi, ölüm, ayıklama, yem, su kalitesi özeti',
        'günlük',
        'Sistem sorumlusu',
      ],
      [
        'Ölüm ve ayıklama analizi',
        'neden, adet ve kg, eğilim; su kalitesi, alarm ve tedaviyle ilişki (parti serisinde)',
        'haftalık',
        'Balık sağlığı',
      ],
      [
        'Transfer kaydı',
        'kaynak → hedef ünite, adet, ortalama ağırlık, bölme ve birleştirme',
        'her transfer',
        'Departman sorumlusu',
      ],
      [
        'Hasat raporu',
        'adet, kg, boy sınıfı, arınma süresi kontrolü, sevkiyat ve alıcı',
        'her hasat',
        'Saha sorumlusu',
      ],
      [
        'Parti yaşam boyu',
        'girişten hasada: yaşama oranı, FCR, SGR, maliyet, gelir, sonuç',
        'parti kapanışında',
        'Üretim müdürü',
      ],
      [
        'Plan – gerçekleşen',
        'üretim planı ve besleme planına karşı gerçekleşen; bütçe / gerçekleşen',
        'aylık',
        'Üretim müdürü',
      ],
      [
        'Alarm ve yanıt',
        'alarm sayısı, sınıf, onay ve çözüm süresi, raf kullanımı',
        'haftalık',
        'Saha sorumlusu',
      ],
      [
        'Stok mutabakatı',
        'hesaplanan ve sayılan stok, sayım farkı ve düzeltme kayıtları',
        'aylık · sayım transfer ve hasatta',
        'Departman sorumlusu',
      ],
    ],
  },
  {
    title: 'Resmi raporlar ve kayıtlar',
    sub: 'Şablon olarak tanımlanır; biçim ve sıklık mevzuata ve il müdürlüğüne göre yapılandırılır',
    cols: ['Rapor', 'Kaynak', 'Ne zaman', 'Onaylayan'],
    rows: [
      [
        'Üretim ve stok beyanı',
        'mutabakat: tür, adet, biyokütle; ruhsat kapasitesine göre kullanım (Bölüm 01)',
        'dönemsel ve denetim öncesi',
        'Teknik sorumlu müdür',
      ],
      [
        'Hasat ve satış kaydı',
        'hasat olayı → sevkiyat → alıcı, sevk belgesi',
        'her hasat',
        'Saha sorumlusu',
      ],
      [
        'Canlı balık nakil belgesi',
        'saha arası transfer olayı: kaynak, hedef, adet, sağlık durumu',
        'her nakil',
        'Veteriner hekim',
      ],
      [
        'Veteriner ilaç kullanım kaydı',
        'reçete + tedavi olayı: doz, ünite, parti, ilaç lotu, arınma süresi',
        'her tedavi',
        'Veteriner hekim',
      ],
      [
        'Hastalık ve olağan dışı ölüm bildirimi',
        'ölüm olayları; eşik aşılınca taslak hazırlanır',
        'olay olduğunda',
        'Teknik sorumlu müdür',
      ],
      [
        'Kaçış bildirimi',
        'kaçış olayı: kafes, tahmini adet ve ağırlık, neden, alınan önlem',
        'olay olduğunda',
        'Teknik sorumlu müdür',
      ],
      [
        'Su kalitesi ve deşarj izleme',
        'deşarj ölçüm noktaları (Bölüm 02), izin limitlerine karşı (Bölüm 01)',
        'izin koşuluna göre',
        'Çevre sorumlusu',
      ],
      [
        'Yem kullanım kaydı',
        'besleme olayları ve yem lotları, parti bazında',
        'dönemsel',
        'Üretim müdürü',
      ],
      [
        'Sertifika denetim dosyası',
        'GlobalG.A.P., ASC: olay, ilaç, eğitim ve yetkinlik, kalibrasyon, izlenebilirlik',
        'yıllık denetim',
        'Kalite sorumlusu',
      ],
    ],
  },
];
