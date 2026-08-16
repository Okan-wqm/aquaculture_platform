/**
 * Feeding v1 emekli-simge grep-zero kapısı (Faz 8, C-18).
 *
 * "Silerken yüzde yüz kullanılmadığına emin ol" direktifinin YAPISAL hali
 * (tier-3 make-it-detectable): Faz 8'de silinen her FE yüzeyinin simgeleri bu
 * listeye pinlenir ve repo'nun teslim edilebilir çalışma-ağacı .ts/.tsx
 * dosyalarında SIFIR referans zorunludur — yorumlar dahil (bayat yorum yeni
 * okuyucuyu silinmiş dosyaya yönlendirir). İndeksteki silinmiş dosyalar
 * teslim edilebilir kaynak değildir; henüz izlenmeyen yeni dosyalar ise kapıdan
 * kaçamaz. tsc yalnız import'ları görür; bu kapı string tabanlı referansları da
 * (derin linkler, ham GraphQL, doküman yolları) yakalar.
 *
 * Gelecek Faz 8 alt-PR'ları (BE motor silme, drop'lar, NATS FeedInventory*
 * temizliği) kendi emekli simgelerini BU listeye ekler — silme + pinleme
 * aynı commit'te gelir.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SPEC_PATH = 'tests/invariants/feeding-v1-retired-symbols.spec.ts';

/**
 * Emekli simgeler — Faz 8 #1/#2 (FE ölü kod + batch-create seçici).
 * Kelime sınırlı regex: 'useFeedingProtocols' v2 türevini ('...V2')
 * YAKALAMAZ; 'ProtocolsTab' da 'ProtocolBuilderTab' içinde eşleşmez.
 */
const RETIRED_PATTERNS: Array<{ symbol: string; pattern: RegExp }> = [
  { symbol: 'DailyPlanTab', pattern: /\bDailyPlanTab\b/ },
  { symbol: 'DailyFeedPlan', pattern: /\bDailyFeedPlan\b/ },
  { symbol: 'PlannedVsActualSection', pattern: /\bPlannedVsActualSection\b/ },
  { symbol: 'RecordFeedingModal', pattern: /\bRecordFeedingModal\b/ },
  { symbol: 'FeedingProgramForm', pattern: /\bFeedingProgramForm\b/ },
  { symbol: 'useDailyFeedingExecution', pattern: /\buseDailyFeedingExecution\b/ },
  { symbol: 'useFeedingProtocols (v1)', pattern: /\buseFeedingProtocols\b(?!V2)/ },
  { symbol: 'useFeedConsumptionForecast', pattern: /\buseFeedConsumptionForecast\b/ },
  { symbol: 'FEED_CONSUMPTION_FORECAST_QUERY', pattern: /\bFEED_CONSUMPTION_FORECAST_QUERY\b/ },
  { symbol: 'feedingProgram.queries', pattern: /feedingProgram\.queries/ },
  { symbol: 'feedingProgram.mutations', pattern: /feedingProgram\.mutations/ },
  { symbol: 'feedingProtocol.operations (v1)', pattern: /feedingProtocol\.operations/ },
  { symbol: 'tab=daily-plan deep link', pattern: /tab=daily-plan/ },
  { symbol: 'tab=execution deep link', pattern: /tab=execution\b/ },
  { symbol: 'tab=protocols deep link (v1)', pattern: /tab=protocols(?!-v2)\b/ },
];

/**
 * İstisnalar AÇIK listedir: generated istemciler (BE resolver'ları kendi
 * alt-PR'ında emekli olana dek meşru şema taşır) + bu spec'in kendisi.
 */
const EXEMPT_PATH_RE = /(^|\/)generated\//;

function sourceFilesInWorktree(): string[] {
  const candidates = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      'web/',
      'apps/',
      'libs/',
      'platform/',
      'e2e/',
      'tests/',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return [...new Set(candidates)]
    .sort()
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .filter((file) => existsSync(join(REPO_ROOT, file)))
    .filter((file) => file !== SPEC_PATH && !EXEMPT_PATH_RE.test(file));
}

describe('Feeding v1 emekli-simge grep-zero kapısı (Faz 8, C-18)', () => {
  const files = sourceFilesInWorktree();
  const offendersBySymbol = new Map<string, string[]>();

  beforeAll(() => {
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const { symbol, pattern } of RETIRED_PATTERNS) {
        if (pattern.test(source)) {
          const bucket = offendersBySymbol.get(symbol) ?? [];
          bucket.push(file);
          offendersBySymbol.set(symbol, bucket);
        }
      }
    }
  });

  it('emekli simgelere izlenen kaynakta SIFIR referans (yorumlar dahil)', () => {
    const report = [...offendersBySymbol.entries()]
      .map(([symbol, hits]) => `  ${symbol}:\n${hits.map((h) => `    - ${h}`).join('\n')}`)
      .join('\n');
    expect(
      offendersBySymbol.size === 0
        ? ''
        : `Emekli feeding v1 simgesine referans bulundu — silme eksik ya da bayat yorum:\n${report}`,
    ).toBe('');
  });

  it('kapı boş listeyle sessizce yeşile dönemez (liste silinirse fail)', () => {
    expect(RETIRED_PATTERNS.length).toBeGreaterThanOrEqual(15);
  });
});
