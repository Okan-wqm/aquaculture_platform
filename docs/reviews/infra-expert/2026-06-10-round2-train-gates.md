# Round-2 tren kapıları — banned-construct gate + diff-parser SSOT (2026-06-10)

Reviewer: infra-expert (Round-2 plan denetimi, mimari denetçi B1 + yürütme denetçisi B6 bulgularının uygulanması)
Scope: `tools/gates/banned-construct.ts`, `tools/gates/git-diff-ranges.ts`, `tools/gates/banned-phrase.ts`, `tools/gates/farm-service-enterprise-guardrails.ts`, `.husky/pre-commit`, `.github/workflows/quality-gates.yml`

## INFRA-MEDIUM-003 — Port diff'leri için mekanik yasak-yapı kapısı yok; -U0 diff parser'ı üç kopya

**Severity:** MEDIUM (önleyici altyapı — Round-2 port treni başlamadan kapanmalı)

**Gözlem (iki bacak):**
1. CLAUDE.md "Code Quality Standards" yapıları (`as any`, `as unknown as`, `@ts-ignore`,
   `@ts-expect-error`, `@ts-nocheck`, test `.skip(`/`xit(`, `eslint-disable`, çıplak
   `getRepository(`) için satır-düzeyi mekanik kapı yoktu. ESLint bir kısmını yakalar AMA
   `.eslintrc` spec/test/e2e dosyalarında `no-explicit-any`'yi KAPATIR — spec dosyasına
   saklanan yasak cast lint'ten VE inceleme yorgunluğundan geçer. Round-2 portlarında eski
   dallardan taşınacak kod için bu boşluk somut risk (plan denetçisi B1).
2. `-U0` added-line diff parser'ı ÜÇ özel kopya halindeydi: banned-phrase.ts
   (Set<number> varyantı), farm-service-enterprise-guardrails.ts (AddedLine varyantı) ve
   yeni kapı dördüncüyü ekleyecekti. Kopyalar uyuşmazsa kapılar "bu PR hangi satırları
   ekledi" sorusuna farklı cevap verir; bir hunk-header edge-case'i tek kopyada düzelir.

**Fix (bu PR):**
- `tools/gates/git-diff-ranges.ts`: tek parser (AddedLine modeli) + range/staged
  toplayıcılar + per-file gruplayıcı; üç kapı da bunu tüketir. banned-phrase range modu
  artık dosya-başına git çağrısı yerine tüm-range tek diff.
- `tools/gates/banned-construct.ts` (+spec, 7 test): ADDED-lines-only tarama, spec
  dosyaları DAHİL; `getRepository(` için iki kapsamlı muafiyet (libs/backend-common —
  scoping SSOT implementasyonu; platform/libs/testing — mock fabrikaları). Hook (staged)
  + quality-gates.yml (range) bağlandı. `?.` artışı ve JSON-kolon kaçışı bilinçli olarak
  insan-incelemesinde bırakıldı (regex false-positive yoğunluğu mekanik kapılara güveni
  eritir — araç başlığında gerekçesi).
- Hermetik fixture disiplini: git-reachability.spec'in tmpdir repo'su hook env'inden
  GIT_DIR/GIT_INDEX_FILE miras alıp gerçek repoya yönelmişti (staged dosyalar sahte
  commit'e yutuldu, paylaşılan origin/main tracking ref'i yeniden yazıldı — push yok, tam
  lokal kurtarma). Spec artık tüm GIT_* env'ini soyar; git-reachability.ts repo-location
  değişkenlerini soyar. Sızdırılmış-env senaryosu ampirik test edildi: ref/HEAD/index
  değişmiyor.

**Tier:** 1/3 karması — şerit kapıları (pre-commit + CI range) yeni yasak yapıyı build
zamanında yakalar; parser SSOT'u kopya-uyuşmazlığını yapısal imkânsız kılar.
