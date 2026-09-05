<!-- markdownlint-disable MD013 MD033 -->
<!-- Historical review text preserves long evidence tokens and placeholders. -->

# D0 evidence/integrity adversarial review

## Verdict

`CHANGES_REQUIRED`

Mevcut D0 kaydı yanlış biçimde `DONE` veya admitted görünmüyor: zincir `IN_PROGRESS -> VERIFYING` ile bitiyor,
reviewer/admission alanları pending/false ve 72 program sprint'inin tamamı `PLANNED`. Mevcut dört event
hash'i, authority digest'leri, bundle digest'i ve evidence file digest'i yeniden hesaplandığında doğrudur.
Ancak üç load-bearing kanıt sözleşmesi kusuru ve bir coverage tutarsızlığı vardır.

## Bulgular

### INT-P1-001 — Sonraki review admission aynı manifesti değiştirirse önceki event'in evidence bağı kopar

- **Evidence:** `docs/plans/2026-09-01-new-aria-autonomous-engineering/PLAN.md:33` event ledger'ı append-only
  authority, evidence manifesti proof record olarak tanımlar.
  `docs/plans/2026-09-01-new-aria-autonomous-engineering/progress/events.jsonl:4`,
  `progress/evidence/D0-plan-materialization.json` URI'sini exact
  `0dfd4363797a067ce7ccdfa0a7efbe28b2ee69b2daf2cdcfe2cf2321a3df8558` digest'iyle pinler. Manifestin
  reviewer/admission alanları bugün pending'dir (`progress/evidence/D0-plan-materialization.json:78` ve
  `:268`). Buna rağmen controller sözleşmesi aynı dosyayı Task 2'de değiştirmeyi açıkça planlar
  (`.superpowers/sdd/BOOTSTRAP/progress.md:19`). Bellek içi bir reviewer/admission güncellemesiyle dosya
  digest'i `35b91733339a109f1ba9cab43015d843649d5fe3ebf390acc497f5c58a636fb1` oldu; eski event'in pinned
  digest'i artık URI'deki byte'ları doğrulamadı.
- **Severity:** P1 correctness / audit integrity.
- **Consequence:** Aynı manifest update edilirse ya `d0-0004` değiştirilip zincirin append-only niteliği ihlal
  edilir ya da `d0-0004` kalır ve evidence URI'si dangling/false olur. Yeni event append etmek eski event'in
  çözümlediği dosyayı değiştirmez; bu nedenle mevcut Task 2 modeliyle review admission geçmiş kanıtı bozmadan
  eklenemez.
- **Smallest fix:** Mevcut `D0-plan-materialization.json` immutable kalsın. Review verdict'i exact reviewed
  SHA, reviewer identity/report digest, predecessor evidence digest ve prior event tail'i taşıyan
  ayrı/versioned bir evidence dosyasına yazılsın; yalnız bu yeni dosyaya referans veren yeni event append
  edilsin. `.superpowers/sdd/BOOTSTRAP/progress.md:19` aynı manifesti update etmek yerine bu versioned append
  modelini emretsin. Yeni evidence yeni event'in kendi hash'ini içermemeli; böylece digest graph acyclic
  kalır.

### INT-P1-002 — Event hash canonicalization sözleşmesi kayıtta tanımlı değil

- **Evidence:** `PLAN.md:33` yalnız “hash-chained” der; `phases/P01.md:8` canonical verifier/schema'yı
  gelecekte S01'e bırakır. D0 ledger satırlarında algorithm/canonicalization/version alanı yoktur
  (`progress/events.jsonl:1`). Evidence sonucu da çalıştırılabilir verifier yerine `node <<'NODE' (...)` özeti
  verir (`progress/evidence/D0-plan-materialization.json:95`). Bağımsız denemede hash'ler ancak `event_hash`
  çıkarıldıktan sonra object key'lerini recursive lexicographic sıralayıp compact UTF-8 JSON'un SHA-256'sını
  almakla eşleşti. Dosya byte'larını veya insertion-order `JSON.stringify` çıktısını hash'lemek dört satırda
  da farklı sonuç verdi.
- **Severity:** P1 correctness / interoperability.
- **Consequence:** Zincir bugün tahmin edilen serializer ile doğrulanabiliyor, fakat kayıt kendi doğrulama
  kuralını taşımıyor. İki bağımsız verifier özellikle gelecekte numeric/Unicode/object değerlerinde farklı
  canonical bytes seçebilir; “valid chain” sonucu out-of-band implementer bilgisine bağlı kalır.
- **Smallest fix:** D0 sözleşmesinde ve/veya event schema metadata'sında hash girdisini normatif tanımlayın:
  canonicalization standardı ve sürümü (ör. RFC 8785 veya tam eşdeğer tarif), UTF-8, `event_hash` exclusion,
  `previous_hash` inclusion ve SHA-256. Aynı normatif algoritmayla çalışan exact verifier command/script'i
  evidence'a kaydedin ve mevcut dört hash'i yeniden doğrulayın.

### INT-P1-003 — Evidence record “exact command” yerine çalıştırılamayan placeholder'lar taşıyor

