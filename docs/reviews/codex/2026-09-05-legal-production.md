# Hukuk ARIA üretim bulguları — 2026-09-05

Kaynak: kullanıcının kod denetimi sonrası güncellenmiş Faz 0–8 üretim planı.
Çalışma alanı: `.worktrees/new-aria/new-aria`, dal `feat/new-aria-standalone-copy`.
Başlangıç: `e9d6c2a0e`, iki yarım dosya korunarak devam edildi.
R1 üretime hazır değildir. Aşağıdaki tarihler iş takibi hedefidir; teslim/uygunluk kanıtı değildir.

<a id="high-001"></a>

## LEGAL-HIGH-002

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 0.

Yarım karar sözleşmesi politikayla ve okuyucularla uyumsuz: başlangıç sunucu
87/97, beş sunucu tip hatası; web fixture tipleri de uyumsuz.
Kabul: mevcut assertion ve precision_min=1.0 korunarak sunucu/web tipleri,
testleri, derlemeleri ve adapter/korpus tek komutla geçer; workflow gerçek
monorepo `.github/workflows` dizininden bu komutu çalıştırır.

Uygulama: lawyer kapıları, açık boş karar alanları, imza/zincir denetimli karar
projeksiyonu, içerik değişiminde yetim doğrulama, karar geri alma, tutarlı defter
okuması. Düz artifact için runKey=null; geçmiş koşum oluşturulduğu iddia edilmez.
Karar yazma HTTP/UI akışı, tam imha ve koşum yayınlama bu bulgunun kapanışı değildir.

<a id="critical-001"></a>

## LEGAL-CRITICAL-003

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

Principal dosyası yapılandırılmışken bellekteki eski kayıt ve paylaşılan token
iptal kararını etkisiz bırakıyordu. Kabul: çalışan sunucuda sonraki HTTP isteği
hem avukat hem bootstrap operator iptalinden sonra 401 döner; dosya okunamadığında
eski/paylaşılan kimliğe dönülmez. Yapılandırılmış dosya her istekte okunur.
Bu bulgu çalışan işin yayın yetkisi sürüm kontrolünü kapsamaz (LEGAL-CRITICAL-006).

<a id="high-002"></a>

## LEGAL-HIGH-004

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 2.

Yazıcı yalnız defter kuyruğunu okuyordu; çökme sonrası kesilmiş deftere yeni baş
imzalayabiliyordu. Kabul: bozuk zincir/baş durumunda append reddedilir, mevcut
baş ve satırlar değişmez. Aynı süreçte okuma ve ekleme aynı sıraya girer.
Bu bulgu süreçler arası kilit, disk/inode bütçesi ve crash reconciliation kapanışı değildir.

<a id="high-003"></a>

## LEGAL-HIGH-005

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

Listeleme yetki filtresinden önce diğer davaların artifact'larını okuyordu.
Kabul: yetkisiz dava adı artifact açılmadan elenir; okunamayan yetkisiz artifact
kullanıcının kendi dava listesini bozmaz.

<a id="critical-002"></a>

## LEGAL-CRITICAL-006

Durum: OPEN. Sahip: Codex. Hedef: 2026-10-04. Faz: 1–2.

Eksik: bütün iş/geçmiş/arama/hafıza/indirme/export yüzeyinde dava kapsamı;
ajan snapshot izolasyonu; tek servis yazıcısı ve çevrimdışı yönetim kilidi;
yetki/kaynak/sağlayıcı sürümleri ve eski işin yayın reddi; kalıcı, tekilleştirilmiş,
iptal edilebilir işler; receiving/received alım ve yeniden başlatma uzlaştırması;
stdin girdi sınırı; değişmez koşum manifestleri, atomik current, tam sayfalama;
disk/inode/kapanış kapıları. Kabul: planın izolasyon, işletim ve 3000 HTTP belge /
20001 olay kapıları. Boş davanın açılması LEGAL-HIGH-013 ile ayrı izlenir. İş okuma yetkisi LEGAL-HIGH-014 ile ayrı izlenir.

<a id="critical-003"></a>

## LEGAL-CRITICAL-007

Durum: OPEN. Sahip: Codex. Hedef: 2026-10-04. Faz: 3.

Eksik: özgün hash + çıkarım sürümü + tam konum/alıntı çözümleyicisi; önerme
kökeni/desteği ayrımı; olumsuzluk, koşul, konuşan, çoklu tarih/tutar/para birimi;
PDF.js ve bağımsız görünüm testi; MIME/ek, XLSX adres/tarih/formül, DOCX
revizyon/not ve gerçek PPTX sırası; aynı dönem/konu çelişkisi; kararlı kopya
kimliği; kelime farkı; avukat transkripsiyonu. Olay/alım/kayıt/öğrenme ayrı kalmalı.
Kabul: planın kanıt, zaman, anlam ve biçim senaryoları; ana yetenek başına en az
100 etiketli + 20 olumsuz/belirsiz öğe. Etiketler pilot avukat tarafından incelenmeli.

