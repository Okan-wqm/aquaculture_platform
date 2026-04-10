# Agent Review

**Date:** 2026-04-10  
**Scope:** `.claude/agents/*.md` setinin mevcut `/var/aqua-saas` kod tabanina gore tekrar incelenmesi  
**Method:** Sadece repodan dogrulanabilen seyler yazildi. Agent promptlari, orchestrator routing tablosu, mevcut dizin yapisi, `docs/reviews`, `docs/recommendations`, `docs/research`, `docs/plans` izleri birlikte okundu. Agent dosyalarina degisiklik yapilmadi.

## Review Standard

Bu rapor onceki versiyondan daha siki bir mantikla yazildi:

- Sadece repoda kanitlayabildigim ownership ve process gap'lerini bulgu olarak yazdim.
- "Yeni agent lazim" ile "mevcut agente scope eklemek yeterli" konularini ayirdim.
- `security-reviewer` ve `test-runner` gibi kalite kapilarini "primary owner" yerine koymadim; bunlar gate, domain owner degil.
- Her agent icin ayri bolum yazdim: neyi kapsiyor, nesi eksik, pratik sonuc ne.

## Research-Backed and Enterprise-Aligned Prompt Quality

Bu revizyonda `docs/research/` klasorlerine de baktim. Bu, agent promptlarinin kalitesiyle ilgili tabloyu netlestiriyor:

- Hemen hemen tum substantive reviewer agentlar icin `docs/research/{agent}/` altinda 5-8 arasi arastirma dosyasi var.
- Ornek research dosyalari OWASP, NIST, Microsoft Learn, PostgreSQL, Stripe, React, TanStack, Kubernetes, Playwright ve Testcontainers gibi gercek kaynaklara dayaniyor.
- `prompt-writer` acikca deep targeted research zorunlulugu koyuyor ve research trace'i olmayan kurallari spekulasyon sayiyor.
- Reviewer agentlarin buyuk cogunlugu prompt seviyesinde "enterprise production-grade architectural solution" ve "no patches / no workarounds / no fix later" cizgisini explicit tasiyor.

Bu nedenle bu raporun ana elestirisi prompt kalitesine degil, **ownership ve routing kesinligine** yoneliktir.

## Executive Summary

Repoda **20 agent** var. Genel mimari kotu degil; hatta domain-first, cross-cutting gate ve meta-agent zinciri bakimindan olgun bir baslangic kurulmus.

Ek olarak research izleri nedeniyle su da net:

- Bu promptlar gelisiguzel degil, buyuk olasilikla **research-backed** yazilmis.
- Domain reviewer promptlarinin buyuk kismi zaten **enterprise-grade / no patch / no workaround** cizgisini biliyor.

Ama kanitlanabilir gercek su:

- Agent haritasi repo haritasi ile tam ust uste binmiyor.
- En buyuk sorun agent sayisinin azligi degil; **primary owner'ligi belirsiz kalan yuzeyler**.
- Bazi alanlar yeni agent olmadan scope/routing duzeltmesiyle kapanir.
- Bazi alanlarda ise ya yeni owner gerekir ya da mevcut agentlardan birine net ve kalici ownership verilmelidir.

Bu incelemede kanitlanmis ana gap'ler:

- **HIGH-001:** `infra/**`, `deploy/**`, `.github/actions/**` routing ve ownership boslugu
- **HIGH-002:** `platform/libs/cqrs`, `platform/libs/event-bus`, `platform/configs` icin primary owner yok
- **HIGH-003:** `mcp/farm-management` icin primary owner yok
- **HIGH-004:** `libs/backend-common` sadece parcali sahiplenilmis
- **MEDIUM-005:** finding-ID / traceability kural seti tum reviewer agentlarda ayni sertlikte yazilmamis
- **MEDIUM-006:** bazi reviewer agentlar orchestrator raporlarinda gozukuyor ama kendi `docs/reviews/{agent}/` izleri yok

Kisa cevap:

