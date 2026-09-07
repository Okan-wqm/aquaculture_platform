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

Uygulanan alt kapsam: servis/CLI kilidi LEGAL-CRITICAL-016; alım uzlaştırması
LEGAL-CRITICAL-018; envanter için dava snapshot'ı, sınırlı dosya girdisi,
yetki/kaynak/politika sürümü denetimi ve imzalı değişmez yayın LEGAL-CRITICAL-019.
Kalan: tüm gelecek iş/geçmiş/arama/hafıza/indirme/export yüzeylerinde aynı dava
sınırı; kalıcı, tekilleştirilmiş ve iptal edilebilir işler; sağlayıcı sürüm bağları;
işler arası sağlık geçmişi; tam sayfalama ve disk/inode/kapanış kapıları. Kabul: planın izolasyon, işletim ve 3000 HTTP belge /
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
tamamen temizlemesinden önce gerçekleşebilir. Envanter yolu artık LEGAL-CRITICAL-019 kapsamında yalnız iş alanına yazar;
servis kendi doğruladığı baytları yayımlar ve yayın öncesinde kilidini denetler.
Genel kernel/cycle yolları için aynı dönüşüm ve eşzamanlı çoklu süreç kaybı
kabulü tamamlanmamıştır. Bu bulgu genel yazıcı güvencesi olarak açık kalır.

2026-09-06 hosted CI, olağan süre aşımında da eski süreç grubunu birlikte
öldürmenin monitör kapanışını namespace temizliğinden önce görünür kılabildiğini
gösterdi. Düzeltme yalnız namespace PID 1'e sinyal verir; monitör bütün çocuklar
bitene kadar kilidi tutar ve iş yanıtı gerçek kapanışı bekler. Monitörün `/proc`
dizin tanıtıcısı süreç başlatılırken sabitlenir; yardımcı bu tanıtıcı üzerinden
çocuk üyeliğini ve pidfd canlılığını doğrular. Kimlik/yardımcı desteği yoksa
korumasız grup öldürme veya erken iş tamamlama yoktur. Üç süreç ömrü testi ve
sunucu tip denetimi geçti; bağımsız inceleme bu dar sınırı onayladı. Bu düzeltme
servis ve monitörün birlikte kaybına ilişkin açık kabulü kapatmaz.

Konteyner kanıtı: mevcut Docker default profili namespace oluşturmayı reddetti.
`arias/legal/docker/apparmor.profile` yüklenmeden ayrıştırıldı; seccomp dosyası
sabit Moby kaynağından türetildi; iki console Compose servisi bu profilleri
zorunlu kılar. Yeni AppArmor profili paylaşılan host çekirdeğine yüklenmedi;
özel profille gerçek konteyner yürütme doğrulaması ve kurulum kapısı
LEGAL-CRITICAL-011 altında açıktır. Korumasız çalıştırma yolu eklenmedi.

<a id="principal-bootstrap-history"></a>

## LEGAL-CRITICAL-017

Kaybolan principal deposunun eski bootstrap kimliğini yeniden oluşturması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-06. Faz: 1.

İptal edilmiş kurulum kimliği, principal dosyası silinip servis eski seed ile
başlatıldığında yeniden oluşturulabiliyordu. Kabul: ilk kurulumda seed çalışır;
başlatılmış depoda dosya kaybı seed veya çevrimdışı add ile yeni yetki üretmez.
Geçerli eski depo kayıtları değiştirilmeden taşınır; bozuk başlangıç kaydı reddedilir.

Uygulama: principal dosyasının yanındaki `.initialized` kaydı yalnız sabit sürüm
ve başlangıç metadata'sı taşır. İlk principal yazımından önce exclusive oluşturulur,
dosya ve üst dizin diske eşitlenir. Geçerli başlangıç kaydıyla eksik depo, geçersiz
veya yarım kayıt, yeniden seed edilmez. Kurtarma özgün yetki dosyasını geri
getirmeyi gerektirir; çevrimdışı yönetim bu geçmişi sıfırlayamaz. Eski yedekten
iptallerin korunması hâlâ LEGAL-CRITICAL-011 kapsamındadır.

Kanıt: değişiklik öncesi üç yeni test başarısızdı; sonra 12 principal/yönetim
testi ve sunucu tip denetimi geçti. Bağımsız kod incelemesinde önemli sorun yok.

