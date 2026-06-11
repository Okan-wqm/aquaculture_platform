# invariants-fast: entity-diff-witness waiver kanalı asimetrisi (2026-06-11)

## INFRA-HIGH-010 — Waiver kanalı gate'in yürütücüleri arasında tek tip değil

**Severity:** HIGH · **Owner:** infra-expert · **Cycle:** 2026-06-11-production-opening

### Gözlem

`entity-diff-witness` gate'inin İKİ yürütücüsü var:

1. **Dedicated job** — `.github/workflows/db-migration-check.yml` `entity-diff-witness`
   job'ı `PR_BODY: ${{ github.event.pull_request.body }}` export eder; gate'in
   `ENTITY-DIFF-OK: <service> — <reason>` PR-gövde waiver'ı çalışır
   (`tools/gates/entity-diff-witness.ts:157-169`, `readWaiveredServices()` →
   `process.env.PR_BODY`).
2. **Invariant spec üzerinden N dolaylı yürütücü** —
   `tests/invariants/entity-diff-implies-migration.spec.ts:88` aynı gate'i
   `execSync('npm run gates:entity-diff-witness -- --diff-base ...')` ile
   yeniden koşuyordu; child process env'i miras alır AMA spec'i koşan HİÇBİR
   workflow (`quality-gates.yml` `invariants-fast` job'ı + `nx affected
   --target=test` shard'ı) `PR_BODY` export etmiyordu.

**Sonuç:** sanctioned waiver taşıyan her PR (örnek: PR #393 — decorator-only
`@Field` tip-thunk düzeltmesi, DDL etkisi sıfır) `entity-diff-witness`
job'ında yeşil; `invariants-fast` VE `test` job'larında yapısal olarak
kırmızı. Bir gate, üç yürütücü, çatallanmış hüküm — gate yürütümü SSOT değil.

### Kök neden

Waiver semantiği gate'in İÇİNDE tanımlı (PR_BODY okuması) ama kanalın
beslenmesi her yürütücünün workflow tanımına bırakılmış. Yürütücü eklenirken
(invariants-fast'ın A.4 cold-audit terfisi) kanal kopyalanmamış.

### Düzeltme (bu PR) — yürütücü-SSOT

İlk değerlendirilen yol (env'i `invariants-fast`'a kopyalamak) REDDEDİLDİ:
`nx affected --target=test` shard'ı da aynı spec'i koşuyor (PR #393'te
`test` job'ı aynı kökten kırmızı) — kanal kopyalama yürütücü başına tekrar
eder, sınıf açık kalır.

Uygulanan çözüm:

1. **Gate-koşusu TEK yürütücüde:** spec'teki mükerrer subprocess koşusu
   (`gate passes against PR base ...` + `it.skip` else-dalı) kaldırıldı.
   Gate'in tek yürütücüsü `db-migration-check.yml`'deki dedicated job —
   env sözleşmesinin (PR_BODY + BASE_SHA) sahibi ve path-filtresi gate'in
   yargıladığı dosya sınıfının (entity + migration) birebir kendisi;
   o dosyalar değişmeyen PR'da gate zaten boş-geçer (kapsama kaybı yok).
2. **Meta-invariant:** spec artık yapısal olarak şunu doğruluyor —
   `gates:entity-diff-witness` çağıran HER workflow adımı
   `PR_BODY: ${{ github.event.pull_request.body }}` ve
   `BASE_SHA: ${{ github.event.pull_request.base.sha }}` export eder VE
   dedicated job var olmaya devam eder (tek yürütücüyü kaybetmek
   invariant'ı sessizce silahsızlandırırdı).

### Tier sınıfı

Tier-1 (make it impossible): asimetri sınıfı yapısal olarak kapandı —
verdict-forking yürütücü eklemek meta-invariant'ı kırar; kanal kopyalama
ihtiyacı tümüyle ortadan kalktı. Gate'in gövdeyi GitHub API'den kendisinin
çekmesi de değerlendirildi; hermetik CLI sözleşmesini bozar — reddedildi.

### Kanıt

- `tools/gates/entity-diff-witness.ts:160` — `process.env.PR_BODY ?? ''`
- `.github/workflows/db-migration-check.yml:503` — dedicated job PR_BODY export
- `.github/workflows/quality-gates.yml:194` — invariants-fast adımı (düzeltme öncesi env'siz)
- PR #393 head `a147bb12d` koşusu: `entity-diff-witness` fail + `invariants-fast` fail,
  aynı kökten (run 27358987656 / 27358988293)
