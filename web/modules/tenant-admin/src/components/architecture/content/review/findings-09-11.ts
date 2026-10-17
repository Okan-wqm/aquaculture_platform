/**
 * Architecture review — findings for v3 sections 09–11.
 *
 * Ported verbatim from the design document "Mimari İnceleme" (Turkish body
 * text). Each finding is [kind, title, text, recommendation]; its id is
 * "{section}.{position}", as the review cites it.
 */
import type { ReviewSection } from '../../types';

export const FINDINGS_09_11: readonly ReviewSection[] = [
  {
    num: '09',
    title: 'İzlenebilirlik',
    intro: 'Anahtar (parti + yerleşim + zaman) doğru. Sevkiyat, tek stok ve miras kuralı eksik.',
    items: [
      [
        'b',
        'Etiketteki lot = sevkiyat',
        'Alıcıdaki etiket bir kamyona yüklenen iki partiyi birden taşıyabilir. “Hasat → sevkiyat → alıcı” tek kutu olunca geriye iz tek partiye zorlanır.',
        '“Sevkiyat” kutusu (04.2): etiket lot no → sevkiyat → partiler ve oranları → şeritler.',
      ],
      [
        'c',
        'Malzeme lotu kapsamı',
        '“Yem, ilaç ve yavru için aynı kayıt” — yedek parça (05), kimyasal, oksijen ve yakıt dışarıda kalıyor.',
        'K4: malzeme lotu her girdi için; tür alanıyla ayrışır.',
      ],
      [
        'k',
        'Ölçüm noktası mirası',
        '“Ortak suda sistemin ölçüm noktalarından çekilir” — kural yazılmamış: ünitenin kendi noktası varsa sistemdeki yok sayılır mı, ikisi birden mi?',
        'Kural: ünitenin su kimyası = kendi noktaları; parametre yoksa üst sistemin noktası; ikisi varsa ünite önceliklidir, sistem karşılaştırma için saklanır.',
      ],
      [
        'b',
        'Belge ekleri',
        'İrsaliye, analiz sertifikası, reçete, sağlık sertifikası, fotoğraf hep anılıyor; bir “belge” kaydı ve kayda bağlanma biçimi yok.',
        'K6: Belge kaydı (tür, dosya, tarih, kime bağlı, sürüm). Mal kabul, reçete, kalibrasyon, onay belgeye referans verir.',
      ],
      [
        'k',
        'SKT ve karışım düzeltmesi',
        'Son kullanma tarihi geçmiş lotun kullanımı engellenmiyor. Silodaki karışım oranı FIFO varsayımı; sayım ile düzeltilmesi yazılmamış.',
        'Kural: SKT geçmiş lot olayda seçilemez (uyarıyla geçersiz kılma yetkiye bağlı). Silo sayımı karışım oranını ileriye dönük düzeltir.',
      ],
    ],
  },
  {
    num: '10',
    title: 'Örnek parti',
    intro: 'Örnek bölümlerle tutarlı. İki ayrıntı kural istiyor.',
    items: [
      [
        'u',
        'Tedavi sırasında transfer',
        'OTC tedavisi Ağustos ortasında başlıyor, transfer ve bölme aynı günlere düşüyor. Mimari yasaklamaz; ama tedavi altındaki balığı taşımak stres ve kalıntı riskidir.',
        '“Tedavi süresince transfer” uyarısı; yetkili onayıyla geçilir, olayda gerekçe saklanır.',
      ],
      [
        'k',
        'Ölüm tepesi neye göre?',
        'Tepe iki üniteye yayılıyor (B-03 → B-08). Tespit üniteye göre yapılırsa transferde seri kesilir, tepe görünmez.',
        'Ölüm analizi parti serisinde yapılır; yerleşim değişimi seriyi kesmez, yalnızca işaretler.',
      ],
    ],
  },
  {
    num: '11',
    title: 'Hepsi birlikte',
    intro:
      'Merkez doğru: yer ağacı. Diyagram ile akış tablosu birbirini tutmuyor ve bir modül hiç yok.',
    items: [
      [
        'c',
        'Tablo ile diyagram farklı',
        'Akış tablosunda “İzlenebilirlik” kaynak ve hedef; diyagramda kutusu yok. Not “Üretim, Sera ve Kontrol aynı ağacı kullanır” der; Kontrol hiçbir bölümde tanımlı değil.',
        'Diyagrama İzlenebilirlik (09) ve Kontrol (11) kutuları; Kontrol için yeni bölüm.',
      ],
      [
        'b',
        'Eksik akışlar',
        'Alarm → İzlenebilirlik, Bakım → Üretim, Kişiler → Üretim, Raporlama → Finans gibi on iki bağ tabloda yok (Ö bölümü).',
        'Ö bölümündeki satırları tabloya ekle.',
      ],
      [
        'k',
        'Ters yön sorgusu',
        '“Ölçüm → yer → merkez → parti” akışı yazılmış; tersi (“bu partiden o tarihte kim sorumluydu, hangi ekipman çalışıyordu”) yol olarak belirtilmemiş.',
        'Not ekle: parti → yerleşim → yer → o tarihteki sorumluluk, varlık ve kanal bağları. Tüm bağlar tarihli olduğu için tek sorguyla çıkar.',
      ],
    ],
  },
];