<a id="durable-intake-recovery"></a>

## LEGAL-CRITICAL-018

Eşzamanlı ve kesintiye uğramış belge alımının kalıcı uzlaştırılması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-06. Faz: 2.

Önceki alım aynı geçici adı paylaşabiliyor ve yayın hedefini ezebiliyordu.
İmzalı receiving/received/failed işlem defteri, özel geçici dosya, gerçek baytların
fsync'i ve üzerine yazmayan yayın uygulanır. Dava kuyruğu kurtarma, yeni alım ve
snapshot yakalamayı sıralar. Servis iş kabulünden önce bütün davaları uzlaştırır.
Bozuk imza/baş/bayt veya belirsiz işlem içerikleri korunur ve kabul durur;
yarım içerik başarılı alım sayılmaz. Dosya/dizin adı çakışmaları receipt yazılmadan
reddedilir; yarıda kalan ad çakışması kalıcı failed durumuna geçirilir.
Dava metadata'sı ile yeni dizinlerin üstleri diske eşitlenmeden dava kabul edilmez.

Kanıt: 40 alım testi; başlangıç uzlaştırması için iki test; bağımsız incelemenin
bulduğu ad topolojisi ve metadata kalıcılığı sorunları düzeltildi ve yeniden
incelendi. Kesilmiş defter otomatik yeniden imzalanmaz. Kalıcı iş kuyruğu ve
kapasite sınırları LEGAL-CRITICAL-006 kapsamında ayrıca açıktır.

<a id="isolated-inventory-publication"></a>

## LEGAL-CRITICAL-019

Envanter işçisinin dava snapshot'ı ve servisin doğrulanmış sonuç yayını.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-06. Faz: 1–2.

İşçi canlı arşiv ve sonuç alanı yerine yalnız kopyalanmış dava belgelerini okur;
girdi, çalışma profili ve kod salt okunur, çıktı özel iş alanındadır. Ortam
aktarılmaz; ağ/PID/dosya alanları ayrılır. Kapsam dışı belge baytları kopyalanmaz;
bunların alım kayıtları kapsama raporunda açık eksik olarak kalır. Kernel kayıt ve
çalıştırma yolu korunur; 8 MiB sınırlı JSON dosyası argv'deki belge listesinin
yerine geçer. Frozen profili ve QUARANTINED sonucu yayın engelidir.

Servis sekiz artifact'ı ve kernel zarfını; dava, hash, referans, kaynak kapsamı
ve snapshot özetiyle doğrular. Açık işçi tanıtıcılarının değiştiremediği ayrı
bayt kopyasını imzalı koşum manifestiyle yayımlar. Yayın öncesi özgün principal,
rol/kapsam/token, instance politikası, adapter kaydı/manifesti, çalışma profili,
kaynak/karar başları ve canlı kurulum kilidi yeniden denetlenir. Kaldırma kararı
snapshot alımı sırasında gelirse de yayın reddedilir. Kapsam sayaçları belge
kayıtlarından yeniden hesaplanır; okunamayan dosyanın kayıtlı olması metninin
okunduğu anlamına gelmez. Sürüm üyeleri/işaretçileri ve kopya sahipliği karşılıklı
doğrulanır. CLI'nin gerçek schema-1 yanıtı, runner/health alanları ve ham
stdout/stderr hash'leri denetlenir. Servis girdisinin hash'i ayrıca imzalanır;
kernel input_hash iç snapshot ile zenginleştirilmiş girdiye aittir ve kompakt
CLI snapshot'ından yeniden üretildiği iddia edilmez. Son kontrol ve
current değişimi arasında async boşluk yoktur. Okuyucular aynı imzalı koşuma
sabitlenir; bozuk mevcut pointer düz artifact'a dönüş sağlamaz.

Kanıt: gerçek kernel dahil 50 snapshot/işçi testi; 10 yetki/kilit testi; tek
istekte pointer değişimi için okuyucu testi; 7 Python CLI testi. Gerçek model
kullanılmadı. Kalıcı/tekilleştirilmiş/iptal edilebilir işler, kota/sayfalama ve
işler arası sağlık geçmişi LEGAL-CRITICAL-006 altında açıktır. Genel cycle yolu
LEGAL-CRITICAL-016; gerçek konteyner kabulü LEGAL-CRITICAL-011 altında kalır.