<a id="critical-004"></a>

## LEGAL-CRITICAL-008

Durum: OPEN. Sahip: Codex. Hedef: 2026-10-04. Faz: 4.

Eksik: görülen içerik parmak izini taşıyan karar yazma HTTP/UI akışı; doğrulama,
filed ilan/geri alma, birleştirme/ayırma, olay düzeltme, açıklama, bulgu kapatma;
intake gezinmesi, iş denetimi, kaynak görüntüleme, sayfalama ve rol kontrolleri.
Belge kaldırma API'si açılmadı: kaynak ve türevleri, karma özet/prompt/hafıza/geçmiş
silinmeden kaldırma başarılı gösterilemez. Mevcut removal kaydı içerik okumayı
reddeder; fiziksel silme yaptığını iddia etmez. Serbest metinli imzalı kararlar
saklanan içeriktir; tüm dava imhasına ve yedek kontrol kaydına dahildir.

<a id="high-004"></a>

## LEGAL-HIGH-009

Durum: OPEN. Sahip: Codex. Hedef: 2026-10-04. Faz: 5.

Eksik: büronun yüklediği hukuk kaynaklarının ülke/madde/sürüm/geçerlilik/hash ile
alımı; mevcut SQLite üzerinde kapsamlı indeks ve yetki öncelikli arama;
yüklenen kaynağın güncelliğini varsaymadan kaynaklı açıklama; avukat onaylı ortak
yöntem ve bağımsız anonim yayın/geri çekme. Kabul: ikinci davaya ilk davanın
kişileri, olguları veya referansları taşınmadan yöntem uygulanır.

<a id="critical-005"></a>

## LEGAL-CRITICAL-010

Durum: OPEN. Sahip: Codex; etiket/model erişimi sahibi: pilot büro.
Hedef: 2026-10-04. Faz: 6. Ayrı çekirdek onay kapısı korunur.

Eksik: Git gerektirmeyen hukuk ajan koşumu; archive_verified kaynak bağının tüm
sonuç/hafıza/uzlaşma yolları; önerme-sürüm bazlı inceleme; kalıcı dava hafızası ve
tekilleştirilmiş insan geri bildirimi; kaldırmayla geçersizleştirme; iki otomatik
inceleme sınırı; ağsız işçi + dar sağlayıcı geçidi + gerçek sabit CLI konteyner
kanıtı; büro çapında bütçe rezervasyonu. Model internetten hukuk kaynağı aramaz.
Kabul: düzeltme → yeniden başlatma → farklı ifadeyle soru → kaynaklı hatırlama;
gerçek model koşumları ve ayrı ayrı kalite eşikleri. Provider/model izni ve
pilot avukat etiketleri araç testleriyle taklit edilerek kapatılamaz.

<a id="critical-006"></a>

## LEGAL-CRITICAL-011

Durum: OPEN. Sahip: Codex; SFTP erişimi sahibi: pilot büro.
Hedef: 2026-10-04. Faz: 7.

Eksik: tek Linux sunucuda temiz salt okunur imaj/TLS kurulumu; dosya/PID/ağ
izolasyonu; tüm alt süreç ve provider akışlarının kapanışı; readiness ve yeniden
başlatma; onaylı SFTP'ye restic şifreli tutarlı yedek; ayrı güncel imzalı iptal/
silme kontrol kaydı; boş alana doğrulamalı dönüş; 30 günlük fiziksel yedek temizliği.
Kabul: eski yedek + güncel kontrol ile iptal/silme korunur, kaynak A'nın canlı ve
türev içeriği yoktur, B kullanılabilir. Temsilî veriyle RPO24h/RTO4h ölçülmelidir.

<a id="high-005"></a>

## LEGAL-HIGH-012

Durum: OPEN. Sahip: Codex. Hedef: R1 kabulünden sonraki R2 planlama kapısı (2026-10-05).
Faz: 8; R1 dışındadır.

Onaylı emsal alımı, gerekçe/sonuç/durum kaynağı, karşı emsaller ve önemli farklar,
iddia/savunma/karşı inceleme strateji taslakları; uydurma kazanma olasılığı yok.
Özel dava hafızası ortak emsal erişimine açılmaz.

<a id="high-006"></a>

## LEGAL-HIGH-013

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

