# Hukuk ARIA — uçtan uca MVP uygulama planı

> Uygulayıcı ajanlar: işleri aşağıdaki bağımlılık sırasıyla yürütün; uygulama için
> `superpowers:subagent-driven-development` veya `superpowers:executing-plans` kullanın.
> Her kapı UI, servis, kalıcı durum ve kabul kanıtıyla kapanır.

**Amaç:** Avukatın arşivi ve hukuk kurallarını UI'den yüklediği, kaynakları inceleyip
analizi düzelttiği ve bu düzeltmeyi sonraki soruda hatırlayan uçtan uca hukuk sistemi.

**Mimari:** Mevcut ARIA çekirdeği ve tek imzalı yayıncı korunur. Dava kaynakları,
çıkarımlar, kurallar ve avukat kararları tek değişmez dava sürümüyle okunur. Kalıcı
iş deposu yürütmeyi, kaynaklar ve imzalı kararlar dava bilgisini taşır; arama indeksi
bunlardan yeniden oluşturulur.

**Teknoloji:** Mevcut Node/TypeScript servis, React UI ve Python ARIA/Claude Code yolu;
yeni kalıcı iş deposu SQLite. Mevcut UI gereksinimi Node >=22.18.0, npm >=10.0.0.
Rootless OCI/Podman çalışma yolu P0'da gerçek sunucuda doğrulanacak tasarım adayıdır.