2026-09-06 konteyner kontrolü: hosted CI `34019440050` yerel hukuk adımı ve iki
imaj derlemesinden geçti; üç süreç testi `unshare: mount /proc failed: Operation
not permitted` ile kaldı. Worker için gerekli dar AppArmor/seccomp izinleri ve
runner bağımlılıkları eklendi; profil sözdizimi, JSON/YAML/shell kontrolleri ve
root olmayan seccomp süreç denemesi geçti. Docker'ın sistem yolu maskeleri
korunur. Pozitif konteyner kabul testi atlanmaz veya beklenen hata testine
çevrilmez; başarısızsa kapı kırmızı kalır. Özel profille gerçek konteyner başarısı
kanıtlanana kadar LEGAL-CRITICAL-011 açık ve dağıtım kabulü engellidir.

Son yerel birleşik doğrulama (2026-09-06): `new-aria/` altında `npm run
legal:check` sıfır çıkışla tamamlandı: 235 sunucu ve 72 arayüz testi; sunucu/web
tip denetimleri ve derlemeleri; adapter kapıları ve 3 davalık küçük korpusta
4/4 beklenen bulgu, precision=1.000/recall=1.000. Ayrı 7 Python CLI testi geçti;
Nx affected test/lint görev bulmadı. Bağımsız snapshot incelemesi, beş düzeltmenin
ardından 69/69 testle dar yayın sınırını onayladı. Arayüzdeki profil testi,
`/me` sonrası `/overview` yanıtını kontrollü React `act` adımlarıyla bekler;
süre sınırı uzatılmadan görünür değerler ve yetki sırası korunur.

<a id="case-scoped-signin"></a>

## LEGAL-HIGH-020

Dava kapsamlı avukatın arayüze giriş yapamaması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-06. Faz: 1.

Gerçek derleme önizlemesinde, çevrimiçi yönetim API’siyle oluşturulmuş ve yalnız
bir davaya atanmış avukat giriş ekranında 403 aldı. `validateToken`, genel
operator yetkisi gerektiren `/overview` yoluna bağlıydı. Kabul: aday kimlik
`/me` üzerinden doğrulanır; reddedilen token saklanmaz. Avukat normal girişten
sonra yalnız yetkili dava gezinmesini görür; genel çekirdek izni genişletilmez.

Kanıt: gerçek form ve istemci yolunda operator/avukat girişi ile bekleyen, 401
ve 503 yanıtlarında tokenın saklanmaması sınanır. Dört yeni senaryo düzeltmeden
önce başarısız oldu; düzeltmeden sonra ilgili 23 test ve tüm 76 arayüz testi
geçti. Web tip denetimi ve üretim derlemesi de geçti.
Üretim derlemesinin gerçek tarayıcı önizlemesinde avukat normal giriş formunu
kullandı; `/me` ve yetkili dava listesi 200 döndü, genel `/overview` istenmedi.

<a id="legal-ci-portability"></a>

## LEGAL-HIGH-021

Hukuk CI doğrulamasının bağımlılık ve root kullanıcı varsayımları.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-06. Faz: 0–1.

Hosted koşum `34023689778`, 235 sunucu testinin 231’ini geçti. İki gerçek işçi
testi `new-aria/node_modules` kurulmadığı için; bir artifact bütünlük testi de
salt okunur sentetik dosyayı root varsayımıyla değiştirmeye çalıştığı için kaldı.
Kabul: CI bağımsız paketin gerçek bağımlılıklarını kurar; test kendi sentetik
artifact hazırlığını root olmayan kullanıcıda yapar ve imza/hash reddi
iddiasını korur. Dördüncü hata, namespace süre aşımı sonrasında gözlenen yazıcı
ömrü sınırıdır ve LEGAL-CRITICAL-016 kapsamında ayrıca incelenir. Bu koşum
imaj/konteyner adımlarına ulaşmadı; LEGAL-CRITICAL-011 açık kalır.

Bağımlılık kurulumu temiz örnek dizinde doğrulandı. Yayın testlerinin 48’i
uid 65534 ile geçti; readonly dosya modu ve değiştirilmiş artifactın imza/hash
reddi korunur. Sunucu tip denetimi ve workflow yapısı doğrulandı.

