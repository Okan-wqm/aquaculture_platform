<!-- ARIA-HISTORICAL: Historical plan document.
Live authority is docs/aria/CURRENT_STATE.md plus executable contracts. -->

# ARIA Plan 038 — Depo grafiğini sağlamlaştırmak ve dosya düzeyine indirmek

> **Durum:** 2026-10-27'de operatör talebiyle açıldı; codebase-memory-mcp değerlendirmesinin
> devamı. Bulgular ARIA-HIGH-993, ARIA-MEDIUM-994 ve ARIA-MEDIUM-995; ölçüm ve kanıtlar:
> `docs/reviews/claude/2026-10-27-aria-repository-graph-measurement.md`. Sahip: Okan-wqm.

## Neden

codebase-memory-mcp ile karşılaştırma iki şey gösterdi. ARIA'nın servisler arası kontrat kenarları
(event, gateway subgraph, şema yerleşimi) o araçtan güçlü. Zayıf olan, `impact_closure`'ın üzerinde
yürüdüğü TypeScript import katmanı. Bu katmanı `6b7ebca3`'te TypeScript 5.9.3 derleyicisiyle ölçtük:

- **Sağlamlık (ARIA-HIGH-993).**
  - ARIA 182 kenar görüyor, derleyici 192.
  - 17 gerçek kenar kaçıyor: 15'i proje sınırını aşan göreli import, 2'si tsconfig alias'ı olmayan
    workspace paketi.
  - 7 kenar hayali: yorumların ve string literal'ların içindeki import metninden geliyor.
  - Sonuç: plan coverage, bir değişikliğin ulaştığı projeleri isteyemiyor. Örneğin
    `service-catalog` değişince `config-service` closure'a girmiyor.
- **Bayat önbellek (ARIA-MEDIUM-994).**
  - Önbellek anahtarı kenarların okunduğu dosyaları içermiyor.
  - 2026-10-18 ve `6b7ebca3` ağaçlarında anahtar aynı, ama kenar setleri farklı.
  - Ölçülen 403 commit'te anahtarın girdileri hiç değişmedi.
- **Ayrıntı (ARIA-MEDIUM-995).**
  - Import kenarı proje düzeyinde. Dosya düzeyine inmek closure'ı yarıya indiriyor: gerçek
    commit'lerde derinlik 1'de 155'ten 78'e, tam derinlikte 202'den 107'ye.
  - Kütüphane dosyası başına medyan derinlik 1'de 19'dan 7'ye, tam derinlikte 23'ten 8'e.
  - ARIA'nın kendi 42 planı hiçbir kütüphaneye dokunmadı. Bu yüzden plan coverage bu bedeli henüz
    ödemedi; kütüphaneye dokunan her plan ve admission scope öder.

`twin.py:7` derin katmanı "bir tüketici ihtiyacı kanıtlarsa" şartına bağlıyor. Bu ölçüm o şartı
**dosya düzeyi** import kenarları için karşılıyor; tüketiciler plan coverage (`plan_coverage.py:388`,
derinlik 1) ve admission scope (`plan_origin.py:476`, tam derinlik). Sembol düzeyindeki çağrı
kenarları ölçülmedi, bu plan onları kurmaz.

## Mimari kararlar

1. **Dördüncü graf motoru yok.** `source_facts.py:3` (PLAN-v2 Faz 0.9) üç motoru sabitliyor:
   aria-import-graph, twin ve impact_graph. Bu plan yeni bir motor eklemiyor. TypeScript import
   olgusu `impact_graph`'ın girdisi oluyor ve `twin` bu olguyu `impact_graph` üzerinden okuyor.
2. **TypeScript'in tek okuyucusu derleyicinin kendisi.**
   - Parse: `ts.createSourceFile`.
   - Çözüm: `ts.resolveModuleName`; önce en yakın `tsconfig.json`, sonra `tsconfig.base.json`.
   - Workspace bağlantıları gerçek yollarına göre değerlendirilir.
   - Bu, Python'da `source_facts.py`'nin koyduğu kuralın TypeScript karşılığı.
   - Regex okuyucular silinir: `impact_graph.py:22` ve `twin.py:78`.
   - İki okuyucunun yeniden doğmasını bir invariant engeller, `test_atlas_one_owner`'ın TypeScript
     karşılığı (tier 1).
3. **Olgu, kernel'in mevcut TypeScript çalıştırıcısıyla üretilir.**
   - Çalıştırıcı `plan_coverage.run_ts_json_entry`.
   - Olguyu `tools/aria-adapters/` altında tek bir `--facts` girişi üretir; adaptörler zaten
     `typescript` kullanıyor.
   - Çalıştırıcının "iki giriş, başka hiçbiri" sözleşmesi (`plan_coverage.py:524-527`) üç girişe
     çıkar; sözleşme metni ve testi aynı commit'te değişir.
   - Node yoksa ya da giriş çökerse closure tutulur (`hold`), import'suz bir closure gibi davranmaz.
     Bu, `contract_edges_unavailable` ile aynı disiplin.
4. **Önbellek, türetildiği her şeyle anahtarlanır.**
   - Commit'li ağaç için anahtara, taranan köklerin `git ls-files -s` blob kimlikleri girer.
   - Kirli dosyalar için anahtara içerik özetleri girer.
   - Anahtar hiçbir `.ts` dosyasını baştan sona okumaz; böylece bugünkü hız gerekçesi
     (`impact_graph.py:382-388`) korunur.