- **Evet, ownership gap var.**
- **Hayir, her gap icin yeni agent zorunlu degil.**
- **Evet, en az iki yerde kalici owner karari verilmeden sistem tam oturmaz: platform-kernel yuzeyi ve `mcp/**`.**

## System Findings

### HIGH-001: `infra/**`, `deploy/**`, `.github/actions/**` icin routing ve ownership eksik

**Evidence**

- Repo'da `infra/`, `deploy/`, `.github/actions/` aktif olarak mevcut.
- Orchestrator routing tablosu `infrastructure/**` ve `.github/workflows/**` icin kural iceriyor; `infra/**`, `deploy/**`, `.github/actions/**` icin acik kural yok.
- `infra-expert` scope tanimi de esas olarak `infrastructure/...`, workflow, nginx ve compose ekseninde yazilmis.

**Why this matters**

- Bunlar deploy, cluster, release ve CI davranisini etkileyen birincil operasyon yuzeyleri.
- Bu degisiklikler kalite gate'lere carpabilir, ama primary domain owner'a gitmeyebilir.

**Practical conclusion**

- Ilk cozum yeni agent degil; once `infra-expert` kapsam ve orchestrator routing'i bu yuzeyleri kapsayacak sekilde netlestirilmeli.

### HIGH-002: `platform/libs/cqrs`, `platform/libs/event-bus`, `platform/configs` icin primary owner yok

**Evidence**

- Repoda `platform/libs/cqrs`, `platform/libs/event-bus`, `platform/libs/outbox`, `platform/configs/*.ts` mevcut.
- Orchestrator yalnizca `platform/libs/outbox/**` icin routing tanimliyor.
- `cqrs`, `event-bus` ve `platform/configs` icin ne routing kuralinda ne de agent scope metinlerinde net primary owner var.

**Why this matters**

- Bunlar servis-ustu davranis belirleyen platform-kernel yuzeyler.
- Buradaki hata tek bir servisi degil, coklu servis davranisini bozabilir.

**Practical conclusion**

- Bu alan repodaki en net ownership boslugudur.
- Cozum ya yeni bir platform-kernel agent, ya da mevcut agentlardan birine bu yuzeylerin acik ve kalici verilmesidir.

### HIGH-003: `mcp/farm-management` icin primary owner yok

**Evidence**

- Repoda `mcp/farm-management/src/` altinda auth/context, GraphQL client, prompts, tools, analytics ve testler var.
- Agent scope ve orchestrator routing tablosunda `mcp/**` icin acik sahiplik yok.
- `messaging-expert` MCP/tool safety kurallari tasiyor ama actual `mcp/**` kodu ona route edilmiyor.
- `farm-expert` domain olarak yakin ama `mcp/**` onun scope'unda da yok.

**Why this matters**

- Bu yuzey domain + AI/tooling + auth/context karmasi bir alan.
- "Herkese biraz ait" gorunup pratikte hic kimseye primary owner olmayabilir.

**Practical conclusion**

- Burasi ikinci net ownership boslugu.
- En pratik secenek: ya `farm-expert` primary owner yapilip `messaging-expert`/`security-reviewer` notify edilir, ya da ayrik bir MCP owner tanimlanir.

### HIGH-004: `libs/backend-common` parcali sahiplenilmis

**Evidence**

- Orchestrator `guards`, `security`, `middleware`, `audit`, `database`, `redis`, `nats` altini route ediyor.
- Ama repoda `libs/backend-common/src/auth`, `bootstrap`, `context`, `filters`, `health`, `logging`, `metrics`, `monitoring`, `monetary`, `pagination`, `telemetry`, `websocket` gibi alanlar da var.
- Bu alanlar icin routing tablosunda acik owner yok.

**Why this matters**

- `backend-common` sistem davranisini sekillendiren ortak katman.
- Parcali ownership burada sessiz regressions uretir.

**Practical conclusion**

- Burasi yeni agent gerektirmeyebilir.
- Ama mevcut agentlar arasinda tam bir ownership matrisi yazilmadan guvenli sayilamaz.

### MEDIUM-005: reviewer traceability kontrati tum prompt setinde uniform degil

