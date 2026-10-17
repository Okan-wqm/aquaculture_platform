/**
 * Architecture review — findings for v3 sections 05–08.
 *
 * Ported verbatim from the design document "Mimari İnceleme" (Turkish body
 * text). Each finding is [kind, title, text, recommendation]; its id is
 * "{section}.{position}", as the review cites it.
 */
import type { ReviewSection } from '../../types';

export const FINDINGS_05_08: readonly ReviewSection[] = [
  {
    num: '05',
    title: 'Bakım',
    intro:
      'En kritik mantık hatası burada: bakım modu zamanlaması. Ayrıca varlık değişimi ve stok bağı kopuk.',
    items: [
      [
        'c',
        'Bakım modu iş emri açılınca başlıyor',
        '“Açık iş emri olan ekipmanın alarmları bastırılır.” Planlı iş emri iki hafta önce açılır; bu sürede pompa gerçekten arızalanırsa alarm bastırılmış olur.',
        'İş emri durumları: açık → planlandı → devam ediyor → tamamlandı. Bastırma yalnız “devam ediyor” süresince. Arıza alarmı iş emri kapanana kadar açık kalır, otomatik kapanmaz.',
      ],
      [
        'b',
        'Elle arıza bildirimi yok',
        'İş emrini yalnız plan ve alarm açıyor. Operatörün “pompa ses yapıyor” demesi için yol yok.',
        '“İş talebi” kutusu: kişi, yer veya varlık, açıklama, fotoğraf → değerlendirilip iş emrine döner ya da reddedilir.',
      ],
      [
        'b',
        'Kapanış varlık bağını güncellemiyor',
        'Pompa değişimi bir iş emridir; ama kapanışın 01’deki “varlık → pozisyon · tarihli” bağını kapatıp yenisini açtığı yazılmamış.',
        'Kapanış “söküldü / takıldı” hareketi yazar: eski varlık depoya veya hurdaya, yenisi pozisyona. Sensör değişiminde kanal aynı kalır (02).',
      ],
      [
        'k',
        'Varlığın çalışma saati nereden?',
        'Plan “çalışma saatine göre” açılır; saat varlığa aittir ama ölçüm pozisyondadır.',
        'Kural: varlık çalışma saati = takılı olduğu pozisyonların durum tag’inin, takılı dönemler içindeki toplamı (01 bağı × 02 serisi).',
      ],
      [
        'b',
        'Kalibrasyon kaydının içeriği',
        '“Kalibrasyon da iş emri türüdür” yeterli değil: önce/sonra değer, referans çözelti lotu, sertifika, yeni katsayı ve geçerlilik süresi gerekir.',
        'Kalibrasyon kapanışına bu alanları ekle; katsayı sürümlü olarak varlıkta saklanır ve edge’e iner (02.4).',
      ],
      [
        'c',
        'İki ayrı stok',
        'Yedek parça stoğu 05’te, malzeme lotu 09’da; kimyasallar ve oksijen hiçbirinde. Aynı depo hareketi iki modelle tutulur.',
        'K4: tek stok modeli. Yedek parça da malzeme lotudur.',
      ],
      [
        'b',
        'Dış servis ve duruş',
        'Garanti, servis sözleşmesi, yüklenici teknisyen (03.3) ve duruş süresi, arıza sıklığı gibi bakım göstergeleri yok.',
        'İş emrine “yapan: iç ekip / yüklenici (taraf)” ve garanti bayrağı; hesaplar kutusuna duruş süresi ve MTBF.',
      ],
    ],
  },
  {
    num: '06',
    title: 'Enerji ve finans',
    intro: 'Tek yoldan akış ilkesi doğru. Kaynak türü, tarife, gelir ve dağıtımın ara adımı eksik.',
    items: [
      [
        'c',
        'Dağıtım hizmet oranını atlıyor',
        '“Yere göre” dağıtım, BL-1’in iki sisteme %60/%40 hizmet ettiğini bilmez; pozisyon tek yere bağlı olduğundan gider tek sisteme yazılır.',
        'Dağıtım sırası: sayaç → pozisyon → hizmet oranı (01.3) → yer → maliyet merkezi. Oran tarihli.',
      ],
      [
        'b',
        'Yalnız elektrik',
        'RAS’ta sıvı oksijen, kafeste tekne ve jeneratör dizeli, serada ısıtma gazı ana giderdir. Su tüketimi ve deşarj ücreti de ölçülür.',
        'Sayaca “kaynak türü” (elektrik, su, oksijen, gaz, yakıt); aynı ağaç, aynı dağıtım. Ölçülmeyen kaynak (tüp, tanker) stok hareketinden gelir (K4).',
      ],
      [
        'b',
        'Tarife ve fatura',
        'kWh var, TL yok. Zamanlı tarife, güç bedeli, reaktif ceza, fiyat değişimi; ana sayaç ile fatura mutabakatı.',
        '“Tarife” kaydı (tarihli, kaynak türüne göre) ve aylık fatura mutabakatı kutusu. Tutar = tüketim × o günün tarifesi.',
      ],
      [
        'b',
        'Gelir yok',
        'Parti maliyeti var, satış yok; kârlılık ve kg başına marj hesaplanamaz.',
        'Sevkiyat ve satış kaydından (04.2) gelir partiye akar; parti sonucu = gelir − doğrudan − dolaylı.',
      ],
      [
        'k',
        'İşçilik hangi merkeze?',
        'Akış tablosunda “puantajdan işçilik maliyeti” var; anahtar yok: departmanın işlettiği yerler mi, iş emri saatleri mi, vardiya yeri mi?',
        'Kural: iş emrindeki saat → iş emrinin varlığının yeri; kalan puantaj → departmanın işlettiği yerlere (03) eşit ya da biyokütleye göre.',
      ],
      [
        'u',
        'Negatif kalan ve boş ünite',
        'Alt sayaçların toplamı üst sayacı aşarsa (sayaç hatası) kalan negatif olur. Boş tankın (temizlik, bekleme) tüketimi hangi partiye gider?',
        'Negatif kalan → kalite bayrağı ve dağıtım durur. Boş ünite gideri partiye değil maliyet merkezinde kalır; “genel gider” merkezi = üst seviyenin merkezi.',
      ],
      [
        'b',
        'Amortisman ve yatırım',
        'Varlık değeri ve amortisman gideri yok; parti maliyeti yalnız işletme giderini görür. Kapsam dışıysa yazılmalı.',
        'Karar: ya varlığa değer ve ömür eklenip amortisman maliyet merkezine akar, ya da “kapsam dışı, muhasebeden gelir” diye not düşülür.',
      ],
    ],
  },
  {
    num: '07',
    title: 'Alarm ve bildirim',
    intro: 'Yönlendirme mantığı doğru. Alarm sınıfı, durum modeli ve kural ayrıntıları eksik.',
    items: [
      [
        'b',
        'Alarm sınıfı yok',
        'Proses (DO), ekipman arızası, veri kalitesi, iletişim (edge çevrimdışı), güvenlik hepsi aynı yolu izliyor; farklı kişilere gitmeleri gerekir.',
        'Alarm sınıfı → sorumluluk türü eşlemesi (03.2). İletişim ve veri kalitesi alarmları bakım/BT’ye, proses alarmları işletmeye.',
      ],
      [
        'k',
        'Kuralın ayrıntıları',
        'Histerezis / ölü bant, normale dönüş koşulu, bileşik kural (DO düşük VE blower durdu), operatörün gerekçeli süreli bastırması (raf), alarm seli sınırı yok.',
        'Kural kutusuna: eşik + süre + ölü bant + bileşik koşul. Ayrı “raf” işlemi: kim, ne kadar, neden; süre bitince kendiliğinden kalkar.',
      ],
      [
        'k',
        'Durum modeli yetersiz',
        '“Açık → onaylı → kapalı” üç durum; değer normale döndü ama kimse onaylamadı hâli yok. Kapanış koşulu yazılmamış.',
        'İki eksen: aktif / normale döndü × onaysız / onaylı. Kapanış = normale döndü ve onaylı (ya da gerekçeli elle kapatma).',
      ],
      [
        'k',
        'Eskalasyon sabit',
        '“15 dk departman, 30 dk saha” her öncelik için aynı. Onaylamak çözmek değildir; onaylanmış ama saatlerce çözülmemiş alarm yükselmez.',
        'Eskalasyon süreleri önceliğe göre; ikinci bir zamanlayıcı “çözülmedi” için (normale dönmeyen onaylı alarm).',
      ],
      [
        'k',
        'Karışık ünite ve ortak su',
        'Tankta iki farklı evre varsa hangi eşik? RAS-1’in ortak su tag’i için hangi partinin eşiği?',
        'Kural: ünitedeki ve ortak suda sistemdeki tüm partilerin en sıkı eşiği geçerlidir.',
      ],
      [
        'u',
        'Edge yerel alarmı',
        'Çevrimdışıyken edge kritik alarmı yerelde üretir; kime, nasıl (siren, yerel SMS)? Bağlantı gelince aynı alarm ikinci kez açılır mı?',
        'Edge alarm kimliği taşır; platform aynı kimliği birleştirir. Yerel çıkış (siren, röle) 11 Kontrol’de tanımlanır.',
      ],
      [
        'b',
        'Alarm geçmişi partiye akmıyor',
        '10’daki “ölüm tepesi düşük DO ile birlikte” ilişkisi için alarm geçmişinin yerleşim dönemiyle partiye bağlanması gerekir; akış tablosunda satır yok.',
        'Akış ekle: Alarm → İzlenebilirlik (alarm geçmişi dönemle partiye) ve Alarm → Raporlama (alarm sayısı, yanıt süresi).',
      ],
    ],
  },
  {
    num: '08',
    title: 'Raporlama',
    intro:
      'Tek kaynaktan rapor ilkesi doğru. Kilit zamanlaması, düzeltmenin dönemi ve birkaç resmi kayıt eksik.',
    items: [
      [
        'k',
        'Kayıt kapanış penceresi',
        'Dün ölen balık bugün girilir; lab sonucu üç gün sonra gelir; edge 7 gün saklar. Dönem ne zaman kilitlenebilir?',
        'Gün kapanışı T+2, dönem kilidi dönem sonu + n gün; pencere içinde giriş serbest, sonrası düzeltme kaydı.',
      ],
      [
        'k',
        'Düzeltme hangi döneme yazılır?',
        '“Düzeltme ayrı kayıt, rapor yeni sürüm” — ama tutar ilgili döneme mi (yeniden üretim), cari döneme mi (muhasebe mantığı) işler? Finans ve operasyon farklı davranırsa rakamlar tutmaz.',
        'Kural: operasyonel ve resmi rapor ilgili döneme yeni sürüm; finansal etki cari döneme “önceki dönem düzeltmesi” satırı. İkisi birbirine referans verir (K7).',
      ],
      [
        'u',
        'Sayım farkı geçmişe dağıtılır mı?',
        'Kafeste sayım yalnız hasatta mümkündür; aylık “fiziksel sayım” gerçekçi değil. Hasatta çıkan %6 fark geçmiş aylara dağıtılırsa yaşama oranı ve FCR geçmişi değişir; dağıtılmazsa son ay bozulur.',
        'Politika yaz: fark “sayım farkı” olayı olarak sayım tarihine yazılır, geçmiş yeniden hesaplanmaz; raporlarda ayrı satır gösterilir. Tabloda sıklığı “transfer ve hasatta” yap.',
      ],
      [
        'b',
        'Eksik resmi kayıtlar',
        'Kaçış bildirimi (kafes), canlı balık nakil / sevk belgesi (saha arası transfer), ruhsat kapasitesi izleme, yem kullanım beyanı yok.',
        'Tabloya dört satır ekle; kaçış 04.1 olayından, nakil belgesi transfer olayından, kapasite 01.5’ten üretilir.',
      ],
      [
        'b',
        'İzin koşulları kaynağı',
        '“Deşarj izleme: izin koşuluna göre” — koşul nerede kayıtlı? Eşik olarak 07’ye nasıl iner?',
        '01.5 “İzin ve belge” kaydındaki limitler deşarj tag’lerine kural olur; rapor aynı limitleri gösterir.',
      ],
      [
        'k',
        'Onay zinciri',
        'Sıralı mı (müdür → veteriner) paralel mi? Reddedilirse ne olur? Hazırlayan onaylayabilir mi (03.6)?',
        'Şablon onay zincirini tanımlar (sıra, zorunlu türler 03.2). Ret, gerekçeyle taslağa döndürür.',
      ],
    ],
  },
];
