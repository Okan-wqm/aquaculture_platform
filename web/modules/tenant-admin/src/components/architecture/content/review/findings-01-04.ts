/**
 * Architecture review — findings for v3 sections 01–04.
 *
 * Ported verbatim from the design document "Mimari İnceleme" (Turkish body
 * text). Each finding is [kind, title, text, recommendation]; its id is
 * "{section}.{position}", as the review cites it.
 */
import type { ReviewSection } from '../../types';

export const FINDINGS_01_04: readonly ReviewSection[] = [
  {
    num: '01',
    title: 'Tesis yapısı',
    intro: 'Omurga sağlam; eksik olan seviye atlama kuralı, hizmet oranı ve varlığın hayatı.',
    items: [
      [
        'c',
        'Depo nedir?',
        '01 “depo proses dışıdır, doğrudan alana bağlanır” der; 04 ve 05 “depo ünitesinde” der. Aynı şey iki ayrı seviyeye konmuş.',
        'Depo bir ünite türüdür. Üniteye tür alanı ekle: tank, kafes, havuz, silo, depo, sera bölmesi. Depo ünitesinin ebeveyni alan olur, sistem atlanır.',
      ],
      [
        'k',
        'Seviye atlanabilir mi?',
        'Kafes sahasında “sistem / proses hattı” yoktur; ağaç 1 : n zinciri olarak çizilince her kafes bir sisteme bağlanmak zorunda kalır.',
        'Alan ve Sistem isteğe bağlı: ünitenin ebeveyni sistem ya da alan olabilir. Kural: raporlar boş seviyeyi atlayarak yukarı toplar.',
      ],
      [
        'b',
        'Hizmet ataması kutusu yok',
        'BL-1’in RAS-1 %60 / RAS-2 %40 çalışması yalnız notta. 06’daki dağıtım bu orana muhtaç ama diyagramda ne kutu ne bağ var.',
        '“Hizmet ataması: pozisyon → sistem veya ünite · oran · tarihli” kutusu ekle; 06 dağıtımı bu bağı kullansın.',
      ],
      [
        'b',
        'Varlığın hayatı',
        'Varlık yalnız “pozisyona takılı” hâliyle var. Depodaki yedek pompa, hurdaya ayrılan sensör, garanti süresi, satın alma değeri yok.',
        'Varlık durumu (depoda · takılı · bakımda · hurda) ve stok konumu (depo ünitesi) ekle; durum geçişleri 05 kapanışıyla yazılsın.',
      ],
      [
        'b',
        'İzin, belge ve kapasite',
        '08 “belgedeki kapasiteye göre kullanım” ister, 02 deşarj izleme “izin koşuluna göre” der; ne ruhsat ne izin bir yerde kayıtlı.',
        'Sahaya “İzin ve belge” kaydı: ruhsat kapasitesi (tür, ton/yıl), deşarj izni limitleri, geçerlilik. Limitler 07’ye eşik, kapasite 08’e rapor olur. Üniteye hacim ve azami yoğunluk ekle.',
      ],
      [
        'k',
        'Tarihli ağacın bütünlüğü',
        '“Bağlar tarihlidir” deniyor; ama aynı anda iki ebeveyn olabilir mi, çocuk dönemi ebeveyn dönemini aşabilir mi, içinde parti olan tank kapatılabilir mi yazılmamış.',
        'Kural seti: her an tek ebeveyn; çocuk dönemi ebeveyn dönemi içinde; açık yerleşimi, takılı varlığı ya da açık iş emri olan yer kapatılamaz.',
      ],
    ],
  },
  {
    num: '02',
    title: 'Veri toplama',
    intro: 'Akış doğru; bağlama noktası eksik, hesaplama katmanı ve geç veri davranışı yok.',
    items: [
      [
        'c',
        'Kanal neye bağlanır?',
        'Bağlama “kanal → ölçüm noktası”; ama tag “nokta + parametre”. Kanal parametre taşımadan hangi tag’e yazacağı belirsiz; aynı noktada DO ve sıcaklık varsa çakışır.',
        'Bağlama “kanal → tag” olsun. “Parametre sözlüğü” kutusu ekle: ad, birim, fiziksel aralık, çözünürlük. Edge’deki aralık kontrolü de buradan iner.',
      ],
      [
        'b',
        'Hesaplanan tag ve toplulaştırma',
        'kWh (06), çalışma saati (05), “dönem ortalaması ve sınır dışı gün” (09, 10) hep hesaplanıyor; hesaplayan kutu yok. Ham 10 sn verinin saklama süresi de yok.',
        '“Hesaplanan tag” (formül, girdi tag’leri, sürüm) ve “Özet seri” (saatlik, günlük: ort, min, maks, sınır dışı süre) ekle; saklama: ham 2 yıl, özet süresiz gibi bir politika yaz.',
      ],
      [
        'k',
        'Geç gelen veri',
        'Edge 7 gün saklar; bağlantı gelince eski değerler akar. Bunlar canlı alarm üretir mi, kapanmış günün raporunu değiştirir mi, kilitli döneme düşerse ne olur: sessiz.',
        'Her kayıtta olay zamanı ve kayıt zamanı (K1). Geç veri kuralları “geçmiş” modunda değerlendirir: alarm açılmaz, olay günlüğüne “geç geldi” düşer. Kilitli dönem için 08.2.',
      ],
      [
        'k',
        'Ham değer saklanıyor mu?',
        'Ölçekleme edge’de yapılıyor; katsayı değişince ya da yanlış girildiğinde geçmiş ham değer yoksa geri hesaplanamaz. Denetimler (GlobalG.A.P.) kalibrasyon izini ister.',
        'Ham + mühendislik değerini birlikte sakla ya da her değere katsayı sürümünü yaz. Katsayı geçmişi varlıkta (05.5).',
      ],
      [
        'b',
        'Numune iki zamanlı, bazısı partiye',
        'Manuel giriş “mobil form, numune” diye tek kutu. Su numunesi yere yazılır, ama histopatoloji ve kalıntı analizi partiye aittir; ikisinde de alım zamanı ile sonuç zamanı farklıdır.',
        '“Numune ve lab sonucu” kaydı: hedef yer veya parti, alım zamanı, sonuç zamanı, laboratuvar (taraf), belge. Su parametreleri tag’e, sağlık sonuçları parti olayına yazılır.',
      ],
      [
        'c',
        'Yalnız ayar iner, ama kontrol var',
        '“Ters yönde sadece ayar iner” deniyor; aynı cümlede setpoint var, 09’da otomatik yemleyici programı var, konsolda Kontrol modülü var. Komut göndermek ayar değildir.',
        'Bölüm 11 Kontrol: komut, yetki, onay, edge’e iletim, cihaz yanıtı, komut günlüğü, kilitler.',
      ],
      [
        'u',
        'Kaynak önceliği ve saat',
        '“Geçerli olan kullanılır” — geçerli ne? Birincil ile yedek sapınca ne olur? Edge saati 7 gün çevrimdışı kalınca sapar.',
        'Geçerli = kalite iyi ve bayat değil. Birincil–yedek sapması kalite alarmı üretir. Platform edge saat sapmasını ölçer ve işaretler.',
      ],
    ],
  },
  {
    num: '03',
    title: 'Kişiler ve erişim',
    intro:
      'Dört kavram ayrımı doğru. Kapsam modeli ve sorumluluk türü, 07 ve 08’in ihtiyacını karşılamıyor.',
    items: [
      [
        'c',
        'Kapsam ile sorumluluk şartı çelişiyor',
        'Rol kapsamı “saha · departman · kendi”. Kural: sorumlu atanan kişinin o yerde yetkisi olmalı. Bakım teknisyeni başka departmanın RAS-1’ine sorumlu olunca tek çare saha genelinde yetki vermek: fazla yetki.',
        'Kapsam = yer ağacı düğümü (her seviye) · departman · kendi. Sorumluluk ataması yapılırken eksik yetki o düğüm için otomatik önerilir.',
      ],
      [
        'c',
        'Sorumluluk tek tip',
        '03’te sorumluluk “yer → kişi”. 07 arıza alarmını bakımcıya, DO alarmını işletmeciye göndermek ister; 08 veteriner hekim, çevre, kalite, teknik müdür onayı ister. Hepsi aynı “sorumlu”ya gider.',
        '“Sorumluluk türü” ekle: işletme, bakım, balık sağlığı, çevre, kalite, teknik sorumlu müdür. Alarm sınıfı → sorumluluk türü eşlemesi (07.1); onay şablonu türü seçer (08).',
      ],
      [
        'b',
        'Çalışanı olmayan hesap',
        '“Hesapsız çalışan olabilir” var; tersi yok. Dış veteriner, denetçi, yüklenici teknisyen, tedarikçi hesabı tanımsız. 08’deki veteriner onayı çoğu işletmede dış kişidir.',
        'Hesap → çalışan 0..1. Dış hesap bir Taraf’a bağlanır (K5), süreli ve kapsamı dar olur.',
      ],
      [
        'b',
        'Nöbet yok',
        'Vardiya ve izin “kimin müsait olduğunu söyler”. Gece 03:00’te vardiya yoksa alarm kime gider? Vekil de izinliyse zincir üst seviyeye çıkar ama gece müsait kimse bulunmaz.',
        '“Nöbet listesi” (yer × dönem × kişi + telefon). Yönlendirme sırası: sorumlu → vekil → nöbetçi → üst seviye sorumlusu → nöbetçi.',
      ],
      [
        'b',
        'Eğitim ve yetkinlik',
        '08’deki sertifika dosyası “eğitim” kaydı ister; tedavi uygulayan kişinin yetkili olup olmadığı sorulmaz.',
        '“Eğitim ve yetkinlik” kaydı (kişi, konu, geçerlilik, belge). Tedavi, kimyasal uygulama, elektrik işi gibi olaylar yetkinlik şartı taşır.',
      ],
      [
        'k',
        'Görev ayrılığı',
        'Raporu hazırlayan onaylayabilir mi, iş emrini yapan kapatabilir mi: yazılmamış.',
        'Kural: onaylayan ≠ hazırlayan; iş emri kapanışı yapan dışında biri doğrular (ya da bilinçli olarak tek kişiye izin ver ve yaz).',
      ],
    ],
  },
  {
    num: '04',
    title: 'Üretim',
    intro:
      'Parti–yerleşim–olay üçlüsü doğru kurulmuş. Eksik olan olay sözlüğü, sevkiyat, plan ve birkaç kilit kuralı.',
    items: [
      [
        'b',
        'Olay sözlüğü dar',
        'Boylama (grading), aşılama, hasat öncesi açlık, kafesten kaçış, predatör kaybı, ağ değişimi yok. Kaçış resmi bildirim konusudur.',
        'Olay türleri yönetilebilir sözlük olsun; her türün etkisi tanımlı (adet, kg, maliyet, resmi bildirim). Kaçış → 08’e bildirim taslağı.',
      ],
      [
        'b',
        'Sevkiyat ve satış yok',
        'Hasat → alıcı var; ama sevkiyat kaydı (araç, belge, bir kamyonda iki parti) ve satış tutarı yok. 06 yalnız maliyet hesaplıyor: parti kârı çıkmaz, alıcıdaki etiket tek partiye bağlanamaz.',
        '“Sevkiyat” (n parti × adet × kg → alıcı, belge, araç) ve satış kaydı. Etiketteki lot = sevkiyat no. Gelir 06’ya akar.',
      ],
      [
        'b',
        'Besleme planı ve büyüme modeli',
        'Biyokütle iki tartım arasında nasıl bulunur? Günlük yem miktarı neye göre önerilir? Planlanan ve gerçekleşen yem karşılaştırması yok.',
        '“Besleme planı” (yem tablosu: sıcaklık × boy → % biyokütle) ve büyüme modeli hesabı. Olaydaki besleme plana karşı raporlanır.',
      ],
      [
        'b',
        'Üretim planı',
        'Finansta bütçe var, üretimde plan yok: stoklama planı, hedef hasat tarihi ve ağırlığı, ruhsat kapasitesine karşı kullanım.',
        '“Üretim planı” (parti × hedefler × dönem). Gerçekleşenle karşılaştırma 08’e, kapasite kontrolü 01.5’e bağlanır.',
      ],
      [
        'k',
        'Arınma süresi devreder mi?',
        'Bölünen P-2026-07B arınmayı devralır mı? Birleşince hangi süre geçerli? Banyo tedavisi tanktaki iki partiyi de etkiler mi?',
        'Kural: arınma bölünen partilere geçer; birleşmede en uzun kalan süre. Üniteye uygulanan tedavi (banyo) o anki tüm partilere, yemle tedavi seçilen partiye yazılır.',
      ],
      [
        'k',
        'Reçete ve son kullanma',
        '08 “tedavi olayı: reçete” der; reçetenin bir kayıt olduğu, veteriner onayı taşıdığı ve tedaviden önce gelmesi gerektiği yazılmamış.',
        '“Reçete” kaydı (veteriner, ilaç, doz, süre, arınma). Reçetesiz tedavi olayı reddedilir; SKT geçmiş ilaç lotu seçilemez (09.5).',
      ],
      [
        'u',
        'Karışık ünitede ölüm',
        '“Olay partiyi açıkça seçer” — ölü balığın hangi partiden olduğu çoğu zaman bilinmez.',
        'Ünite düzeyinde ölüm olayına izin ver; partilere adet veya biyokütle oranıyla paylaştır, paylaşım anahtarı olayda saklansın.',
      ],
      [
        'k',
        'Parti ne zaman kapanır?',
        'Stok sıfırlanınca mı, son hasat girilince mi, elle mi? Kapanmadan parti maliyeti ve yaşam boyu raporu kesinleşemez.',
        'Kural: stok 0 ve açık yerleşim yok → kapanış önerilir; kapanış onaylı ve tarihlidir, sonrası düzeltme kaydıdır.',
      ],
    ],
  },
];
