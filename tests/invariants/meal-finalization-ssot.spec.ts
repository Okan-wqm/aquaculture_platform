/**
 * INVARIANT: "öğünü kapat" davranışının farm-service'te TEK gövdesi vardır.
 *
 * ## Neden bir kapı, yorum değil
 *
 * Bir öğün iki yoldan kapanır: operatör kapatır (`recordMealFeeding(finalize)`
 * / `finalizeMeal`) ya da pencere kapanır (05:30 süpürmesi bayat
 * `partially_fed` öğünleri otomatik finalize eder). Bu iki yolun aynı varyansı,
 * aynı per_meal büyümeyi, aynı kalan-öğün recalc'ını ve aynı az-atım eşiğini
 * uygulaması ZORUNLUDUR.
 *
 * Uzun süre bunu iki ayrı kod gövdesi yapıyordu ve aynı kalacaklarının tek
 * güvencesi kopyanın yanına yazılmış "SİMETRİ" yorumlarıydı. Bir yorum bunu
 * garanti etmez — etmemişti de:
 *
 *  - plan-durumu yazımının kanonik kopyası `dayPlan.status !== nextStatus`
 *    koruması taşırken süpürme kopyası her turda KOŞULSUZ UPDATE atıyordu;
 *  - az-atım eşiğinin `?? 15` varsayılanı iki ayrı ifadede yazılıydı, biri
 *    değişse diğeri sessizce eski eşikte kalırdı;
 *  - süpürme kopyası öğün başına `new Date()` çağırıyor, saat SSoT'sinden
 *    (tick'in anı) sapıyordu.
 *
 * Operatör açısından bunun anlamı şuydu: sistematik az-atım YALNIZ elle
 * kapatılan öğünlerde görünür, pencere kapanışında kapanan öğünde görünmezdi —
 * yani tam da en çok ilgilenilmesi gereken öğünlerde (FARM-MEDIUM-276).
 *
 * Kural bu yüzden yapısaldır: kapatma kararını veren üç işaret tek dosyada
 * yaşar; ikinci bir yazar derlemeyi değil, bu kapıyı kırar.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Öğün kapatmanın tek gövdesi. */
const SSOT = 'apps/farm-service/src/feeding-protocol/services/meal-finalization.service.ts';

interface Rule {
  readonly id: string;
  /** Ne aranıyor (satır bazında). */
  readonly matches: (line: string) => boolean;
  /** Kapı kırılınca yazılacak gerekçe. */
  readonly why: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'meal-fed-transition',
    // ATAMA aranır; `!== FeedingMealStatus.FED` gibi OKUMALAR meşrudur.
    matches: (line) => /(?<![=!<>])=(?!=)\s*FeedingMealStatus\.FED\b/.test(line),
    why:
      'öğünü FED durumuna geçiren tek yer MealFinalizationService.finalize olmalı — ' +
      'ikinci bir geçiş varyansı/büyümeyi/az-atım sinyalini atlayabilir',
  },
  {
    id: 'meal-scope-underfed',
    // Gün kapsamı (`scope: 'day'`, 20:00 özeti) AYRI bir sinyaldir ve serbesttir.
    matches: (line) => /scope:\s*'meal'/.test(line),
    why:
      "MealUnderfed(scope:'meal') tek yerden yayılmalı — ikinci bir yayıcı kendi " +
      'eşik varsayılanını taşır ve eşik değişince sessizce eskisinde kalır',
  },
  {
    id: 'day-plan-settle',
    /**
     * `COMPLETED` / `IN_PROGRESS`'i DEĞER olarak kullanan tek yer settle
     * kararıdır. İki meşru başka kullanım şekli var ve ikisi de yazma değil:
     * karşılaştırma (`=== COMPLETED`, 20:00 özetinin sayaçları) ve okuma
     * filtresi (`statuses: [...]`, "hangi planlar açık" sorgusu). Diğer
     * statülerin (PLANNED/SKIPPED/CANCELLED) başka meşru yazarları var, o
     * yüzden kural yalnız bu ikisini kapsar.
     *
     * Not: karar iki satıra bölünmüş bir ternary olduğu için `= ...` ataması
     * aranmaz — ilk hâli bunu arıyordu ve kural HİÇBİR ŞEYLE eşleşmez hâle
     * gelmişti; aşağıdaki vacuity testi tam olarak onu yakaladı.
     */
    matches: (line) =>
      /FeedingDayPlanStatus\.(COMPLETED|IN_PROGRESS)\b/.test(line) &&
      !/[=!]==\s*FeedingDayPlanStatus\./.test(line) &&
      !/statuses\s*:/.test(line),
    why:
      'planı COMPLETED/IN_PROGRESS yapan karar tek yerde (settleDayPlanStatus) olmalı — ' +
      'kopyası koşulsuz UPDATE atıyor ve aynı tx içindeki recalc yazımlarıyla yarışıyordu',
  },
];

function farmServiceSources(): string[] {
  return (
    execFileSync('git', ['ls-files', 'apps/farm-service/**/*.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // Spec'ler kendi fixture'larında bu değerleri kurabilir; kapı ÜRETİM
      // kodunun ikinci bir yazar edinmesine bakar.
      .filter((file) => !file.endsWith('.spec.ts'))
  );
}

describe('INVARIANT: meal finalization SSoT', () => {
  const files = farmServiceSources();

  it('scans a real corpus (a broken glob must not fake a pass)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain(SSOT);
  });

  it.each(RULES.map((rule) => [rule.id, rule] as const))(
    'keeps %s in the single finalization body',
    (_id, rule) => {
      const offenders: string[] = [];
      for (const file of files) {
        if (file === SSOT) continue;
        readFileSync(join(REPO_ROOT, file), 'utf8')
          .split('\n')
          .forEach((line, index) => {
            if (rule.matches(line)) {
              offenders.push(`${file}:${index + 1} — ${rule.why} (SSoT: ${SSOT})`);
            }
          });
      }
      expect(offenders).toEqual([]);
    },
  );

  it('the SSoT actually carries every guarded construct (rules cannot go vacuous)', () => {
    // Kural bir yeniden adlandırmadan sonra hiçbir şeyle eşleşmez hâle gelirse
    // yukarıdaki testler sessizce yeşil kalırdı. Burası bunu imkânsız kılar.
    const source = readFileSync(join(REPO_ROOT, SSOT), 'utf8').split('\n');
    const unmatched = RULES.filter((rule) => !source.some((line) => rule.matches(line))).map(
      (rule) => `${rule.id} matches nothing in the SSoT — the rule stopped guarding anything`,
    );
    expect(unmatched).toEqual([]);
  });
});