**Evidence**

- `CLAUDE.md` `Closes:` ve finding-ID temelli formal traceability istiyor.
- `prompt-writer` bu formati reviewer agentlar icin zorunlu kiliyor.
- Buna ragmen en az `admin-expert`, `context-manager`, `architectural-arbiter`, `multi-tenant-saas-expert` promptlarinda bu zorunluluk explicit olarak yazilmamis.

**Why this matters**

- Review-to-fix otomasyonu prompt seviyesinde standart degilse zincir kirilir.

**Practical conclusion**

- Bu ownership degil, governance gap.
- Yeni agent gerekmez; prompt standardizasyonu gerekir.

### MEDIUM-006: bazi reviewer agentlar icin standalone output izi zayif

**Evidence**

- `docs/reviews/` altinda `frontend-expert`, `hr-expert`, `messaging-expert`, `test-runner` icin agent klasoru yok.
- Buna karsin orchestrator raporlarinda bu agentlarin invoke edildigi ve finding uretdigi goruluyor.
- `docs/research/` altinda ise bu agentlarin klasorleri mevcut.

**Why this matters**

- Agent calisiyor olabilir, ama per-agent outputlar commit history'de standardize sekilde tutulmuyor olabilir.
- Bu da audit izlenebilirligini zayiflatir.

**Practical conclusion**

- Bu capability gap degil, artifact persistence gap.
- Ozellikle reviewer agentlar icin per-agent report saklama disiplininin netlestirilmesi faydali olur.

## Agent-by-Agent Review

### `admin-expert`

**Kapsadigi alan**

- `apps/admin-api-service/src/`
- `web/modules/admin-panel/src/`
- `web/modules/tenant-admin/src/`
- Impersonation, admin billing, DB explorer, audit, tenant lifecycle UI

**Guclu tarafi**

- Backend + iki ayri admin frontend yuzeyini tek owner altinda topluyor.
- Admin domaini icin yeterince somut ve gercekci kurallar tasiyor.

**Eksik / zayif taraf**

- `multi-tenant-saas-expert` ile tenant lifecycle ve impersonation overlap'i var.
- Finding-ID kontrati promptta explicit degil.

**Pratik sonuc**

- Primary owner olarak dogru.
- Yeni agent gerekmiyor.
- Ama traceability standardi ve tenant overlap siniri daha net olmali.

### `architectural-arbiter`

**Kapsadigi alan**

- Agent-review conflict resolution
- ADR uretimi
- Cross-agent severity / invariant catisma kararlari

**Guclu tarafi**

- Catisma oldugunda "kim hakli" degil, "hangi invariant daha temel" mantigi kuruyor.
- Meta sistem icin gerekli.
- Exact "no patch" cizgisini farkli bir dille tasiyor: orta yol workaround yerine root-cause resolution istiyor.

**Eksik / zayif taraf**

- `docs/reviews/architectural-arbiter/` ve `docs/recommendations/architectural-arbiter/` commit izi yok.
- Finding-ID kontrati explicit degil.

**Pratik sonuc**

- Agent gerekli.
- Ama repodaki evidence'a gore henuz operasyonel olarak olgun kullanildigini kanitlayamiyorum.

### `auth-security-expert`

**Kapsadigi alan**

- `apps/auth-service/`
- `apps/gateway-api/`
- `libs/backend-common/src/{guards, middleware, security, audit}`
- Prompt scope icinde decorators ve utils da var

**Guclu tarafi**

- Auth pipeline ownership'i net.
- Security-critical katmanda guclu primary owner.

**Eksik / zayif taraf**

- `libs/backend-common/src/auth/` orchestrator routing tablosunda explicit degil.
- `libs/backend-common` icindeki auth-adjacent ortak alanlar parcali sahipleniliyor.

**Pratik sonuc**

- Yeni agent gerekmiyor.
- Ama `backend-common` icindeki auth-adjacent alanlar ona daha net baglanmali.

### `context-manager`

**Kapsadigi alan**

- `docs/reviews/*`
- Cross-domain dependency graph
- Report compaction