- **Evidence:** Program sözleşmesi her proof record'ın exact command/workflow run taşımasını zorunlu kılar
  (`PLAN.md:44-47`). Manifestteki ana 88/72 ve hash kontrolleri `node <<'NODE' (...)`
  (`progress/evidence/D0-plan-materialization.json:90` ve `:95`), formatting kontrolü ise
  `prettier --check <design, PLAN, ...>` (`:100`) olarak kaydedilmiş. Bunlar shell'de tekrar
  çalıştırılabilecek exact komutlar değildir; heredoc program body'leri veya exact argv/file listesi
  manifestte ya da digest-bound bir artifact'ta yoktur.
- **Severity:** P1 evidence admissibility / explicit task-contract breach.
- **Consequence:** PASS metinleri bağımsız olarak aynı oracle ile tekrar üretilemez; verifier hangi title
  parser'ının, range expansion'ın, canonicalization'ın ve link kurallarının kullanıldığını kanıttan öğrenemez.
  Reviewer admission bu kayıt üzerinde deterministic oracle şartını karşılayamaz.
- **Smallest fix:** Kontrolleri küçük, tracked/digest-bound bir verifier script'ine taşıyıp exact command,
  script SHA ve exact argv'yi kaydedin veya tam heredoc byte'larını ayrı digest-bound artifact olarak
  saklayın. Prettier için gerçek dosya listesini/argv'yi kaydedin; placeholder'ları kaldırın.

### INT-P2-004 — `ARIA-AUDIT-015` owner set'i acceptance ve phase card ile tutarsız

- **Evidence:** `FINDING-COVERAGE.md:41` owner'ları `S27-S29, S50, S58, S66-S69` olarak genişletir, yani `S68`
  dahildir; aynı satırdaki acceptance listesinde `ACC-S68` yoktur. Ayrıca S68 kartının finding listesinde 015
  yoktur (`phases/P09.md:49`). Programmatic owner/acceptance expansion bütün 88 satırda yalnız bu mismatch'i
  buldu.
- **Severity:** P2 coverage integrity.
- **Consequence:** Machine-readable S38 mapping'i owner ile acceptance/card arasında tek anlamlı ilişki
  kuramaz; bir verifier ya eksik `ACC-S68` raporlar ya da S68'in gerçekte sahip olmadığı finding'i yürütmesini
  bekler.
- **Smallest fix:** Semantik olarak S68 outage/recovery sprint'i 015'i kapsamıyorsa owner ifadesini
  `S66-S67, S69` yapın. S68 gerçekten owner ise `ACC-S68` ve `phases/P09.md` S68 finding listesine 015'i
  birlikte ekleyin.

## Doğrulanan olumlu kontroller

- Frozen audit worktree HEAD'i exact `85787e610e26c192c898ffebd4e51ded856cd880`; kaynak raporda 88 heading
  vardır. Matrix 001..088 exact, gap/duplicate yok, severity/title'lar byte-for-byte eşleşiyor. P0 sayımı
  exact 24 = 20 confirmed + 3 partially confirmed + 1 refuted; 015/017/044 ve 026 açıklamaları task
  contract'ıyla uyumlu. 001/013/021/023/056/079/085 highlighted control'leri korunmuş.
- PLAN indeksinde exact S01..S72, dokuz phase card'da exact 72 unique sprint vardır.
- Event sırası ve transition'lar exact: genesis `null -> PLANNED -> READY -> IN_PROGRESS -> VERIFYING`; event
  ID/link continuity doğrudur. `DONE` event'i yoktur.
- Recursive sorted-key canonicalization ile dört event hash'i ve tail
  `360b085b1164314ffc062a8066bb9a9cab15ea169a6ad9c3e7a0e53175c1c2b1` yeniden üretildi.
- 12 authority file SHA-256 değeri ve path+NUL+digest+LF bundle digest'i
  `38ea8cd82baf3a1479d962c6a6142428c29e878f5799231325cbd11b2fbd6f08` yeniden üretildi. Manifest file SHA-256
  değeri event 4'teki evidence digest'le exact eşleşiyor. Mevcut digest graph acyclic: authority bundle
  manifest/events'i içermiyor; event manifesti hash'liyor; manifest yalnız event path'ini hash'siz
  referanslıyor.
- Evidence admission `accepted:false`, reviewer pending ve implementation commit reachability iddiası
  yapılmamış. Baseline `eeb401131...` güncel `origin/main` ancestor'ıdır; implementation commit `c6065d6da...`
  henüz değildir. Bu pending target binding mevcut haliyle false completion üretmiyor.
- Review package diff'i HEAD üzerinde reverse `git apply --check` ile temiz uygulanıyor. Committe 16 dosya
  vardır; protected legacy ARIA/workflow path diff'i boş, `git diff --check` temizdir.

## Çalıştırılan kontroller

- Root `CLAUDE.md`, adversarial/task brief, implementer report, review diff package ve tüm D0
  authority/progress/evidence/phase artifact'ları okundu; frozen full/supplemental audit kaynakları kontrol
  edildi.
- Node ile JSON/JSONL parse, recursive canonical event-hash/link recomputation, evidence/authority/ bundle
  digest recomputation, exact 001..088 source-title/severity/disposition ve exact S01..S72 index/card
  kontrolleri çalıştırıldı.
- Owner/acceptance range expansion ve simulated in-memory review-manifest mutation testi çalıştırıldı.
- `git merge-base --is-ancestor`, protected-path diff, `git diff --check`, commit/file roster ve
  review-package reverse-apply kontrolleri çalıştırıldı.
