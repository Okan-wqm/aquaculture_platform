# Messaging FAZ Ölçüm Prosedürü

Bu dizin, aqua-saas mesajlaşma düzeltme programının **faz kabul ölçümlerinin**
tek doğruluk kaynağıdır. Bir faz "bitti" denmeden önce aşağıdaki kabul
kriterleri burada tanımlanan prosedürle ölçülür ve kanıtlar
`e2e/messaging/results/` altına arşivlenir.

Dosyalar:

| Dosya | Rol |
| --- | --- |
| `measurements.ts` | Ölçüm yardımcı kütüphanesi (latency, GraphQL sayaç, bleed, hata kodu sözleşmesi) |
| `messaging-measure.spec.ts` | Örnek ölçüm senaryosu — **iskelet**, fazlar doldurur (`@messaging-measure` tag'li) |
| `results/` | Kanıt arşivi (git-ignore'lu; runtime'da oluşur) |
| `../playwright.messaging.config.ts` | Lane konfigürasyonu (yalnızca `--config` ile seçildiğinde çalışır) |

> Bu spec mevcut hiçbir playwright config'inin `testDir`'i içinde DEĞİLDİR
> (`e2e/tests/` dışında yaşar) ve `MESSAGING_E2E_BASE_URL` env'i yoksa
> otomatik skip eder — default test filtrelerinde asla koşmaz.

---

## Kabul kriterleri (faz çıkış kapıları)

| # | Kriter | Ölçüm | Başlangıç eşiği |
| --- | --- | --- | --- |
| K1 | Mesaj gönderim → DOM'da görünme gecikmesi | `measureSendToVisibleSeries` (20 tekrar, tarayıcı `performance.now()` saati) | **p95 ≤ 1500 ms** |
| K2 | Kanal geçişi başına GraphQL istek sayısı (amplifikasyon) | `countGraphqlRequests` snapshot deltası | geçiş başına **≤ 2 messaging operasyonu**; `unparsed = 0` (FAZ-2'de netleşir) |
| K3 | Kanal geçişinde bleed | `assertNoBleed` (önceki kanal metni 0 eşleşme + screenshot kanıtı) | **0 piksel** — önceki kanalın hiçbir mesajı/metni kalmaz |
| K4 | Negatif yol hata kodu sözleşmesi | `expectGraphqlErrorCode` | `NOT_FOUND` / `UNAUTHENTICATED` / `FORBIDDEN` / `TOO_MANY_REQUESTS` — kod seti gateway `global-exception.filter` SSoT'su |

Eşikler koddaki varsayılanlarla (`assertP95WithinBudget(summary, 1500)` vb.)
uyumlu olmalı; bir faz eşiği sıkılaştırırsa önce bu tabloyu, sonra koddaki
varsayılanı güncelle.

---

## Çalıştırma prosedürü

### 0) Rate-limit uyarısı — ÖNCE OKU

Login endpoint'i **5 deneme / 15 dakika** rate-limit'lidir. Bu şerit
testlerinin her biri kendi login'ini yaparsa limit bir koşuda tükenir ve
sonraki 15 dakika tüm ekipleri bloklar. Bu yüzden:

- Testler login YAPMAZ; oturum **tek seferde** hazırlanmış bir
  `storageState` dosyasından okunur.
- storageState'yi YENİDEN üretmek gerekiyorsa gün içinde en fazla bir kez,
  bilinçli olarak yapılır (aşağıdaki auth.setup deseni).
- Faz ölçüm koşuları storageState'i paylaşır; her spec ayrı login açmaz.

### 1) Ortam değişkenleri

| Env | Anlam | Örnek |
| --- | --- | --- |
| `MESSAGING_E2E_BASE_URL` | Panelin canlı kök URL'si. **Boşsa tüm spec skip eder.** | `https://localhost:8443/messaging` |
| `MESSAGING_E2E_STORAGE_STATE` | Paylaşılan oturum dosyası (auth.setup çıktısı). Base URL varken bu boşsa yine skip edilir. | `../tmp/messaging-e2e-state.json` |

### 2) 8443 self-signed sertifikası

Panel, gateway'in 8443 portundaki **self-signed** sertifikasıyla servis
edilir. Spec dosya seviyesinde şunu ayarlar; yeni eklenecek config'ler de
aynısını içermelidir:

```ts
test.use({ ignoreHTTPSErrors: true });
```

(Config seviyesinde tercih edilirse: `use: { ignoreHTTPSErrors: true }`.)

### 3) storageState hazırlığı — auth.setup deseni (ÇALIŞTIRMA!)

Aşağıdaki desen FAZ ekibinin storageState'i üretmesi içindir. **Kopyala,
`e2e/messaging/auth.setup.ts` olarak kaydet, yalnızca bilinçli olarak ve
günde bir kez çalıştır.** Hiçbir config'e `dependencies` olarak
bağlanmamalı — yanlışlıkla her koşuda login olmasın.

```ts
// e2e/messaging/auth.setup.ts — İSKELET, otomatik hiçbir şeye bağlı değildir.
import { test as setup, expect } from '@playwright/test';

const STATE_PATH = process.env['MESSAGING_E2E_STATE_PATH'] ?? 'tmp/messaging-e2e-state.json';

setup('prepare messaging e2e storage state (login budget: 1)', async ({ page }) => {
  const baseUrl = process.env['MESSAGING_E2E_BASE_URL'];
  setup.skip(!baseUrl, 'MESSAGING_E2E_BASE_URL yok — storageState üretimi opt-in');

  await page.goto(baseUrl);
  // TODO(FAZ-1): gerçek login formu seçicileriyle doldur (tek deneme!
  //       yanlış credential = 5/15dk limitinden 1 hak gider).
  await page.getByLabel('Email').fill(process.env['MESSAGING_E2E_USER_EMAIL'] ?? '');
  await page.getByLabel('Password').fill(process.env['MESSAGING_E2E_USER_PASSWORD'] ?? '');
  await page.getByRole('button', { name: /sign in|log in/i }).click();

  await expect(page).toHaveURL(/messaging|dashboard/); // oturum açıldığının kanıtı
  await page.context().storageState({ path: STATE_PATH });
});
```

Üretim komutu (bilinçli, günede bir):

```bash
cd e2e
MESSAGING_E2E_BASE_URL=https://localhost:8443 \
MESSAGING_E2E_STATE_PATH=../tmp/messaging-e2e-state.json \
MESSAGING_E2E_USER_EMAIL=... MESSAGING_E2E_USER_PASSWORD=... \
npx playwright test messaging/auth.setup.ts
```

### 4) Ölçüm koşusu

```bash
cd e2e
MESSAGING_E2E_BASE_URL=https://localhost:8443/messaging \
MESSAGING_E2E_STORAGE_STATE=../tmp/messaging-e2e-state.json \
npx playwright test --config playwright.messaging.config.ts --grep @messaging-measure
```

- Lane konfigürasyonu: `e2e/playwright.messaging.config.ts` (aquamobil/
  water-chemistry per-lane deseni; `testDir: './messaging'`, `workers: 1`,
  `retries: 0` — retry'lı ölçüm geçersiz veridir, tekrar koşulur).
- `--workers=1` config'te sabit: seri ölçüm, paralel sekme gecikmeyi böler.
- Bu config yalnızca `--config` ile açıkça seçildiğinde çalışır; e2e'nin
  varsayılan `playwright.config.ts`'i (`testDir: './tests'`) ve diğer lane
  config'leri `e2e/messaging/` altını TOPLAMAZ (Jest'in `testMatch`'i de
  `<rootDir>/tests/**` ile sınırlıdır) — ölçüm spec'leri default filtrelerde
  koşmaz.

---

## Ölçüm yardımcıları (`measurements.ts`)

- **`measureSendToVisible(page, sendFn, repetition)`** — tek ölçüm:
  tarayıcı saatinde başlangıç mark'ı → `sendFn` (mesajı gönderip hedef
  locator'ı döner) → mesaj görünür → bitiş mark'ı. Her tekrar BENZERSİZ
  metin göndermelidir (önceki mesajın görünürlüğü yanlış 0ms ölçer).
- **`measureSendToVisibleSeries(page, sendFn, { repetitions: 20 })`** —
  seri sarmalayıcı: medyan + p95 (`LatencySummary`).
- **`assertP95WithinBudget(summary, 1500)`** — K1 kabul kapısı.
- **`countGraphqlRequests(page)`** — `page.on('request')` üzerinden `/graphql`
  POST'larını sayar, gövdeden `operationName` çözer (explicit alan → yoksa
  query dokümanındaki ilk isimli operasyon). `snapshot()`: `total`,
  `operations` (isim→adet), `messaging` (ismi `/messag/i` ile eşleşenler),
  `unparsed`. Amplifikasyon deseni: sayaç başlat → TEK kullanıcı aksiyonu →
  snapshot farkı.
- **`assertNoBleed(page, channelTitle, { previousMessageText, headerLocator,
  evidenceName })`** — önceki kanalın örnek mesaj metninin sayfada 0 eşleşme
  olduğunu assert eder, room header'ında eski başlık kalmadığını kontrol
  eder ve tam sayfa screenshot kanıtı bırakır.
- **`expectGraphqlErrorCode(result, code)`** — `errors[0].extensions.code`
  sözleşme assert'i; sözleşme dışı kod gürültülü hata verir.
  `readGraphQLErrorCode` sessiz okuyucudur.
- **`saveMeasurementEvidence(name, content)`** / `MESSAGING_RESULTS_DIR` —
  kanıt arşivine yazar.

---

## Kanıt arşivi (`e2e/messaging/results/`)

Git-ignore'lu; her koşu buraya yazar:

- `send-to-visible-<ts>.json` — K1 numune serisi (median/p95/min/max/samples)
- `channel-switch-requests-<ts>.json` — K2 sayaç snapshot'ı (operations dökümü)
- `no-bleed-*.png` / `bleed-check-*.png` — K3 tam sayfa screenshot kanıtı
- `send-to-visible-*.json` (trace ekleri FAZ-1'de `--trace on` ile eklenir)

Faz kabul raporunda bu dosyaların listesi + ölçülen değerler tablosu yer
alır; kanıt dosyaları arşive (görev çıktısı) eklenir, repoya commit edilmez.