**Guclu tarafi**

- Buyuk review corpus icin gerekli.
- Repoda kendi `docs/reviews/context-manager/` izi var; yani sadece teorik degil.

**Eksik / zayif taraf**

- Finding-ID kontrati explicit degil.
- Kendisi ancak source report varsa degerli; upstream agent artifact disiplini zayifsa onun kalitesi de duser.

**Pratik sonuc**

- Gerekli ve uygulanmis.
- Eksigi capability degil, upstream governance bagimliligi.
- Burada exact "no patch" dili birebir yazili olmayabilir; bu normal cunku bu agent source fix onermez, mevcut raporlari sikistirir.

### `data-expert`

**Kapsadigi alan**

- `libs/event-contracts/`
- `libs/backend-common/src/database/`
- `libs/backend-common/src/nats/`
- `database/migrations/`
- `libs/shared/`, `libs/storage/`, `libs/sdk/`

**Guclu tarafi**

- Delta review, schema management ve event contracts icin cok guclu owner.
- Repoda review ve research izi var.

**Eksik / zayif taraf**

- `platform/libs/cqrs`, `platform/libs/event-bus`, `platform/configs` ona da verilmemis.
- `database/scripts/**` ona gidiyor ama ayni anda `database-reviewer` notifysi almiyor.

**Pratik sonuc**

- Data tarafi guclu.
- Ama platform-kernel ownership boslugunu onunla kapatacaksaniz bunu acik yazmak gerekir; bugunku prompt seti bunu yapmiyor.

### `database-reviewer`

**Kapsadigi alan**

- Resulting schema state
- Table, index, constraint, naming, tenancy-state denetimi

**Guclu tarafi**

- `data-expert` ile ayrimi mantikli.
- Delta vs resulting-state ayrimi gercek hayatta uygulanabilir bir ayrim.

**Eksik / zayif taraf**

- Orchestrator `database/scripts/**` degisikliklerinde bunu otomatik cagrirmiyor.
- `infrastructure/sql/**` ve benzeri operasyonel SQL yuzeyleri icin explicit dispatch yok.

**Pratik sonuc**

- Yeni agent gerekmiyor.
- Ama schema-state etkileyen script/deploy SQL degisikliklerinde daha cok dispatch edilmesi gerekir.

### `edge-expert`

**Kapsadigi alan**

- `sens-api-gateway/`
- Rust edge agent, provisioning, offline, protocol security

**Guclu tarafi**

- Repo icinde cok net bounded context.
- Review izi de var; yani sadece prompt olarak durmuyor.

**Eksik / zayif taraf**

- `sensorprotocols/*.md` explicit owner altinda degil.
- `edge-agent-release.yml` workflow'u infra tarafina gidiyor; edge-expert co-notify almiyor.

**Pratik sonuc**

- Code owner olarak dogru.
- Yeni agent gerekmiyor.
- Ama protocol docs ve release pipeline degisikliklerinde notify edilmesi mantikli olur.

### `farm-expert`

**Kapsadigi alan**

- `apps/farm-service/`
- `web/modules/farm-module/`
- `libs/farm-shared/`
- `libs/aquaculture-engines/`

**Guclu tarafi**

- Domain + frontend + domain library zincirini birlikte goruyor.
- Bu monorepo icin iyi bir ownership formu.

**Eksik / zayif taraf**

- `mcp/farm-management` domain olarak yakin ama scope ve routing disinda.

**Pratik sonuc**

- Primary owner olarak guclu.
- `mcp/farm-management` icin en dogal primary owner adaylarindan biri bu agent.

### `frontend-expert`

**Kapsadigi alan**

- `web/shell/`
- `web/shared-ui/`
- `web/modules/dashboard/`
- `web/apps/aquamobil/`
- Orchestrator uzerinden `libs/node-components/`

**Guclu tarafi**

- Host/shared-ui/PWA gibi gercekten cross-cutting frontend yuzeylerini sahipleniyor.
- Bu ayrim mantikli.
- Research izi guclu; frontend kurallari spekulatif gorunmuyor.