<a id="managed-claude-auth-preflight"></a>

## LEGAL-HIGH-022

Claude yönetilen oturum ön kontrolünün ayar dosyasını giriş kanıtı sayması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-07. Faz: P0-A.

`new-aria/tools/aria-poc/claude_runtime.py` içindeki eski ön kontrol, yalnız
`config.json` veya `.credentials.json` varlığından oturumu hazır kabul ediyordu.
Boş ayar dosyası gerçek oturum kanıtı değildir. Yerel kurulu CLI 2.1.261
`claude auth status` destekliyor; bu komut çıkarım başlatmadan yerel kimlik
biçimini bildiriyor. Komutun resmi sözleşmesi:
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Kabul: varsayılan yönetilen yol için CLI'ın yapılandırılmış yerel durumunda `loggedIn=true`, yönetilen
`claude.ai` yöntemi ve `firstParty` sağlayıcısı doğrulanır. Eksik/bozuk durum,
başka kimlik yöntemi, süreç hatası veya süre aşımı çıkarım başlamadan reddedilir.
Hesap alanları ve ham auth çıktısı kullanıcıya veya hata zincirine taşınmaz.
Açık dry-run atlama sonucu `ok` olarak gösterilmez.

Bağımsız inceleme ilk değişiklikte iki ek durum buldu: geçersiz auth çıktı
kodlaması ve genel runtime'ın zaten yetkilendirilmiş Z.ai yolunun yönetilen
girişe bağlanması. İkinci durum için kabul, seçilen sağlayıcının kendi mevcut
politika/kimlik koşullarını denetlemektir. Alternatif yolun yerel ayarı
`route_configured` olarak bildirilir; yönetilen oturum veya gerçek sağlayıcı
erişimi kanıtı sayılmaz. Genel dispatch'in mevcut yeniden deneme sözleşmesi
korunur. Hukuk ürününün yalnız yönetilen Claude kullanma koşulu devam eder.

2026-09-07 oturum kurtarma doğrulaması: runtime ve CI yürütücüsünün SHA-256
değerleri kesilen oturumun teslim kaydıyla aynı. Agent-env invariantını da içeren
dokuz Python modülünün kayıtlı regresyon komutu yeniden çalıştırıldı:
147 test ve 28 alt test, çıkış 0. İkinci bağımsız inceleme önceki iki kod
bulgusunu giderilmiş buldu; zorunlu tüketici senaryolarında eksik test kapsamı
saptadı. Tüketici kapsamı tamamlandıktan sonra bağımsız kapsam ve kalite
incelemesi kabul verdi: açık kod veya test bulgusu kalmadı.

Son kapsamlı komut 166 test ve 45 alt testle çıkış 0 verdi. İki CI girişinde
gerçek profil/ön kontrol, iş almadan ret, worker model aktarımı, yetkisiz
yeniden denemenin reddi ve bozuk karakterlerle gelen hesap bilgisinin
gizlenmesi doğrulandı. Ayrı çalışma kopyasında ilgili davranışların kaldırılması
beklenen test hatalarını üretti; çalışan kaynak ağacı değiştirilmedi.
Yeniden çalıştırma, `new-aria/` içinde:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:aria-kernel python3 -m pytest -q \
  aria-kernel/tests/test_auth_consumer_routes.py \
  aria-kernel/tests/test_claude_auth*.py \
  aria-kernel/tests/test_provider_redirect.py \
  aria-kernel/tests/test_credit_fallback.py \
  aria-kernel/tests/test_claude_runtime_contract.py \
  aria-kernel/tests/test_environment_contract.py \
  aria-kernel/tests/invariants/v12/test_phase_v12_b_agent_env.py \
  aria-kernel/tests/test_ci_executor*.py