**Ürün tanımı:** [TANIM](TANIM.md). **Kod durumu:** [YETENEK-KAYDI §C](YETENEK-KAYDI.md#c-güncel-uygulama-sırası-2026-09-06).
**İnceleme:** [Dört ajan, 23 bulgu](../../../../docs/reviews/codex/2026-09-07-legal-e2e-plan-review.md).

Güncelleme: 2026-09-07; kod tabanı `c6d287a3f`. Bu belge önceki dört haftalık planın
yerini alır; tamamlanmış uygulama beyanı değildir. Önceki CI konteyner başarısızlığı
konuşma kaydındaki tarihsel kanıttır; bu incelemede güncel CI veya canlı kurulum denenmedi.

## 1. Değişmeyen ürün koşulları

- İlk pilot mevcut sunucuda, bir büro, birden çok dava ve isimli kullanıcılarla çalışır.
- Hedef giriş adresi `https://legal.suderra.com`; kurulum ve geçiş P6 teslimidir.
- Avukat UI'si, hatalar, düğmeler ve rapor anlatımı İngilizcedir; kaynak ve alıntılar özgün dilindedir.
- Arşiv **ve** hukuk kuralları UI'den yüklenir. Gerçek belgeyi geliştirici CLI ile yerleştirme pilot kabulü değildir.
- Ürün web'den hukuk aramaz; yalnız yüklenmiş kaynakları kullanır. Modelin ön bilgisi hukukî dayanak yerine geçmez.
- Mevcut Claude Code kullanılacak. Üretimde mock/seed sonucu veya sessiz sağlayıcı değişimi olmaz.
- Boş kurulum dava ve analiz uydurmaz. Claude hazır değilse belge alımı sürer; analiz kullanılamıyor durumu görünür.
- İnsan onayı model tarafından yazılamaz. Otomatik mahkeme gönderimi yoktur.
- NOK 5 milyonluk dava doğrulama vakasıdır. M7 için büroca kontrol edilmiş anonim ikinci dava gerekir;
  otomatik anonimleştirme veya üç ayrı pazar ürünü geliştirmek ilk MVP kabulünün şartı değildir.
- Mevcut bütçe tavanları korunur: koşu $0,50, günlük $10, aylık $200. Bunlar depo içi
  bütçe politikasının değerleridir; Claude aboneliğinin fatura fiyatı beyanı değildir.

## 2. İnceleme sonrasında değişen sıra

En büyük değişiklik gerçek Claude ve ilk avukat döngüsünün erkene alınmasıdır.
OCR/kural analizi için paket kapsamı, hafızanın karar modeli ve silinebilir içerik sınırı
veri birikmeden tanımlanır. İngilizce kullanıcı akışı her aşamada teslim edilir.

| Kapı | Hedef zaman | Gösterilecek sonuç | Bağımlılık |
|---|---|---|---|
| P0 | 1. haftanın başlangıcı | Gerçek Claude, bütçe ve çalışma ortamı küçük arşivde kanıtlanır | Temsilî küçük girdi; operatörün Claude erişimi |
| P1 | 1. hafta | Tek dava sürümü, kalıcı iş/yayın ve karar/kaynak sözleşmeleri | P0 |
| P2 | 1. hafta | Boş kurulumdan UI ile dava, arşiv ve kural yükleme; tarayıcıdan devam | P1 |
| P3 | En geç 2. hafta sonu | Küçük davada kaynak → gerçek analiz → düzeltme → yeniden başlatma → soru → rapor | P2 |
| P4 | 2–3. hafta | Tam karma arşiv, sayfalama, kronoloji ve içerik sürüm farkı | P1–P3; çıkarıcı işleri P2 ile paralel olabilir |
| P5 | 3. hafta | Olaya bağlı kurallar, süreç/sorumluluk, karşı kanıt, tam dava raporu | P3–P4 |
| P6 | 4. hafta | Silme/geri yükleme, isimli giriş ve kontrollü canlı geçiş | P1–P5 |
| P7 | 4. hafta | Sekiz sonuç iki davada, bağımsız ölçüm ve avukat kabulü | P3–P6 |

Haftalar teslim hedefidir; P0 ölçümünden sonra kapasite ve girdi durumuyla takvim
netleştirilir. Bir kapı başarısızsa sonraki kabul tarihi değişir; mock sonuç veya daha
kolay veriyle o kapı geçmiş sayılmaz. Canlı geçiş öncesi ayrı kurulumda pilot yapılır;
geçiş sonrası P7'nin kullanıcı akışı yeniden çalıştırılır.

## 3. Ortak veri ve tutarlılık sözleşmesi — P1'de tamamlanır

Aşağıdaki adlar **yeni tasarım sözleşmeleridir**, mevcut API'de var oldukları iddia edilmez.
Şema, üretici, yayın doğrulayıcı, okuyucu ve UI aynı değişiklikte sürümlenir.

| Sözleşme | İçerik ve değişmez kural |
|---|---|
| `SourceContent` | Orijinal baytın hash'i ve boyutu; tekrar teslimden bağımsız içerik kimliği |
| `SourceOccurrence` | Dava, teslim, yükleme grubu, kaynak rolü, özgün ad, ebeveyn e-posta/ZIP/ek ilişkisi; bilinmeyen yazar veya teslim zamanı bilinmeyen kalır |
| `ExtractionRevision` | Çıkarıcı/model sürümü, orijinal hash, bölüm bazında tam/kısmi/okunamayan durum, metin ve özgün konum eşlemesi; OCR orijinali değiştirmez |
| `CaseRevision` | İmzalı manifest: kaynak ve çıkarım başları, analiz başı, kural külliyatı ve uygulanabilirlik kararları, karar zinciri başı, şema/üretici sürümleri |
| `Proposition` | Söyleyen kişi, çıkarım yöntemi, önerme, destek/karşı kanıt, ihtilaf durumu ve inceleme durumu ayrı alanlar; bir alıntının doğruluğu olayın doğruluğu değildir |
| `Decision` | Sabit hedef, karar türü/kapsamı, beklenen dava sürümü, aktör, gerekçe içeriği referansı, yerine geçtiği veya geri aldığı karar kimliği |
| `RuleApplication` | Konu/iddia, ilgili olay ve zamanı, yetki alanı, kaynak türü, madde/sürüm, geçiş hükmü, dayanak olgular, varsayımlar ve avukat kararı |
| `JobAttempt` | İş/deneme kimliği, sabit girdi sürümü, yetki dönemi, kira nesli, kaynak/bütçe rezervasyonu, çıktı manifesti ve yayın kimliği |
| `RemovalOperation` | Hedef, hemen erişim dışı bırakma, çalışan işleri durdurma, türev temizliği, tamamlanma kanıtı ve geri yükleme için kalıcı işaret |

Bütün okuma, arama imleci, worker bağlamı ve rapor aynı `CaseRevision` kimliğine bağlanır.
Yeni yayın, beklenen güncel baş ve yetkiyi karşılaştırıp başı atomik ilerletir. Eski
sürüme onay/yayın denemesi 409 ile durur. Eski sürüm yalnız açık tarihsel etiketle
okunur; güncel erişim iptali ve silme kuralları tarihsel okumaya da uygulanır.

Kararların güncel durumunu bütün doğrulanmış karar geçmişini işleyen **tek deterministik
indirgeme** belirler; arama sıralaması bunu belirleyemez. Düzeltme içerik taşır;
gerekçeyi modelin yorumlayıp uygulaması karar semantiği değildir. Sonraki karar öncekinin
kimliğini açıkça belirtir. Geri alma eski kararı kendiliğinden yeniden etkinleştirmez:
hedef yeniden incelemeye açılır; eski sonuca dönmek ayrıca açık bir karardır.
Eşzamanlı karşıt kararlar sürüm çatışması üretir. Birleştirme geri alınınca sabit özgün
kimlikler geri ayrılır ve bağlı sonuçlar yeniden değerlendirilir.

İnceleme kapsamları ayrıdır: metin aktarımı, kişi atfı, olgusal önerme, kural uygulanması,
rapor paylaşımı. “Alıntı doğru” onayı ihtilafı ve karşı delili kaldırmaz.
Aynı eki dört kez yüklemek dört bağımsız doğrulama sayılmaz; ortak köken korunur.

İmzalı denetim ile silinebilir içerik sınırı P1'de kurulur. Dosya adı, not, gerekçe,
model cevabı ve alıntı silinebilir içeriktir; değişmez tutanak yalnız onaylanmış asgari
kimlik/taahhütleri tutar. Taahhütler de erişim ve saklama politikasına tabidir.
Eski imzalı içerikli tutanaklar sessizce yeniden yazılmaz; sürümlü göç ve saklama kararı
kaydedilir. Kaynak, türev ve runner bağlamı silinmeden işlem tamamlandı denmez.

## 4. Uygulama işleri ve kabul kanıtı

Dosya yolları aşağıda `new-aria/` altına göredir; başında başka kök yazılanlar hariçtir.
Yeni dosyalar sorumluluğu belirtilen plan hedefleridir. Her işte önce belirtilen davranışın
başarısız testi yazılır, kök sözleşme/üretici/tüketici birlikte uygulanır, hedefli test ve
ilgili birleşik kontrol çalıştırılır. Uygulama commit'leri ilgili açık bulguya atıf yapar;
kancalar atlanmaz, her commit aktif dala push edilir.

### P0 — Gerçek model, bütçe, paket kapsamı ve pilot girdileri

**Dosyalar:** `tools/aria-poc/{ci_executor,claude_runtime}.py`,
`aria-kernel/aria_kernel/{implementation_safety,agent_invocations,evidence_trust,cost_budget}.py`,
`packs/legal/pack.json`, `packs/legal/agents/*.md`, `packs/legal/schemas/*.json`,
`arias/legal/{aria.manifest.json,config/budget.json,config/approval-policy.json,docker/compose.profile.yml}`.
**Testler:** yeni `ui/server/test/legal-runtime-acceptance.test.ts`; ilgili mevcut Python invariant testleri.
**Sahip:** Runtime + çekirdek sorumlusu; girdiler için pilot avukat. Bulgular 001–003, 005, 013–014.

**2026-09-07 uygulama kaydı:** P0-A'nın yerel kimlik/sağlayıcı ön kontrolü ve
tüketici testleri bağımsız incelemeden geçti: 166 Python testi ve 45 alt test.
P0-B'nin envanterden ayrı analiz kullanılabilirliği kabul edildi; birleşik hukuk
kontrolü 237 sunucu ve 78 arayüz testi, tip denetimleri, derlemeler ve adapterlerle
yeniden geçti. Runtime testleri etkin kök CI iş akışına bağlandı; aynı komut
yerelde 158 unittest testi çalıştırdı. Bulgu ve komut kayıtları
[LEGAL-HIGH-022/023](../../../../docs/reviews/codex/2026-09-05-legal-production.md#managed-claude-auth-preflight)
içindedir. **P0 bütünü açık:** gerçek model, harcama rezervasyonu, hedef runner
ve pilot girdileri henüz kabul edilmedi. Aşağıdaki ana kapılar işaretlenmez.

- [ ] Yönetilen Claude girişi → çıkarım → kanıt değerlendirmesi → karşı kanıt → imzalı
  arşiv sonucu zincirini küçük karma pakette gerçek modelle çalıştır.
- [ ] 400k giriş/64k çıkış sabit rezervasyonunu gerçek uygulanabilir bağlam/çıktı sınırıyla
  uyumlu hale getir. Her denemeyi harcamadan önce ayır, sonra kullanımla uzlaştır;
  bilinmeyen model maliyetini sıfır sayma. Yeniden denemeler de bütçeden düşer.
- [ ] Runtime'a güvenilir runner yapılandırmasından seçilen açık yalıtım backend sözleşmesi
  ekle. OCI seçimi mevcut iç `bwrap`/`systemd-run` yoluyla birlikte tasarlanır;
  yalnız dış konteyner eklemek veya korumayı kapatan bayrak koymak entegrasyon değildir.
- [ ] Gerçek işte etkili CPU/bellek/süreç/süre sınırlarını ölç. Başlangıç hedefi bir etkin
  iş, 100 bekleyen iş; parça başına 1 CPU/2 GiB/128 süreç/10 dakika. Host ve disk payını
  ölçmeden bu rakamları kapasite garantisi olarak kullanma. Yalnız timeout yeterli değildir.
- [ ] Claude kimliği kurulum/yenileme/sona erme ve sağlayıcı bekleme durumlarını tanımla;
  sırları dava iş alanına, loga veya imaja yazma. Mekanik iş ağsız; Claude yalnız
  onaylı sağlayıcı erişimiyle çalışır. Ürün hukuk web araması açmaz.
- [ ] OCR ve kaynaklı kural/yükümlülük adaylarını paket kapsamına al; kanıt yargıcının
  “belge bunu söylüyor” görevini hukuk değerlendirmesiyle birleştirme. İnsan doğrulaması,
  eksik dayanakta çekinme ve otomatik dosyalama yasağı korunur.
- [ ] Pilot girdi kaydını UI yükleme akışının parçası olarak planla: arşiv biçim/boyut
  dökümü, dışlamalar, kural sürümleri, görevler, etiket sorumlusu ve anonim ikinci dava
  sorumlusu. İsimli sorumlular ve tarihleri başlangıçta kaydet; hazır olduklarını varsayma.

**Kabul:** Gerçek sunucudaki hedef imaj bir işi sınırlar içinde tamamlar; kimlik/bütçe
hazır değilse açık durur. Ölçülen süre/tüketimden ilk dava, tekrar analiz, değerlendirme
ve ikinci dava için kapasite tahmini çıkarılır. Sentetik deneme mühendislik kanıtıdır;
pilot girdileri gelmediyse gerçek dava kabulü açık kalır.

### P1 — Kalıcı işler, yayın ve ortak dava modeli

**Dosyalar:** `ui/shared/legal-contract.ts`, `ui/server/src/{legal-intake,legal-runs,legal-worker,decisions,decisions-overlay,case-authority}.ts`,
`ui/server/src/readers/legal.ts`; yeni `ui/server/src/{legal-job-store,case-revision,decision-state}.ts`.
**Testler:** mevcut `legal-intake-durability.test.ts`, `legal-runs.test.ts`, `case-authority.test.ts`;
yeni `legal-job-store.test.ts`, `case-revision.test.ts`, `decision-state.test.ts` aynı server test dizininde.
**Üretir:** §3 sözleşmeleri ve sürümlü yayın/okuma. **Sahip:** Yayın + hafıza sorumlusu. Bulgular 007–012, 015.

- [ ] §3 veri modelini ve eski kayıt göçünü üretici, okuyucu, şema ve karar indirgemesinde uygula.
- [ ] Kalıcı durumları kur: `receiving → received → queued → running → result_ready → published → completed`;
  ayrıca başarısız, bekleyen, iptal ve yeniden deneme durumlarını nedenleriyle sakla.
- [ ] Kabul edilmiş imzalı alım kaydı enqueue yükümlülüğünün kaynağı olsun. Kurtarma eksik
  kuyruğu aynı işlem kimliğiyle oluşturur; benzersiz anahtar ikinci görünür işi önler.
  İşçi en az bir kez çalışabilir; model çağrısı için “tam bir kez” garantisi verilmez.
- [ ] Worker kira nesli ve sabit girdi sürümüyle sonuç versin. Tek yayıncı sonucu doğrulayıp
  imzalı görünür başı ilerletsin; iş deposu bu yayın kimliğinden tamamlandı durumunu kurtarsın.
- [ ] İptal/silme/yetki iptalini yayınla aynı sıralama sınırında değerlendir. Önce iptal
  kesinleşmişse geç worker yayımlayamaz; önce yayın kesinleşmişse iptal bunu geri alınmış
  gibi göstermez, sonraki erişim/silme işlemi ayrı kaydedilir.

**Kabul:** Her kalıcı geçişte kontrollü kesintiyle tekrar başlat; kabul edilmiş dosya
tek görünür yayın üretir, yayımlanmış iş tamamlandıya uzlaşır. Eski kira veya sürümle
sonuç yayımlanmaz. Yeni kural, karar veya aynı baytlara yeni çıkarım sürümü eski onayı
sessizce taşımamalıdır. Sayfalama ve rapor aynı sabit sürümü okumalıdır.

### P2 — İngilizce giriş, dava oluşturma, iki ayrı yükleme akışı

**Dosyalar:** `ui/server/src/{routes,principal-admin,principals,legal-intake}.ts`,
`ui/web/src/app/{LoginPage,router}.tsx`, `ui/web/src/app/permissions.ts`,
`ui/web/src/api/{legal-client,token-store}.ts`, `ui/web/src/features/legal/{CasesPage,IntakeTab,CaseDetailPage}.tsx`;
yeni `ui/web/src/features/legal/RulesTab.tsx`.
**Testler:** `ui/server/test/legal-routes.test.ts`, ilgili mevcut UI testleri;
yeni `ui/web/src/features/legal/CasesPage.test.tsx`, `RulesTab.test.tsx`.
**Tüketir:** P1 kalıcı grup/iş ve yetki sözleşmeleri. **Sahip:** UI + kimlik sorumlusu. Bulgular 018–019, 021.

- [ ] Normal avukat girişini Cases ekranına götür; kurtarma metni sorumlu kişiye yöneltsin,
  ortam değişkeni/CLI talimatı göstermesin. Dava kimliğini servis üretsin; oluşturma ve
  yetkili oluşturana atama kurtarılabilir tek işlem olsun. Atama başkasının davasını açamaz.
- [ ] `Case documents` ve `Legal rules` ayrı kaynak rolleri, yükleme grupları ve tamamlama
  düğmeleri taşısın. Dosya/klasör/ZIP alımı özgün yapı ve teslim ilişkisini korusun.
- [ ] Arşiv tamamlanınca olgusal düzenleme başlasın. Kural yoksa `Rules needed` görünsün;
  hukuk değerlendirmesi yapılmış gibi sonuç sunulmasın. Kurallar sonradan eklenip değiştirilebilsin.
- [ ] Dosya başına yükleniyor/kabul edildi/başarısız durumunu anında göster. Kalıcı grup ve
  işleri davayı açarken geri getir. Tarayıcı dosya izni kaybolmuşsa kalan dosyaları yeniden
  seçmeyi iste; kabul edilmiş baytları tekrar yüklenmesi gereken baytlardan ayır.

**Kabul:** Boş üretim profili sıfır dava/sonuç gösterir. Normal kullanıcı CLI olmadan dava,
arşiv ve kuralları yükler. Sekme değişimi, yenileme, bağlantı kaybı ve servis yeniden
başlamasında kabul edilmiş dosyalar ve iş durumu korunur; tekrar deneme çoğaltmaz.

### P3 — Küçük davada gerçek avukat döngüsü

**Dosyalar:** `ui/shared/legal-contract.ts`, `ui/server/src/{routes,decisions,decisions-overlay}.ts`,
`ui/web/src/features/legal/{StatementsTab,DocumentsTab,legal-badges}.tsx`;
yeni server `legal-sources.ts`, `legal-answers.ts`, `legal-reports.ts` ve
UI `SourceViewer.tsx`, `ReviewPanel.tsx`, `QuestionsTab.tsx`, `CaseReportPage.tsx`.
**Testler:** yeni `ui/server/test/{legal-sources,legal-answers,legal-reports}.test.ts`;
yeni `ui/web/src/features/legal/{SourceViewer,ReviewPanel,QuestionsTab,CaseReportPage}.test.tsx`.
**Tüketir:** P0 gerçek model, P1 karar/sürüm, P2 yükleme. **Sahip:** UI + hafıza sorumlusu. Bulgular 006–009, 020, 022–023.

- [ ] Kaynak yanında kapsamı açık düzeltme/onay/itiraz/geri alma, gerekçe ve geçmiş göster.
  OCR aktarım düzeltmesi, olgu düzeltmesi ve yorum uyuşmazlığını ayrı işlemler yap.
- [ ] Güncel karar indirgemesini UI, worker, arama, soru-cevap ve raporda ortak kullan.
  İndeks/özet kaynak kayıtlarından yeniden kurulabilsin; türetilmiş cevap yeni bağımsız delil sayılmasın.
- [ ] Kaynaklı cevapta destek, karşı kanıt ve okunmamış alanlar görünsün. Yeni kaynak ve karar
  bağımlı cevapları yeniden incelemeye açsın. Karar geri alma eski onayı aramayla geri getirmesin.
- [ ] Küçük kaynak kümesinde İngilizce dava çalışma raporu önizleme ve PDF indirme sağla;
  dava/sürüm, inceleme kapsamı, açık sorunlar, özgün alıntılar ve kaynak listesi içersin.
  PDF'de dosya adı ve konum basılı görünür; bağlantılar yetkili kaynak ekranına gider,
  token taşımaz. Dışarı indirilmiş kopya sonradan geri çağrılmış sayılmaz.

**Kabul:** Pilot avukat yükler → kaynağı açar → yanlış olay tarihini düzeltir → sistemi
ve indeksleri yeniden başlatır → farklı ifadeli ve olumsuz soru sorar → güncel kaynakla
cevap alır → rapor indirir. Aktarım onayı verilmiş karşı taraf iddiası hâlâ atfedilmiş
ve ihtilaflı görünür. Düzeltmeyi değiştirme/geri alma ve kişi birleştirmeyi geri alma
bütün yüzeylerde aynı sonucu verir. Geliştirici yardımı ve görev süresi kaydedilir.

### P4 — Karma arşiv, kronoloji, sürümler ve eksiksiz kaynak görüntüleme

**Dosyalar:** `packs/legal/adapters/{legal-document-inventory,legal-records}.ts`,
`packs/legal/adapters/binary/{extract,ooxml,pdf-document,pdf-text}.ts`,
`packs/legal/adapters/records/{fact-index,version-diff,party-candidates}.ts`,
`ui/server/src/readers/legal.ts`, P3 kaynak servisi/UI ve `TimelineTab.tsx`.
**Testler:** mevcut binary/records testleri; yeni `ui/server/test/legal-pagination.test.ts`
ve `ui/web/src/features/legal/SourceViewer.test.tsx` karma biçim senaryoları.
**Sahip:** Belge alımı + UI sorumlusu. Bulgular 012, 020–021; M1, M2, M4.

- [ ] PDF, tarama/görüntü, DOCX, XLSX, PPTX, EML, TXT, CSV için bölüm kapsamı sakla.
  Yerel OCR'da Norveççe/İngilizce desteği ve çıkarım kökeni doğrulansın; karakter sınırına
  ulaşmak tam okuma sayılmasın. Şifreli/desteklenmeyen/kısmi belgeler açık görünsün.
- [ ] E-posta gövdesi, ekler/yanıt ilişkileri; DOCX eklenen/silinen metin ve yorumları koru.
  Olay zamanı, belge tarihi, tarafın bilgilenme zamanı ve `Received by ARIA` ayrı olsun.
- [ ] Sabit dava sürümüne bağlı sayfalama/arama ile bütün belge, olay ve farklara eriş.
  Kimlik çakışması, yanlış tarih eşleme ve ilgisiz belgelerin bağlanması kök veride düzelsin.
- [ ] Sürüm ailesini içerik/kimlik ilişkisiyle öner; avukat düzeltsin. İki taraflı metin,
  tablo ve izlenen değişiklikleri göster. Dosya adındaki “signed” imza kanıtı değildir.
- [ ] Tek atıf bileşeni bütün destek/karşı kaynak listesini açsın: PDF sayfa/alan;
  DOCX paragraf/tablo/değişiklik; XLSX sayfa/hücre; PPTX slayt; EML gövde/ek; TXT/CSV
  satır/alan. Dönüştürülmüş görünüm kökenini göstersin; orijinal indirme mevcut olsun.

**Kabul:** UI'den 3.000'den fazla karma belge ve 20.000'den fazla olayda eksiksiz erişim;
4.000 satırı aşan, yeniden adlandırılmış sürümlerde tam fark. Beşinci karşı atıf dahil
her kaynak açılır. Aynı ekin doğrudan/e-posta/ZIP teslimleri korunur ama bağımsız delil
sayısı artmaz. Aynı adlı farklı baytlar ayrılır. Hacim deneyi ile anlamsal kalite ayrı raporlanır.

### P5 — Kurallar, süreç/sorumluluk ve tam çalışma raporu

**Dosyalar:** `packs/legal/agents/*.md`, `packs/legal/schemas/*.json`,
`ui/shared/legal-contract.ts`, yeni `ui/server/src/{legal-rules,legal-processes}.ts`,
P3 cevap/rapor servisi; `RulesTab.tsx`, yeni `ProcessTab.tsx`, `QuestionsTab.tsx`.
**Testler:** yeni `ui/server/test/{legal-rules,legal-processes}.test.ts` ve
`ui/web/src/features/legal/ProcessTab.test.tsx`; P3 soru/rapor testleri.
**Sahip:** Hukuk alanı + değerlendirme sorumlusu. Bulgular 002, 004, 010, 023; M3, M5, M6.

- [ ] Kural uygulanabilirliği konu ve olay zamanına bağlansın: önerilen/kabul/itiraz/ret/
  çözümsüz durumları ayrı olsun. Yeni veya aleyhte yüklenmiş aday kural aramada görünür;
  seçilmemiş olması gizlenme sebebi değildir. Kesin hesap yalnız kabul edilmiş uygulama
  ve yeterli olay/takvim girdisiyle yapılır; eksik veri kesin süreye dönüşmez.
- [ ] Süreç ekranında kim, kime, hangi hükümle, hangi tetikleyiciden sonra, ne zaman,
  ne yapmak zorundaydı ve hangi delil yapılmış olduğunu gösteriyor soruları bağlansın.
  “Yerine getirme kanıtı bulunamadı” ile “yerine getirilmediği kanıtlandı” ayrı olsun.
- [ ] Kaynaklı karşı kanıt araması ve kanıt değerlendirmesi bağımsız görevler olarak
  yürüsün. Eksik belge, okunamayan mevcut belge ve dayanağı olmayan iddia ayrı sunulsun.
- [ ] Kronoloji, konu/sorumluluk tablosu, açık sorunlar ve kaynak listesi dava raporunda
  birleşsin. Paylaşım onayı tam rapor hash'ine ve kaynak/karar sürümüne bağlansın.
  Değişen rapor yeni onay ister; eski dosya tarihsel sürüm olarak tanımlanır.

**Kabul:** Geçiş hükmü içeren iki kural sürümü ve değişimin iki yanındaki olaylar doğru
kaynakla incelenir. Olay tarihi değişince uygulanabilirlik tekrar açılır. Sorumluluğun
sürümler arasında devredildiği, teslimin ihtilaflı olduğu ve işlem kaydının eksik kaldığı
senaryoyu avukat düzeltir; yeniden soru ve rapor aynı zinciri gösterir.

### P6 — Silme, yedek/geri yükleme ve canlı geçiş

**Dosyalar:** P1 kalıcı kayıtlar, yeni `ui/server/src/legal-removal.ts`,
`arias/legal/docker/compose.profile.yml`, `docker-compose.yml`, `scripts/docker/seed.sh`,
repo kökünden `infrastructure/nginx/droplet.conf`; yeni `arias/legal/scripts/backup-restore.mjs`.
**Testler:** yeni `ui/server/test/{legal-removal,legal-restore,legal-cutover}.test.ts`;
hedef hostta ayrı veri alanında işletim kabulü.
**Sahip:** Veri yaşam döngüsü + işletim sorumlusu. Bulgular 011, 016–018.

- [ ] Silmeyi hemen okuma/arama dışı bırak; çalışan işleri iptal edip tamamlanmasını bekle,
  kaynak/türev/rapor/Claude bağlamı temizliğini kalıcı tamamlanma kaydıyla bitir.
  Kalan belgelerle yeni analiz çalışabilsin; kalıcı “silme bekliyor” kilidi kalmasın.
- [ ] Kaynaklar, imzalı başlar, kararlar, kimlik/ilk-kurulum işaretleri, anahtar sürümleri,
  yayın manifestleri ve SQLite/WAL için tutarlı yedek nesli üret. İndeksleri yeniden kur.
- [ ] Silme ve kimlik iptal kaydını sunucu dışında ayrıca kalıcı tut; kurtarma güncellik
  işareti doğrulanmadan eski yedekten hizmet verme. Yedeklerde kalan içerik için saklama
  ve anahtar yaşam döngüsü tanımla. Olağan yükleme için RPO 24 saat veri kaybı penceresidir;
  RTO 4 saat hedefi gerçek tatbikatta ölçülür, sıfır kayıp vaadi değildir.
- [ ] Canlı dinleyici/imaj/yapılandırma/veri alanını yeniden envanterle. Eski yazmaları
  dondur; örnek, gerçek ve belirsiz kayıtları kökeniyle ayır. Gerçek/belirsiz veriyi
  otomatik silme. Hedef üretim alanına yalnız doğrulanmış gerçek kayıtlar alınsın.
- [ ] İsimli kullanıcı kimliği, dava ataması, iptal ve başlangıç işaretlerini taşı.
  Paylaşılan operatör token'ını bir avukat kimliğine dönüştürme; isimli erişim sağla.
  Yeni origin'de yeniden giriş gerekir; token URL ile taşınmaz.
- [ ] DNS/TLS ve proxy doğrulandıktan sonra eski 8480 GET girişini yeni domaine yönlendir;
  eski değiştirici API isteklerini reddet, yazmaları yönlendirmeyle tekrar oynatma.
  Geri dönüşte yeni kabul edilmiş veriyi koru; seed deposunu tekrar otorite yapma.

**Kabul:** Kaynakta, adında, notta, düzeltmede ve cevapta geçen benzersiz sentetik ifade
silme sonrası sistemin yönettiği depolarda/bağlamda erişilemez. Eski yedek + yeni silme/
iptal günlüğünden izole dönüşte içerik ve iptal edilmiş hesap geri açılmaz; kaynak
imzaları doğrulanır, işler çift yayımlanmaz. Eski token'lı tarayıcıdan yeni adreste
isimli giriş yapılır; kullanıcı yalnız yetkili davalarını görür. Üretimde seed/mock yoktur.

### P7 — Bağımsız kabul ve teslim

**Dosyalar:** `arias/legal/corpus/corpus.json` mevcut mekanik ölçümü korur;
yeni `arias/legal/corpus/evaluation-contract.json`, `tools/aria-acceptance/legal-e2e.py`,
`tools/aria-acceptance/test_legal_e2e_scoring.py`; repo kökünden `.github/workflows/new-aria-legal.yml`.
Gerçek özel arşiv/etiketler depoya veya CI artifact'ına konmaz; ölçüm kontrollü veri alanında yapılır.
**Sahip:** Değerlendirme sorumlusu + pilot avukat; işletim kabulü operatörde. Bulgular 002–003, 006.

- [ ] Aşağıdaki ölçüm sözleşmesini P0'da kaydet; nihai cevap etiketlerini geliştirme
  örneklerinden ayır, P7 öncesi hash ve kapsamıyla dondur. Holdout sorular/etiketler
  prompt, retrieval veya ayar girdisi olmasın; değerlendirme anında gereken dava
  belgelerine sistemin erişmesi bu yasakla karıştırılmasın.
- [ ] Her M maddesini girdi, teslim sahibi, ölçüm ve UI göreviyle eşleştir. Eksik gerçek
  arşiv/etiket veya anonim ikinci vaka ilgili kabulü açık bırakır.
- [ ] İlk model sonucu ile avukatça düzeltilmiş sonucu ayrı raporla. Görev süresi,
  geliştirici yardımı, avukat inceleme yükü, hata ve yeniden deneme sayısını kaydet.
- [ ] Yerel kontroller, imaj, gerçek runner/Claude ve pilot kapılarını ayrı işaretle;
  birinin başarısı diğerini geçmiş saydırmasın. CI yol filtreleri çekirdek/runtime
  bağımlılıklarını da kapsasın. Gerçek model kabulü kontrollü hostta çalışabilir;
  CI'ya sır veya gerçek dava taşıma şartı yoktur.

## 5. Ölçüm sözleşmesi ve sekiz sonuç

Anlamsal ölçüm alanları ayrı tutulur: kronoloji, eksik bilgi, çelişki, sürüm değişimi,
sorumluluk, usul adayı ve kaynaklı soru-cevap. Başlangıç hedefi alan başına en az 100
etiketli örnek, ayrıca en az 20 bilinen olumsuz ve 20 yetersiz dayanak örneğidir.
Pilot avukat bu etiketleme yükünü P0'da takvime bağlar; mevcut dört yerleştirilmiş
bulgu bu kümenin yerine geçmez. Yeterli gerçek örnek yoksa o alanda kalite kabulü açıktır.

Birim, aktör/zaman/kapsam/dayanak alanlarıyla tek bir beklenen bulgu veya atomik iddiadır.
Eşleşme bire birdir; aynı olgunun tekrarları skoru şişirmez. Dayanaksız ek iddia yanlış
pozitif, yanıtlanabilir sorudan çekinme kaçırılan bulgudur. Kaynak konumunun açılması,
alıntının doğru aktarılması ve yorumun kaynakça desteklenmesi ayrı denetlenir.

Hedefler alan başına precision >=%95, recall >=%90; yetersiz dayanak kümesinde doğru
çekinme >=%95. TP/FP/FN, paydalar ve örnek büyüklükleri yayımlanır; yalnız birleştirilmiş
skor kullanılmaz. Kritik yanlış olgu ve uydurulmuş hukuk kaynağı teslimi durdurur.
Mevcut mekanik testlerin daha sıkı precision=1,0 ve recall=1,0 kapısı korunur.
Bu sayılar ürünün henüz ulaştığı ölçümler veya sıfır hata garantisi değildir.

| Sonuç | Uçtan uca kapanış kanıtı |
|---|---|
| M1 Büyük karma arşiv | P2/P4: UI yükleme, tam erişim, kısmi okuma görünürlüğü, tarayıcı/servis kurtarma |
| M2 Kronolojik bağ | P4: ayrı zaman anlamları, farklı anlatımlar, kaynak konumu ve bütün olay sayfaları |
| M3 Eksik/tutarsız bilgi | P5/P7: olumsuz/belirsizler dahil anlamsal ölçüm ve açık eksik dayanak |
| M4 Sürüm karşılaştırma | P4: uzun metin/tablo/değişiklikler, iki kaynak ve avukatça aile düzeltmesi |
| M5 Süreç/sorumluluk | P5: taraf → yükümlülük → tetikleyici → eylem → kanıt/eksik adım; düzeltme sonrası süreklilik |
| M6 Bütünlük/usul | P1/P5/P6: imzalı köken, konu/zamana bağlı kural, eksik veride çekinme ve yaşam döngüsü |
| M7 İkinci anonim dava | P7: aynı onaylı yöntem, ayrı dava verisi; ilk davanın kişi/olgu/özel hafızası taşınmaz |
| M8 Kullanılabilir ortam | P3/P7: avukatın CLI/JSON olmadan bütün döngüyü ve PDF raporu tamamlaması |

M7'de yalnız avukatça onaylı sürümlü yöntem adımları tekrar kullanılır. İlk davanın
cevapları, kişi birleştirmeleri veya özel hafızası yöntem diye aktarılmaz. M8 avukat
pilotundaki somut yararı ve başka kurumlara taşıma sınırlarını raporlar.

## 6. Kontroller, izleme ve tarihsel kayıt

Uygulamada değişen davranış için hedefli test; ardından `new-aria/` içinde
`npm run legal:check`, etkilenen Python/çekirdek testleri ve üretim imajı kabulü.
Repo kökünde `NX_DAEMON=false NX_INTERACTIVE=false npx nx affected --target=test --base=HEAD`
ve aynı komutun `--target=lint` hali çalıştırılır. “No tasks were run” hukuk testinin
geçmesi değildir. Döküman değişikliğinde bağlantı, bulgu kapsamı ve `git diff --check`
kontrol edilir; ürün test sonucu uydurulmaz.

23 plan bulgusunun sahibi/kapısı inceleme belgesindedir; kod kabulü oluşmadan kapatılmaz.
Mevcut LEGAL-CRITICAL bulguları [üretim incelemesinde](../../../../docs/reviews/codex/2026-09-05-legal-production.md)
açık koşullarıyla izlenir. Durum raporu P0–P7 ve M1–M8 kanıtını ayrı verir.

2026-09-03 rakip kataloğu, eski modül/satır sayımları ve S0–S4 sıralaması tarihsel
kaydı temsil eder. Modül varlığı uçtan uca kabul veya rakiplere üstünlük kanıtı değildir.
Bu yol haritası hedef sırasını günceller; manifest ve onay politikaları ancak P0/P1
uygulaması, incelemesi ve kabulüyle değiştirilir.