**Eksik / zayif taraf**

- Domain moduller intentionally out-of-scope.
- Fakat `hr-expert` ve `admin-expert` frontend kalitesi icin explicit subsection tasirken `farm-expert`, `sensor-expert`, `platform-services` ayni seviyede standardize edilmis degil.
- `docs/reviews/frontend-expert/` yok; standalone review izi zayif.

**Pratik sonuc**

- Yeni bir genel frontend agent gerekmiyor; bu agent zaten var.
- Gercek eksik, domain agentlar ile frontend kalite kontratinin eslenik olmamasi.

### `hr-expert`

**Kapsadigi alan**

- `apps/hr-service/`
- `web/modules/hr-module/`

**Guclu tarafi**

- Domain + frontend a11y/i18n birlikte dusunulmus.
- Prompt seviyesi pratik ve uygulanabilir.
- `docs/research/hr-expert/` var; yani prompt kalitesi tarafinda kanit mevcut.

**Eksik / zayif taraf**

- Yapisal ownership gap gorunmuyor.
- Ama `docs/reviews/hr-expert/` izi yok; standalone output persistence zayif.

**Pratik sonuc**

- Yeni agent gerekmiyor.
- Asil iyilestirme gerekirse output disiplinindedir, scope'ta degil.

### `implementation-planner`

**Kapsadigi alan**

- `docs/reviews/*` girdilerini alip `docs/plans/` uretmek

**Guclu tarafi**

- Repoda `docs/plans/` altinda bol miktarda artifact var; yani bu agent teorik degil.
- Buyuk finding setleri icin uygulanabilir.

**Eksik / zayif taraf**

- Primary owner bosluklarini kendi basina cozemez; sadece mevcut finding'leri paketler.

**Pratik sonuc**

- Gerekli ve kullanilan bir meta agent.
- Eksigi yok; ama routing gap'lerin telafisi da degil.
- "No patch" cizgisi burada source fix degil, root-cause odakli plan paketleri anlamina geliyor.

### `infra-expert`

**Kapsadigi alan**

- `infrastructure/**`
- `.github/workflows/**`
- `nginx/**`
- root compose ve ilgili deploy surfaces

**Guclu tarafi**

- Klasik infra/IaC/CI ownership'i icin dogru aday.
- Review izi guclu.
- Research izi de guclu; container/K8s/CI kurallari enterprise bara oturuyor.

**Eksik / zayif taraf**

- Repoda `infra/**`, `deploy/**`, `.github/actions/**` da var; scope ve routing'te bunlar explicit degil.
- Bu, bugunku sistemdeki en net pratik bosluklardan biri.

**Pratik sonuc**

- Yeni agent lazim demeden once ilk yapilmasi gereken sey bu agentin scope/routing genisletmesidir.

### `messaging-expert`

**Kapsadigi alan**

- `apps/messaging-service/`
- `apps/ai-service/`

**Guclu tarafi**

- Messaging + AI + compliance + tool/LLM safety kurallarini bir arada dusunuyor.
- Teknik derinligi yuksek.
- Research tabani belirgin; prompt kalitesi acisindan zayif degil.

**Eksik / zayif taraf**

- Prompt MCP ve tool safety kurallari tasiyor ama actual `mcp/**` kodu buna route edilmiyor.
- `docs/reviews/messaging-expert/` izi yok.

**Pratik sonuc**

- Agent guclu.
- Fakat `mcp/**` ownership boslugu cozulecekse bu agent en azindan notify tarafinda is icinde olmali.

### `multi-tenant-saas-expert`

**Kapsadigi alan**

- Tenant isolation, lifecycle, plan gating, quotas, portability, onboarding/offboarding
- Prompt seviyesiyle diger agentlarin tenant overlap'lerini topluyor

**Guclu tarafi**

- Multi-tenant gibi cok kritik bir ekseni tek bir ownership merkezine cekmeye calisiyor.
- Bu dogru bir stratejik karar.

**Eksik / zayif taraf**