```

Etkin kök `.github/workflows/new-aria-legal.yml`, iç runtime/çekirdek/süit
yollarında PR ve push ile tetiklenir; mevcut süit çalıştırıcısıyla 10 runtime
test modülünü seçer. Aynı komut yerelde 158 unittest testiyle çıkış 0 verdi;
pytest bölümü aynı 158 testi tekrar çalıştırmadı. Yerelde `/opt/venv` olmadığı
için Python 3.12.3 kullanıldı; hosted kurulumun çalıştığı henüz kanıtlanmadı.
İş akışının YAML kapsamı doğrulandı; `actionlint` kurulu olmadığı için çalışmadı.
Kanıtlar `.superpowers/sdd/YOL-HARITASI/task-p0-auth-fix2-*` ve
`task-p0-ci-*` kayıtlarında; canlı model, imaj veya dağıtım kabulü değildir.

Bu bulgu yerel ön kontrolün doğruluğuyla sınırlıdır. Gerçek model cevabı,
sağlayıcı erişiminin geçerliliği, kimlik yenileme, rootless runner ve harcama
rezervasyonu ayrı P0 kabulleridir; dosya/CLI durumunun olumlu olması bunları kapatmaz.

<a id="legal-analysis-readiness"></a>

## LEGAL-HIGH-023

Mekanik envanterin hazır olması ile gerçek AI analizinin bağlı olmasının ayrılmaması.

Durum: IN-PROGRESS. Sahip: Codex. Hedef: 2026-09-07. Faz: P0-B.

Başlangıçta `/api/v1/health` yalnız hukuk envanter adapter'ının kayıt durumunu
bildiriyordu; legal compose profili de modeli mock varsayılanıyla başlatıyordu. Kayıtlı envanter,
gerçek modelle dava analizinin bağlı olduğuna kanıt değildir.

Kabul: sunucu ve İngilizce belge alım ekranı bağımsız analiz kullanılabilirliği
bildirir. Mock açık veya gerçek analiz henüz bağlı değilken analiz hazır sayılmaz;
belge alımı ve mekanik envanter kendi yetki/kayıt koşullarıyla kullanılabilir.
Üretim legal profilinde mock varsayılanı kapalıdır. Env bayrağı açılması veya
kapanması tek başına “gerçek analiz hazır” sonucu üretemez.

2026-09-07 yerel kanıt: yeni HTTP testleri önce 2 hata, yeni ekran testleri önce
2 hata verdi; uygulamadan sonra hedefli 37 sunucu ve 9 ekran testi geçti.
Bağımsız incelemede bulunan yeni testteki yasak çift tip dönüşümü kaldırıldı;
değişen HTTP testlerinin 2'si ve sunucu tip denetimi yeniden geçti. Birleşik
`npm run legal:check` çıkış 0: 237 sunucu, 78 arayüz testi, iki tip denetimi,
iki derleme ve adapter/korpus kontrolleri. `npm run aria:instances:test` 4/4
geçti. Compose çözümlemesi yalnız ilgili alanı okuyarak legal-ui mock
varsayılanının `0` olduğunu doğruladı; sır veya gerçek veri kullanılmadı.

Şema ve tüketici birlikte değişti: `HealthResponse.legalAnalysis` zorunlu
alanı yalnız `unavailable` durumunu temsil eder. İngilizce ekranda gerekçe
anlaşılır metne çevrilir. Bağımsız kapsam/kalite yeniden incelemesi geçti.
Test kayıtları ve bağımsız inceleme,
`.superpowers/sdd/YOL-HARITASI/task-p0-readiness-*` altında saklanır.

Kesilen oturumdan sonra aynı çalışma ağacında `npm run legal:check` yeniden
çıkış 0 verdi: 237 sunucu ve 78 arayüz testi, tip denetimleri, derlemeler ve
adapter/korpus kontrolleri geçti (`resume-legal-check.log`). Zorunlu Nx test/lint
komutları da çıkış 0 ile tamamlandı; etkilenen Nx projesi bulunmadığından
`No tasks were run` sonucu verdi. Bu sonuç hukuk testinin yerine geçmez.
Önceki Nx eklenti zaman aşımı, eklentileri aynı süreçte çalıştıran ve bu plana
ait ayrı önbellek kullanan çağrıyla aşıldı; hiçbir eklenti veya kontrol çıkarılmadı.

Bu bulgu yalnız kullanılabilirliğin doğru sunulmasını kapsar. Eski 8480 kurulumunda
örnek veri göçü yapılmış sayılmaz; gerçek AI analizi, runner, bütçe ve canlı geçiş
P0/P6 kabulü tamamlanmadan etkinleştirilmiş olarak raporlanmaz.