5. **Dosya düzeyi kenar, twin'in derin katmanıdır.**
   - Kayıt yeri `twin/map.json`; harita `indexed_sha`'ya bağlı ve `state_manifest.py`'de tanımlı
     kalır.
   - Artımlı güncelleme ile sıfırdan kurulum aynı haritayı üretmek zorunda.
   - `impact_closure`'ın `import` kenarı bu katmandan okunur ve kanıt olarak import satırını
     (`path:line`) taşır; bugünkü `None` kalkar.
   - Değişmiş dosya graf düğümü olmayan bir dosyaysa (css, svg, json, yaml) closure proje düzeyindeki
     kenara düşer (fail-closed).

## Birimler

| Birim | Bulgular                       | Değişiklik                                                                                                               | Kabul                                                                                                                                                                                                                                                                            |
| ----- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1    | ARIA-HIGH-993, ARIA-MEDIUM-994 | Derleyici tabanlı TS import olgusu, regex okuyucuların silinmesi, içerikle anahtarlanan önbellek, tek-okuyucu invariantı | Fixture testleri: göreli cross-project import, alias'sız workspace paketi, yorumda ve string'de import metni, `export type * from`. Yeni bir import önbelleği geçersiz kılar. `6b7ebca3`'te kenar seti 192 kenar, 0 hayalet, 0 kaçırılan (PR gövdesinde kayıtlı).                |
| G2    | ARIA-MEDIUM-995                | Dosya düzeyi import kenarı, siteli kanıt, düğümsüz dosya için proje düzeyine düşüş                                       | Ölçümdeki 15 commit'te closure en fazla 78 (derinlik 1) ve 107 (tam) proje. Her dosya düzeyi closure, G1 proje grafiğinin closure'ının alt kümesi (invariant). Yalnız spec değişikliği → 0 proje; svg değişikliği → proje düzeyi. Twin'de artımlı güncelleme = sıfırdan kurulum. |
| G3    | —                              | Aday yetenekler için ölçüm kapıları (aşağıda)                                                                            | Her adayın ölçümü bir review dosyasına yazılır. Ölçüm ihtiyacı gösteren aday, bulgu ve birim olarak bu plana eklenir; göstermeyen gerekçesiyle kapanır.                                                                                                                          |

Sıra G1 → G2: dosya düzeyi kenar, G1'in okuyucusu olmadan kurulamaz. G1 için hedef tarih
2026-11-17, G2 için 2026-12-15.

## G3 — ölçüm kapıları

Bu adaylar codebase-memory-mcp karşılaştırmasından geliyor. Hiçbiri ölçülmeden inşa edilmez. Hepsinin
sahibi Okan-wqm, ölçüm tarihi 2026-12-15.

| Aday                                                                      | Tüketici                                                         | Karar verecek ölçüm                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REST route ↔ frontend çağrı noktası                                      | `impact_closure`, Lane-B denetçileri, `fe-dto-parity-adapter` v2 | Bir backend controller'ı değiştiğinde closure'a hiç girmeyen REST tüketicisi web projesi sayısı. HTTP sınırı bir import değildir; bugün yalnız GraphQL için `gateway_subgraph` kenarı var. |
| CQRS dispatch kenarı (`commandBus.execute(new X)` → `@CommandHandler(X)`) | test seçimi, context pack                                        | Handler'lar kendi servislerinde olduğu için proje düzeyinde fark beklenmiyor. Ölçülecek olan, G2 kenarlarına bu kenar eklenince seçilen spec ve dosya sayısının değişimi.                  |
| Diff → etkilenen dosyalar → testler                                       | implementer `validation_scope`, pre-push                         | G2 kenarlarıyla seçilen TS spec sayısı ile `nx affected` proje seçimi arasındaki fark, ölçümdeki commit kümesinde.                                                                         |
| Context pack'e kod komşuluğu                                              | `context_compiler.py`                                            | Dispatch transcript'lerinde ajanın keşif için okuduğu dosyaların, dokunulan dosyaların G2 komşuluğu tarafından kapsanma oranı.                                                             |
| Env var ↔ deploy config kenarı                                           | yeni bir adaptör                                                 | Kodda okunup hiçbir deploy hedefinde (compose, helm, `.env.example`) tanımlanmayan, ya da tanımlanıp hiçbir kodda okunmayan değişken sayısı.                                               |

Sabit, yerel bir embedding modeli de aynı listedeydi. O zaten ORPHAN-MEDIUM-639 olarak operatör
kalemi; burada tekrarlanmıyor.

## Benimsenmeyenler

- **codebase-memory-mcp'yi ARIA'nın içine almak.**
  - İndeksi `~/.cache` altında duran opak bir C binary'si. `state_manifest.py`'ye ve `indexed_sha`'ya
    bağlanamaz.
  - Dördüncü bir motor olurdu, bu da karar 1'e aykırı.
  - Yetenekleri kaynak olarak kullanılıyor; kodu kullanılmıyor.
- **Cypher sorgu dili, 162 dil desteği, Lens arayüzü, commit'lenen graf dosyası, cross-repo
  bağlantıları.** Tek bir monorepo üzerinde kernel'den okuyan bir sistemin bunlara tüketicisi yok.
- **Geliştirici oturumları.** codebase-memory-mcp kişisel MCP ayarında kullanılabilir. Repo
  `.mcp.json`'una eklenmez, çünkü her katkıcıya bir binary dayatır. Bu konu ARIA'nın değil.

## Doğrulama

- Her birim test-önce yazılır.
- İlgili kernel testleri ve `nx affected --target=test` ile `--target=lint` koşulur.
- Banned-phrase gate'leri ve authority hash korunur.
- G1 ve G2'nin `6b7ebca3` sayıları PR gövdesine, ölçümün yeniden koşusuyla yazılır. Kalıcı
  korumayı fixture'lar ve invariantlar sağlar; belirli bir commit'e bağlı bir test değil.