- Orchestrator routing'te teknik olarak filename/path heuristic'lerine ve "tenant-related concern" yorumuna bagli.
- Tenant bug'lari her zaman `tenant*.ts` dosyalarinda cikmaz; domain agent escalation'ina bagimlilik var.
- Finding-ID kontrati explicit degil.

**Pratik sonuc**

- Agent gerekli.
- Ama tek basina safety net degil; routing daha mekanik hale gelmeli.

### `orchestrator`

**Kapsadigi alan**

- Review dispatch
- Cross-domain follow-up
- Unified report
- Planner tetikleme

**Guclu tarafi**

- Sistemin en yuksek kaldiracli noktasi.
- Finding-ID propagation mantigi burada gayet iyi yazilmis.
- Repoda `docs/reviews/orchestrator/` izi guclu.
- Meta-agent oldugu icin exact "no patch" ifadesi tasimasa da sistem davranisi root-cause ve traceability mantigiyla yazilmis.

**Eksik / zayif taraf**

- `infra/**`, `deploy/**`, `.github/actions/**`, `platform/libs/cqrs/**`, `platform/libs/event-bus/**`, `platform/configs/**`, `mcp/**` explicit route edilmiyor.
- `libs/backend-common` sadece parcali route ediliyor.

**Pratik sonuc**

- Yeni agenttan once duzeltilmesi gereken ilk yer orchestrator routing tablosudur.

### `platform-services`

**Kapsadigi alan**

- `apps/billing-service/`
- `apps/notification-service/`
- `apps/config-service/`
- `apps/event-store-service/`
- `apps/observability-service/`
- `apps/hydroponics-service/`
- `web/modules/hydroponics-module/`
- `apps/alert-engine/`

**Guclu tarafi**

- Owner'siz kalabilecek servisleri bir sepete toplamis; pratik bir gecis cozumudur.
- Review izi de var.
- Prompt enterprise/no-patch bari tasiyor; sorun kalite barinda degil, heterojenlikte.

**Eksik / zayif taraf**

- Cok heterojen bir sepet.
- Description satiri `alert-engine` i bile anmiyor; scope ve description drift'i var.
- Hydroponics frontend icin domain-specific frontend kalite rubrigi belirgin degil.

**Pratik sonuc**

- Split faydali olabilir, ama bugun repodan "mutlaka split et" diyecek kadar kanit yok.
- Kanitlanan sey, bu agentin uzun vadeli ideal olmadigi; kisa vadede ise is gordugudur.

### `prompt-writer`

**Kapsadigi alan**

- Yeni agent promptlari olusturma / mevcutlarini guncelleme kural seti

**Guclu tarafi**

- Finding-ID zorunlulugu dahil olmak uzere governance acisindan dogru kurallari koyuyor.
- Research-backed agent yazimini explicit zorunlu kiliyor.
- Enterprise-grade / no patch cizgisinin kaynagi buyuk olasilikla bu agent.

**Eksik / zayif taraf**

- Mevcut agent seti bu governance'i uniform sekilde yansitmiyor.
- Yani prompt-writer kural koymus, ama repo promptlari tamamen normalize edilmemis.

**Pratik sonuc**

- Agent gerekli.
- Eksik olan sey capability degil; geriye donuk standardizasyon uygulanmamis olmasi.

### `security-reviewer`

**Kapsadigi alan**

- Tum repo
- Cross-cutting security gate

**Guclu tarafi**

- Boyle bir gate kesinlikle gerekli.
- Review izi var ve kullaniliyor.
- Prompt enterprise-grade / no workaround dilini explicit tasiyor.

**Eksik / zayif taraf**

- Primary owner boslugunu kendi basina telafi etmez.
- Ornegin `mcp/**` veya `platform/libs/cqrs/**` security-review alabilir, ama domain owner sorusunu cozmez.

**Pratik sonuc**

- Agent guclu.
- Ama missing owner problemine cevap degil; sadece savunma kati.

### `sensor-expert`

**Kapsadigi alan**

- `apps/sensor-service/`
- `web/modules/sensor-module/`

**Guclu tarafi**