Yeni dava yalnız artifact oluşunca listeleniyor/açılıyordu; ilk belge yükleme
akışı bu yüzden erişilemiyordu. Kabul: create → list → detail → Intake/yükleme,
envanter olmadan çalışır. Pending response özgün case metadata taşır,
summary/coverage/runKey null olur; sentetik snapshot veya kapsam iddiası yoktur.
Hazır davada da Intake sekmesi görünür. Sunucu ve arayüz testleri gerekir.

<a id="high-007"></a>

## LEGAL-HIGH-014

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

İş sorgusu dava kapsamını taşımıyordu. Kabul: kayıt dava kimliğini saklar ve
GET job yalnız o davaya atanmış principal'a cevap verir; diğer dava 404 alır.
Genel cycle işi yalnız tüm davalara yetkili operator tarafından okunur.
Çalışan işin yetki sürümüyle durdurulması/yayın reddi LEGAL-CRITICAL-006 altında
hâlâ açıktır. Genel kernel okuma kısıtları LEGAL-CRITICAL-015 ile ayrı izlenir.

<a id="kernel-global-access"></a>

## LEGAL-CRITICAL-015

Genel çekirdek yüzeylerinin dava kullanıcılarına açılması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

Dava kapsamlı kullanıcılar genel çekirdek hafızası, bulgu, geçmiş, günlük,
SSE ve tanılama yollarına erişebiliyordu. Kabul: her genel endpoint açık
yetki sınıfı taşır; tüm davalara yetkili operator dışındaki principal istekleri
okuyucu/komut/akış başlamadan reddedilir. Açık akışın yetkisi kaldırılınca akış
kapanır. Arayüz aynı izne göre gezinir ve genel veriyi önceden yüklemez.
Bu alt bulgu çalışan envanter işinin yayın sürümü kontrolünü kapsamaz.

Kanıt: katalog testleri ilk durumda 51 uygunsuz cevabı yakaladı. SSE iptal,
kapsam daraltma ve bozuk/eksik kimlik deposunda kapanır. Control/cycle/admin
gövdesi beklerken iptal, kapsam değişimi ve token yenileme sonrası komut
başlamaz; değişmeyen kimlikte işlev sürer. Birleşik kapı: 135 sunucu ve
72 arayüz testi, tip denetimleri, derlemeler ve adapter kontrolleri geçti.

<a id="single-writer-authority"></a>

## LEGAL-CRITICAL-016

Servis ve yönetim CLI'sinin ortak durum yazma yarışı.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-05. Faz: 1.

Servis başlangıcı ve principal yönetim CLI'si aynı kurulum üzerinde karşılıklı
dışlama olmadan dosya yazabiliyordu. Kabul: servis bütün başlangıç yazımlarından
önce işletim sistemi kilidi edinir; ikinci servis ve çevrimdışı CLI aynı
depolama üzerinde yazamaz. Süreç ölümü kilidi bırakır; bayat PID tahmini veya
kilit dosyasını silme kullanılmaz. Çevrimiçi yönetim tek servis yazıcısına
bağlanır ve yalnız sınırsız operator yetkisiyle çalışır. Anahtar ve mevcut
principal dosyaları başlangıçta ezilmez. İşçi snapshot/PID/ağ izolasyonu
LEGAL-CRITICAL-006 altında ayrıca açıktır.

Uygulanan alt kapsam: servis ve CLI ortak depolama kimliklerini Linux flock
ile kilitler; çevrimiçi yönetim tek serviste çalışır. Alt süreç özel user/mount/PID
namespace'inde başlatılır; doğrudan çocuk kilidi devralır. Gerçek Python
subprocess testi, tanıtıcılarını kapatıp ayrı oturum açan adapter'ın kernel
çıkışı ve süre aşımından sonra yazmadığını doğrular.

**Bu bulgu henüz kapanmış değildir.** Servis ve unshare monitörünün birlikte
kaybında son kilit tanıtıcısının bırakılması, Linux'un PID namespace çocuklarını
tamamen temizlemesinden önce gerçekleşebilir. Eski adapter'ın canlı sonuca
yazmasını yapısal olarak engelleyen snapshot/iş alanı ve servis yayın katmanı
LEGAL-CRITICAL-006 kapsamında tamamlanmalıdır. Bu commit eşzamanlı çoklu süreç
kaybı için mutlak tek-yazıcı güvencesi iddia etmez.

Konteyner kanıtı: mevcut Docker default profili namespace oluşturmayı reddetti.
`arias/legal/docker/apparmor.profile` yüklenmeden ayrıştırıldı; seccomp dosyası
sabit Moby kaynağından türetildi; iki console Compose servisi bu profilleri
zorunlu kılar. Yeni AppArmor profili paylaşılan host çekirdeğine yüklenmedi;
özel profille gerçek konteyner yürütme doğrulaması ve kurulum kapısı
LEGAL-CRITICAL-011 altında açıktır. Korumasız çalıştırma yolu eklenmedi.