- Sensor + SCADA + OT/ICS guvenligi icin derin prompt.
- Review izi de var.
- Research izi de var; kurallar standard ve dokuman tabanli gorunuyor.

**Eksik / zayif taraf**

- Kapsadigi alan cok buyuk: hem buyuk backend hem buyuk frontend.
- `sensorprotocols/*.md` explicit route edilmiyor.

**Pratik sonuc**

- Yeni agent zorunlu degil.
- Ama protocol docs ve edge-adjacent degisikliklerde co-notify mekanizmasi mantikli olur.

### `test-runner`

**Kapsadigi alan**

- Tum test dosyalari
- Build, coverage, CI test health

**Guclu tarafi**

- Kalite kapisi olarak gerekli.
- Prompt derinligi pratik ve uygulanabilir.
- Research izi acik; test stratejisi gercek DB/Redis, contract test ve mutation testing gibi enterprise kaliplara dayaniyor.

**Eksik / zayif taraf**

- `.github/actions/**` composite action'lari explicit routing altinda degil; test ortam davranisini etkileyebilirler.
- `docs/reviews/test-runner/` izi yok; orchestrator onu invoke ediyor ama standalone output commit izi gorunmuyor.

**Pratik sonuc**

- Yeni agent gerekmiyor.
- Artifact persistence ve `.github/actions/**` routing'i iyilestirilmeli.

## Direct Answer: Eksik Agent Var Mi?

### Kanitlanmis cevap

**Evet, eksik primary ownership var.**

Ama bu cevabin altini dogru cizmek lazim:

- Ben repodan **eksik ownership** kanitlayabiliyorum.
- Ben repodan her ownership gap icin **mutlaka yeni agent** gerektigini kanitlayamiyorum.

### Yeni agent olmadan kapanabilecek gap'ler

Asagidakiler mevcut agentlarla kapatilabilir:

1. `infra/**`, `deploy/**`, `.github/actions/**` -> `infra-expert`
2. `libs/backend-common` parcali alanlari -> mevcut agentlar arasinda net ownership matrisi
3. `database/scripts/**` ve operasyonel SQL state etkileri -> `database-reviewer` co-dispatch
4. Domain frontend kalite farklari -> mevcut domain agentlara ortak frontend subsection standardi

### Kalici owner karari gerektiren gap'ler

Burada artik "birine yazili olarak verin" noktasi var:

1. `platform/libs/cqrs/**`
2. `platform/libs/event-bus/**`
3. `platform/configs/**`
4. `mcp/**`

Bu alanlar icin iki gercekci secenek var:

- Mevcut bir agente acik ownership vermek
- Ayrik yeni agent tanimlamak

### Pratik yargim

En gercekci ve bugun uygulanabilir yol:

1. Once orchestrator routing ve mevcut agent scope'larini tamamlayin.
2. Hala owner'siz kalan iki alan icin karar verin:
   - platform-kernel
   - mcp

Benim teknik yargim:

- **platform-kernel** icin kalici owner karari olmadan bu sistem tam oturmaz.
- **mcp/** icin de primary owner karari olmadan uzun vadede belirsizlik devam eder.

Bu owner mevcut bir agent olabilir; ille yeni agent olmak zorunda degil. Ama bugunku haliyle "net owner var" diyemem.

## Final Assessment

Bu agent sistemi uygulanabilir bir temel.

Ama "en iyi hale gelmis" seviye icin daha erken. Bunun sebebi promptlarin kotu olmasi degil; daha cok su:

- promptlarin research-backed ve enterprise-grade olmasi ayri konu,
- owner map'inin eksiksiz olmasi ayri konu,
- repo yuzeyi prompt setinden biraz daha genis,
- bazi ownership'ler parcali,
- bazi meta kurallar uniform uygulanmiyor.

En saglam sonuc su:

**Bugunku problem agent kalitesinden cok ownership kesinligi problemidir.**

Bu nedenle en dogru sonraki adim "rastgele yeni agent eklemek" degil;  
**once eksik owner haritasini kapatmak, sonra gerekiyorsa yeni agent eklemek** olur.
